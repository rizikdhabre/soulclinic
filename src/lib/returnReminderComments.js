import { normalizeIsraeliPhone } from "@/lib/phone";

const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const MAX_COMMENTS = 100;
const MAX_TEXT_LENGTH = 10_000;
const projection = { adminComments: 1, commentsVersion: 1, deletedCommentIds: 1 };
const writeConcern = { w: "majority", j: true, wtimeoutMS: 10_000 };
const writeOptions = { returnDocument: "after", projection, writeConcern };
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const validRevision = value => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const validText = value => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;

function iso(value) {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function projectComments(record) {
  const seen = new Set();
  const comments = (Array.isArray(record?.adminComments) ? record.adminComments : []).filter(comment => {
    if (!comment || typeof comment._id !== "string" || !UUID.test(comment._id) || !validText(comment.text) || !validRevision(comment.revision)) return false;
    const id = comment._id.toLowerCase();
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(comment => ({
    _id: comment._id.toLowerCase(), text: comment.text, revision: comment.revision,
    createdAt: iso(comment.createdAt), updatedAt: iso(comment.updatedAt),
  }));
  return { comments, commentsVersion: Number.isSafeInteger(record?.commentsVersion) && record.commentsVersion >= 0 ? record.commentsVersion : 0 };
}

function identity(phone) {
  const key = typeof phone === "string" ? normalizeIsraeliPhone(phone) : null;
  if (!key) throw failure(400, "INVALID_PHONE");
  return { _id: key };
}

function requireCommentId(commentId) {
  if (typeof commentId !== "string" || !UUID.test(commentId)) throw failure(400, "INVALID_COMMENT_ID");
  return commentId.toLowerCase();
}

function requireText(text) {
  if (!validText(text)) throw failure(400, "INVALID_COMMENT_TEXT");
}

function requireRevision(revision) {
  if (!validRevision(revision)) throw failure(400, "INVALID_COMMENT_REVISION");
}

function timestamp(deps) {
  const now = typeof deps.now === "function" ? deps.now() : deps.now ?? new Date();
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw failure(500, "COMMENTS_UNAVAILABLE");
  return now;
}

async function collection(deps) {
  if (deps.db) return deps.db.collection("returnReminderSettings");
  const getCollection = deps.getCollection || (await import("@/lib/db")).getCollection;
  return getCollection("returnReminderSettings");
}

const read = (settings, filter) => settings.findOne(filter, { projection, readConcern: { level: "majority" } });

export async function getReturnReminderComments({ phone }, deps = {}) {
  const filter = identity(phone);
  return projectComments(await read(await collection(deps), filter));
}

export async function addReturnReminderComment(input, deps = {}) {
  const filter = identity(input.phone);
  const commentId = requireCommentId(input.commentId);
  requireText(input.text);
  const now = timestamp(deps);
  const settings = await collection(deps);
  // Create only the phone container. Schedule and consent retain their own defaults.
  try {
    await settings.updateOne(filter, { $setOnInsert: { createdAt: now } }, { upsert: true, writeConcern });
  } catch (error) {
    if (error?.code !== 11000) throw error;
  }
  const updated = await settings.findOneAndUpdate({
    ...filter, "adminComments._id": { $ne: commentId }, deletedCommentIds: { $ne: commentId },
    $expr: { $lt: [{ $size: { $ifNull: ["$adminComments", []] } }, MAX_COMMENTS] },
  }, {
    $push: { adminComments: { _id: commentId, text: input.text, revision: 1, createdAt: now, updatedAt: now } },
    $inc: { commentsVersion: 1 },
  }, writeOptions);
  if (updated) return projectComments(updated);
  const current = await read(settings, filter);
  if (current?.deletedCommentIds?.includes(commentId)) throw failure(409, "COMMENT_ID_REUSED");
  const existing = current?.adminComments?.find(comment => comment._id === commentId);
  if (existing) {
    if (existing.text !== input.text) throw failure(409, "COMMENT_ID_REUSED");
    return projectComments(current);
  }
  if (current?.adminComments?.length >= MAX_COMMENTS) throw failure(409, "COMMENT_LIMIT_REACHED");
  throw failure(409, "COMMENT_CONFLICT");
}

async function failedRevisionWrite(settings, filter, commentId, remove = false) {
  const current = await read(settings, filter);
  if (remove && current?.deletedCommentIds?.includes(commentId)) return projectComments(current);
  if (!Array.isArray(current?.adminComments) || !current.adminComments.some(comment => comment._id === commentId)) throw failure(404, "COMMENT_NOT_FOUND");
  throw failure(409, "COMMENT_CONFLICT");
}

export async function updateReturnReminderComment(input, deps = {}) {
  const filter = identity(input.phone);
  const commentId = requireCommentId(input.commentId);
  requireText(input.text);
  requireRevision(input.revision);
  const now = timestamp(deps);
  const settings = await collection(deps);
  const updated = await settings.findOneAndUpdate({ ...filter, adminComments: { $elemMatch: { _id: commentId, revision: input.revision } } }, {
    $set: { "adminComments.$.text": input.text, "adminComments.$.updatedAt": now },
    $inc: { "adminComments.$.revision": 1, commentsVersion: 1 },
  }, writeOptions);
  if (updated) return projectComments(updated);
  return failedRevisionWrite(settings, filter, commentId);
}

export async function deleteReturnReminderComment(input, deps = {}) {
  const filter = identity(input.phone);
  const commentId = requireCommentId(input.commentId);
  requireRevision(input.revision);
  const settings = await collection(deps);
  const updated = await settings.findOneAndUpdate({ ...filter, adminComments: { $elemMatch: { _id: commentId, revision: input.revision } } }, {
    $pull: { adminComments: { _id: commentId, revision: input.revision } },
    $addToSet: { deletedCommentIds: commentId }, $inc: { commentsVersion: 1 },
  }, writeOptions);
  if (updated) return projectComments(updated);
  return failedRevisionWrite(settings, filter, commentId, true);
}

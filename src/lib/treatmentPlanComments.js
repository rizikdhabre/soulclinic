import { ObjectId } from "mongodb";

const OBJECT_ID = /^[a-f\d]{24}$/i;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i;
const MAX_COMMENTS = 100;
const MAX_TEXT_LENGTH = 10_000;
const projection = { adminComments: 1, commentsVersion: 1, deletedCommentIds: 1 };
const writeOptions = { returnDocument: "after", projection, writeConcern: { w: "majority", wtimeoutMS: 10_000 } };
const failure = (status, code) => Object.assign(new Error(code), { status, code });
const validRevision = (value) => Number.isSafeInteger(value) && value > 0 && value < Number.MAX_SAFE_INTEGER;
const validText = (value) => typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT_LENGTH;

function iso(value) {
  const date = value instanceof Date ? value : typeof value === "string" ? new Date(value) : null;
  return date && Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function projectTreatmentPlanComments(plan) {
  const seen = new Set();
  const comments = (Array.isArray(plan?.adminComments) ? plan.adminComments : []).filter((comment) => {
    if (!comment || typeof comment._id !== "string" || !UUID.test(comment._id) || !validText(comment.text) || !validRevision(comment.revision)) return false;
    const commentId = comment._id.toLowerCase();
    if (seen.has(commentId)) return false;
    seen.add(commentId);
    return true;
  }).map((comment) => ({
    _id: comment._id.toLowerCase(), text: comment.text, revision: comment.revision,
    createdAt: iso(comment.createdAt), updatedAt: iso(comment.updatedAt),
  }));
  return { comments, commentsVersion: Number.isSafeInteger(plan?.commentsVersion) && plan.commentsVersion >= 0 ? plan.commentsVersion : 0 };
}

function identity({ userId, planId }, commentId) {
  if (typeof userId !== "string" || !OBJECT_ID.test(userId)) throw failure(400, "INVALID_USER_ID");
  if (typeof planId !== "string" || !OBJECT_ID.test(planId)) throw failure(400, "INVALID_PLAN_ID");
  if (commentId !== undefined && (typeof commentId !== "string" || !UUID.test(commentId))) throw failure(400, "INVALID_COMMENT_ID");
  return { _id: new ObjectId(planId), userId: new ObjectId(userId) };
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
  return deps.db ? deps.db.collection("treatmentPlans") : (await import("@/lib/db")).getCollection("treatmentPlans");
}

async function readPlan(plans, filter) {
  const plan = await plans.findOne(filter, { projection, readConcern: { level: "majority" } });
  if (!plan) throw failure(404, "PLAN_NOT_FOUND");
  return plan;
}

const success = (plan) => ({ success: true, ...projectTreatmentPlanComments(plan) });

export async function getTreatmentPlanComments(input, deps = {}) {
  const filter = identity(input);
  return projectTreatmentPlanComments(await readPlan(await collection(deps), filter));
}

export async function addTreatmentPlanComment(input, deps = {}) {
  const filter = identity(input, input.commentId);
  const commentId = requireCommentId(input.commentId);
  requireText(input.text);
  const now = timestamp(deps);
  const plans = await collection(deps);
  // The uniqueness and capacity predicates are part of the same atomic write.
  // Never upsert: deleting the parent must also end comment writes to it.
  const updated = await plans.findOneAndUpdate({
    ...filter, "adminComments._id": { $ne: commentId }, deletedCommentIds: { $ne: commentId },
    $expr: { $lt: [{ $size: { $ifNull: ["$adminComments", []] } }, MAX_COMMENTS] },
  }, {
    $push: { adminComments: { _id: commentId, text: input.text, revision: 1, createdAt: now, updatedAt: now } },
    $inc: { commentsVersion: 1 },
  }, writeOptions);
  if (updated) return success(updated);
  const current = await readPlan(plans, filter);
  if (Array.isArray(current.deletedCommentIds) && current.deletedCommentIds.includes(commentId)) throw failure(409, "COMMENT_ID_REUSED");
  const existing = current.adminComments?.find((comment) => comment._id === commentId);
  if (existing) {
    if (existing.text !== input.text) throw failure(409, "COMMENT_ID_REUSED");
    return success(current);
  }
  if (current.adminComments?.length >= MAX_COMMENTS) throw failure(409, "COMMENT_LIMIT_REACHED");
  throw failure(409, "COMMENT_CONFLICT");
}

async function failedRevisionWrite(plans, filter, commentId) {
  const current = await readPlan(plans, filter);
  if (!Array.isArray(current.adminComments) || !current.adminComments.some((comment) => comment._id === commentId)) throw failure(404, "COMMENT_NOT_FOUND");
  throw failure(409, "COMMENT_CONFLICT");
}

export async function updateTreatmentPlanComment(input, deps = {}) {
  const filter = identity(input, input.commentId);
  const commentId = requireCommentId(input.commentId);
  requireText(input.text);
  requireRevision(input.revision);
  const now = timestamp(deps);
  const plans = await collection(deps);
  const updated = await plans.findOneAndUpdate({ ...filter, adminComments: { $elemMatch: { _id: commentId, revision: input.revision } } }, {
    $set: { "adminComments.$.text": input.text, "adminComments.$.updatedAt": now },
    $inc: { "adminComments.$.revision": 1, commentsVersion: 1 },
  }, writeOptions);
  if (updated) return success(updated);
  return failedRevisionWrite(plans, filter, commentId);
}

export async function deleteTreatmentPlanComment(input, deps = {}) {
  const filter = identity(input, input.commentId);
  const commentId = requireCommentId(input.commentId);
  requireRevision(input.revision);
  const plans = await collection(deps);
  const updated = await plans.findOneAndUpdate({ ...filter, adminComments: { $elemMatch: { _id: commentId, revision: input.revision } } }, {
    // Remember only the UUID in the same parent write so an old add retry cannot
    // revive the deleted comment or reset its revision. Parent deletion removes it.
    $pull: { adminComments: { _id: commentId, revision: input.revision } },
    $addToSet: { deletedCommentIds: commentId }, $inc: { commentsVersion: 1 },
  }, writeOptions);
  if (updated) return success(updated);
  return failedRevisionWrite(plans, filter, commentId);
}

import { ObjectId } from "mongodb";

const WRITE = { writeConcern: { w: "majority", wtimeoutMS: 10_000 } };
const MAX_ATTEMPTS = 5;

export class TreatmentOrderError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}

function validateOrder(order) {
  if (!Array.isArray(order) || order.length > 2000 || order.some(id => typeof id !== "string" || !id || id.length > 128) || new Set(order).size !== order.length) {
    throw new TreatmentOrderError("Invalid order");
  }
}

function validateRequest(request) {
  if (request == null) return;
  if (typeof request.clientId !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(request.clientId) || !Number.isSafeInteger(request.sequence) || request.sequence < 1) {
    throw new TreatmentOrderError("Invalid ordering request");
  }
}

async function collection(name, deps) {
  return (deps.getCollection || (await import("@/lib/db")).getCollection)(name);
}

export function applyTreatmentOrder(records, order = []) {
  const remaining = new Map(records.map(record => [String(record._id), record]));
  const ordered = [];
  for (const id of order) {
    if (remaining.has(id)) { ordered.push(remaining.get(id)); remaining.delete(id); }
  }
  return [...ordered, ...remaining.values()];
}

export async function getTreatmentOrder(deps = {}) {
  const record = await (await collection("treatmentOrdering", deps)).findOne({ _id: "main" });
  return (deps.includePending ? record?.pendingOrder?.order : undefined) || record?.order || [];
}

// Existing services predate IDs. Assign each one a durable identity once, using
// its exact snapshot as a guard so a simultaneous edit cannot be overwritten.
export async function ensureTreatmentServiceIds(record, treatments) {
  for (let attempt = 0; record && attempt < MAX_ATTEMPTS; attempt++) {
    const seen = new Set();
    let changed = false;
    const services = (record.services || []).map(service => {
      let id = service._id == null ? "" : String(service._id);
      if (!id || seen.has(id)) id = new ObjectId().toHexString();
      seen.add(id);
      if (id === service._id) return service;
      changed = true;
      return { ...service, _id: id };
    });
    if (!changed) return record;
    const result = await treatments.updateOne({ _id: record._id, services: record.services }, { $set: { services } }, WRITE);
    if (result.matchedCount) return { ...record, services };
    record = await treatments.findOne({ _id: record._id });
  }
  if (!record) return null;
  throw new TreatmentOrderError("Treatment changed; retry ordering", 409);
}

function stale(request, sequences) {
  return request && (sequences?.[request.clientId] || 0) >= request.sequence;
}

function nextSequences(request, previous) {
  return request ? { ...(previous || {}), [request.clientId]: request.sequence } : (previous || {});
}

function snapshotField(record, field) {
  return Object.hasOwn(record, field) ? record[field] : { $exists: false };
}

async function queueOrder(resourceKey, order, deps) {
  validateOrder(order);
  validateRequest(deps.request);
  const main = resourceKey === "main";
  if (!main && (typeof resourceKey !== "string" || !/^[a-f0-9]{24}$/i.test(resourceKey))) throw new TreatmentOrderError("Invalid treatment ID");
  const records = await collection(main ? "treatmentOrdering" : "treatments", deps);
  const _id = main ? "main" : new ObjectId(resourceKey);
  const sequenceField = main ? "requestSequences" : "serviceOrderSequences";
  const now = deps.now ? new Date(deps.now) : new Date();
  const pendingOrder = { token: new ObjectId().toHexString(), order, dueAt: new Date(now.getTime() + 5000) };
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const previous = await records.findOne({ _id });
    if (!main && !previous) throw new TreatmentOrderError("Treatment not found", 404);
    // A retry still starts a durable job, but must not extend the five-second
    // deadline or resurrect an order already superseded/applied.
    if (stale(deps.request, previous?.[sequenceField])) return String(_id);
    const update = { pendingOrder, [sequenceField]: nextSequences(deps.request, previous?.[sequenceField]) };
    if (!previous) {
      try { await records.insertOne({ _id, order: [], ...update }, WRITE); return String(_id); }
      catch (error) { if (error.code !== 11000) throw error; }
    } else {
      const result = await records.updateOne({ _id, pendingOrder: snapshotField(previous, "pendingOrder"), [sequenceField]: snapshotField(previous, sequenceField) }, { $set: update }, WRITE);
      if (result.matchedCount) return String(_id);
    }
  }
  throw new TreatmentOrderError("Order changed; retry queuing", 409);
}

export function queueTreatmentOrder(order, deps = {}) { return queueOrder("main", order, deps); }
export function queueServiceOrder(treatmentId, order, deps = {}) { return queueOrder(treatmentId, order, deps); }

export async function processPendingTreatmentOrder(resourceKey, deps = {}) {
  const main = resourceKey === "main";
  if (!main && (typeof resourceKey !== "string" || !/^[a-f0-9]{24}$/i.test(resourceKey))) throw new TreatmentOrderError("Invalid treatment ID");
  const records = await collection(main ? "treatmentOrdering" : "treatments", deps);
  const _id = main ? "main" : new ObjectId(resourceKey);
  const now = deps.now ? new Date(deps.now) : new Date();
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let record = await records.findOne({ _id });
    if (!record?.pendingOrder) return { status: "idle" };
    if (record.pendingOrder.dueAt > now) return { status: "waiting", dueAt: record.pendingOrder.dueAt.toISOString() };
    if (!main) {
      record = await ensureTreatmentServiceIds(record, records);
      // Backfilling IDs can reread a newer pending intent after a lost CAS.
      if (!record?.pendingOrder) return { status: "idle" };
      if (record.pendingOrder.dueAt > now) return { status: "waiting", dueAt: record.pendingOrder.dueAt.toISOString() };
    }
    const pending = record.pendingOrder;
    const current = main
      ? await (await collection("treatments", deps)).find({}, { projection: { _id: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray()
      : record.services || [];
    const ordered = applyTreatmentOrder(current, pending.order);
    // Clearing the exact pending token and changing the committed order happen
    // in one atomic write. A newer drag or service edit makes this CAS retry.
    const result = await records.updateOne({ _id, "pendingOrder.token": pending.token, ...(main ? {} : { services: snapshotField(record, "services") }) }, {
      $set: { [main ? "order" : "services"]: main ? ordered.map(t => String(t._id)) : ordered, updatedAt: new Date() },
      $unset: { pendingOrder: "" },
    }, WRITE);
    if (result.matchedCount) return { status: "applied" };
  }
  return { status: "waiting", dueAt: new Date(now.getTime() + 500).toISOString() };
}

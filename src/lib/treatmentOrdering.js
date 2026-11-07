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
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(request.clientId || "") || !Number.isSafeInteger(request.sequence) || request.sequence < 1) {
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
  return (await (await collection("treatmentOrdering", deps)).findOne({ _id: "main" }))?.order || [];
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

export async function saveMainTreatmentOrder(order, deps = {}) {
  validateOrder(order);
  validateRequest(deps.request);
  const treatments = await collection("treatments", deps);
  const ordering = await collection("treatmentOrdering", deps);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const previous = await ordering.findOne({ _id: "main" });
    if (stale(deps.request, previous?.requestSequences)) return;
    const current = await treatments.find({}, { projection: { _id: 1 } }).sort({ createdAt: 1, _id: 1 }).toArray();
    const record = { order: applyTreatmentOrder(current, order).map(t => String(t._id)), updatedAt: new Date(), requestSequences: nextSequences(deps.request, previous?.requestSequences) };
    if (!previous) {
      try { await ordering.insertOne({ _id: "main", ...record }, WRITE); return; }
      catch (error) { if (error.code !== 11000) throw error; }
    } else {
      const result = await ordering.updateOne({ _id: "main", order: previous.order, requestSequences: snapshotField(previous, "requestSequences") }, { $set: record }, WRITE);
      if (result.matchedCount) return;
    }
  }
  throw new TreatmentOrderError("Order changed; retry saving", 409);
}

export async function saveServiceOrder(treatmentId, order, deps = {}) {
  validateOrder(order);
  validateRequest(deps.request);
  if (typeof treatmentId !== "string" || !/^[a-f0-9]{24}$/i.test(treatmentId)) throw new TreatmentOrderError("Invalid treatment ID");
  const treatments = await collection("treatments", deps);
  const _id = new ObjectId(treatmentId);
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    let record = await treatments.findOne({ _id });
    if (!record) throw new TreatmentOrderError("Treatment not found", 404);
    if (stale(deps.request, record.serviceOrderSequences)) return;
    record = await ensureTreatmentServiceIds(record, treatments);
    if (!record) throw new TreatmentOrderError("Treatment not found", 404);
    if (stale(deps.request, record.serviceOrderSequences)) return;
    const services = applyTreatmentOrder(record.services || [], order);
    const result = await treatments.updateOne({ _id, services: snapshotField(record, "services"), serviceOrderSequences: snapshotField(record, "serviceOrderSequences") }, {
      $set: { services, updatedAt: new Date(), serviceOrderSequences: nextSequences(deps.request, record.serviceOrderSequences) },
    }, WRITE);
    if (result.matchedCount) return;
  }
  throw new TreatmentOrderError("Treatment changed; retry ordering", 409);
}

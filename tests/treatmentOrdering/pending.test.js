import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";
vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Live database access forbidden"); } }));
const ordering = await import("@/lib/treatmentOrdering");
let server, client, db, deps;
const id = n => new ObjectId(n.toString(16).padStart(24, "0"));
const T0 = new Date("2026-11-08T12:00:00Z");
const time = ms => new Date(T0.getTime() + ms);
beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  if (!server.getUri().startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback required");
  client = await new MongoClient(server.getUri()).connect(); db = client.db("pending_order_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  await db.dropDatabase(); deps = { getCollection: async name => db.collection(name) };
  await db.collection("treatments").insertMany([
    { _id: id(1), services: [{ _id: "a", price: 10 }, { _id: "b", price: 20 }] },
    { _id: id(2), services: [] },
  ]);
});
const queueDeps = (sequence, ms = 0) => ({ ...deps, now: time(ms), request: { clientId: "browser", sequence } });
const processAt = (key, ms) => ordering.processPendingTreatmentOrder(key, { ...deps, now: time(ms) });

describe("server-owned treatment ordering debounce", () => {
  it("stores intent immediately, overlays it for admin, and applies after five seconds without another browser call", async () => {
    expect(ordering.queueTreatmentOrder).toBeTypeOf("function");
    const order = [String(id(2)), String(id(1))];
    expect(await ordering.queueTreatmentOrder(order, queueDeps(1))).toBe("main");
    expect(await ordering.getTreatmentOrder(deps)).toEqual([]);
    expect(await ordering.getTreatmentOrder({ ...deps, includePending: true })).toEqual(order);
    expect(await processAt("main", 4999)).toEqual({ status: "waiting", dueAt: time(5000).toISOString() });
    expect(await processAt("main", 5000)).toEqual({ status: "applied" });
    expect(await ordering.getTreatmentOrder(deps)).toEqual(order);
    expect((await db.collection("treatmentOrdering").findOne({ _id: "main" })).pendingOrder).toBeUndefined();
    expect(await processAt("main", 6000)).toEqual({ status: "idle" });
  });

  it("restarts the server deadline only for a newer drag and lets any older job process the latest intent", async () => {
    await ordering.queueTreatmentOrder([String(id(2)), String(id(1))], queueDeps(1));
    const finalOrder = [String(id(1)), String(id(2))];
    await ordering.queueTreatmentOrder(finalOrder, queueDeps(2, 4000));
    await ordering.queueTreatmentOrder(finalOrder, queueDeps(2, 8000));
    await ordering.queueTreatmentOrder([String(id(2)), String(id(1))], queueDeps(1, 8500));
    expect(await processAt("main", 5000)).toEqual({ status: "waiting", dueAt: time(9000).toISOString() });
    expect(await processAt("main", 9000)).toEqual({ status: "applied" });
    expect(await ordering.getTreatmentOrder(deps)).toEqual(finalOrder);
    await ordering.queueTreatmentOrder([String(id(2)), String(id(1))], queueDeps(1, 10000));
    expect(await processAt("main", 20000)).toEqual({ status: "idle" });
  });

  it("applies service ordering against fresh content, preserving concurrent edits and additions", async () => {
    const key = await ordering.queueServiceOrder(String(id(1)), ["b", "a", "deleted"], queueDeps(1));
    const records = db.collection("treatments");
    expect((await records.findOne({ _id: id(1) })).services.map(s => s._id)).toEqual(["a", "b"]);
    await records.updateOne({ _id: id(1) }, { $set: { "services.0.price": 99 } });
    await records.updateOne({ _id: id(1) }, { $push: { services: { _id: "new", price: 30 } } });
    expect(await processAt(key, 5000)).toEqual({ status: "applied" });
    expect((await records.findOne({ _id: id(1) })).services).toEqual([{ _id: "b", price: 20 }, { _id: "a", price: 99 }, { _id: "new", price: 30 }]);
  });

  it("does not commit an old order when a newer intent arrives during the apply", async () => {
    const key = await ordering.queueServiceOrder(String(id(1)), ["b", "a"], queueDeps(1));
    const records = db.collection("treatments"); let intercepted = false;
    const wrapped = {
      findOne: (...args) => records.findOne(...args),
      updateOne: async (...args) => {
        if (!intercepted) { intercepted = true; await ordering.queueServiceOrder(key, ["a", "b"], queueDeps(2, 5000)); }
        return records.updateOne(...args);
      },
    };
    expect(await ordering.processPendingTreatmentOrder(key, { getCollection: async () => wrapped, now: time(5000) })).toEqual({ status: "waiting", dueAt: time(10000).toISOString() });
    const saved = await records.findOne({ _id: id(1) });
    expect(saved.services.map(s => s._id)).toEqual(["a", "b"]);
    expect(saved.pendingOrder.order).toEqual(["a", "b"]);
    expect(await processAt(key, 10000)).toEqual({ status: "applied" });
  });

  it("retries a concurrent content write without losing edits", async () => {
    const key = await ordering.queueServiceOrder(String(id(1)), ["b", "a"], queueDeps(1));
    const records = db.collection("treatments"); let intercepted = false;
    const wrapped = {
      findOne: (...args) => records.findOne(...args),
      updateOne: async (...args) => {
        if (!intercepted) { intercepted = true; await records.updateOne({ _id: id(1) }, { $set: { "services.0.price": 100 } }); }
        return records.updateOne(...args);
      },
    };
    expect(await ordering.processPendingTreatmentOrder(key, { getCollection: async () => wrapped, now: time(5000) })).toEqual({ status: "applied" });
    expect((await records.findOne({ _id: id(1) })).services).toEqual([{ _id: "b", price: 20 }, { _id: "a", price: 100 }]);
  });

  it("treats a deleted treatment as completed work and rejects malformed intents", async () => {
    const key = await ordering.queueServiceOrder(String(id(1)), ["b", "a"], queueDeps(1));
    await db.collection("treatments").deleteOne({ _id: id(1) });
    expect(await processAt(key, 5000)).toEqual({ status: "idle" });
    await expect(ordering.queueServiceOrder(key, [], queueDeps(2))).rejects.toMatchObject({ status: 404 });
    await expect(ordering.queueTreatmentOrder(["duplicate", "duplicate"], queueDeps(3))).rejects.toMatchObject({ status: 400 });
    await expect(ordering.queueTreatmentOrder([], { ...deps, request: { clientId: 123, sequence: 1 } })).rejects.toMatchObject({ status: 400 });
  });
});

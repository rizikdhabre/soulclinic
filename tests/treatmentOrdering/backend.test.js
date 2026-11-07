import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";

vi.mock("@/lib/db", () => ({ getCollection: () => { throw new Error("Live database access forbidden"); } }));
const ordering = await import("@/lib/treatmentOrdering").catch(() => ({}));
const persistMain = async (order, deps) => {
  const key = await ordering.queueTreatmentOrder(order, deps);
  return ordering.processPendingTreatmentOrder(key, { ...deps, now: new Date(Date.now() + 6000) });
};
const persistService = async (treatmentId, order, deps) => {
  const key = await ordering.queueServiceOrder(treatmentId, order, deps);
  return ordering.processPendingTreatmentOrder(key, { ...deps, now: new Date(Date.now() + 6000) });
};
let server, client, db, deps;
const id = n => new ObjectId(n.toString(16).padStart(24, "0"));

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback database required");
  client = await new MongoClient(uri).connect();
  db = client.db("treatment_ordering_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => { await db.dropDatabase(); deps = { getCollection: async name => db.collection(name) }; });

describe("durable treatment ordering", () => {
  it("orders known records, ignores deleted IDs and retains newly added records", () => {
    expect(ordering.applyTreatmentOrder).toBeTypeOf("function");
    const records = [1, 2, 3].map(n => ({ _id: id(n), title: `T${n}` }));
    expect(ordering.applyTreatmentOrder(records, [String(id(2)), String(id(9)), String(id(1))]).map(t => t.title)).toEqual(["T2", "T1", "T3"]);
  });

  it("persists main order idempotently without altering treatment content", async () => {
    await db.collection("treatments").insertMany([1, 2, 3].map(n => ({ _id: id(n), title: `T${n}`, services: [{ title: "keep", price: 95 }] })));
    const before = await db.collection("treatments").find({}).toArray();
    await persistMain([String(id(2)), String(id(9)), String(id(1))], deps);
    await persistMain([String(id(2)), String(id(9)), String(id(1))], deps);
    expect(await ordering.getTreatmentOrder(deps)).toEqual([String(id(2)), String(id(1)), String(id(3))]);
    expect(await db.collection("treatments").find({}).toArray()).toEqual(before);
  });

  it("assigns durable unique service IDs to legacy services and keeps existing IDs", async () => {
    const record = { _id: id(1), services: [{ title: "same" }, { title: "same" }, { _id: "existing", title: "keep" }] };
    await db.collection("treatments").insertOne(record);
    const first = await ordering.ensureTreatmentServiceIds(record, db.collection("treatments"));
    const second = await ordering.ensureTreatmentServiceIds(await db.collection("treatments").findOne({ _id: id(1) }), db.collection("treatments"));
    expect(first.services.map(s => s._id)).toEqual(second.services.map(s => s._id));
    expect(new Set(first.services.map(s => s._id)).size).toBe(3);
    expect(first.services[2]._id).toBe("existing");
    expect(first.services.map(({ _id, ...s }) => s)).toEqual([{ title: "same" }, { title: "same" }, { title: "keep" }]);
  });

  it("does not let a stale GET backfill overwrite a concurrently edited service", async () => {
    const stale = { _id: id(1), services: [{ title: "old", price: 10 }] };
    await db.collection("treatments").insertOne({ ...stale, services: [{ title: "new", price: 20 }] });
    const saved = await ordering.ensureTreatmentServiceIds(stale, db.collection("treatments"));
    expect(saved.services[0]).toMatchObject({ title: "new", price: 20 });
    expect(saved.services[0]._id).toBeTypeOf("string");
  });

  it("reorders current services while keeping fresh content and newly added entries", async () => {
    await db.collection("treatments").insertOne({ _id: id(1), title: "parent", services: [
      { _id: "a", title: "edited", price: 90 }, { _id: "b", title: "B", imagePath: "keep" }, { _id: "new", title: "new" },
    ] });
    await persistService(String(id(1)), ["b", "deleted", "a"], deps);
    await persistService(String(id(1)), ["b", "deleted", "a"], deps);
    const record = await db.collection("treatments").findOne({ _id: id(1) });
    expect(record.title).toBe("parent");
    expect(record.services).toEqual([{ _id: "b", title: "B", imagePath: "keep" }, { _id: "a", title: "edited", price: 90 }, { _id: "new", title: "new" }]);
  });

  it("retries a concurrent content edit rather than replacing it with its old snapshot", async () => {
    const collection = db.collection("treatments");
    await collection.insertOne({ _id: id(1), services: [{ _id: "a", price: 10 }, { _id: "b", price: 20 }] });
    let intercepted = false;
    const wrapped = {
      findOne: (...args) => collection.findOne(...args),
      updateOne: async (...args) => {
        if (!intercepted) { intercepted = true; await collection.updateOne({ _id: id(1) }, { $set: { "services.0.price": 99 } }); }
        return collection.updateOne(...args);
      },
    };
    await persistService(String(id(1)), ["b", "a"], { getCollection: async () => wrapped });
    expect((await collection.findOne({ _id: id(1) })).services).toEqual([{ _id: "b", price: 20 }, { _id: "a", price: 99 }]);
  });

  it("rejects malformed orders and missing parents without reporting a successful save", async () => {
    for (const invalid of [undefined, null, {}, ["a", "a"], [null], [""]]) {
      await expect(persistMain(invalid, deps)).rejects.toMatchObject({ status: 400 });
    }
    await expect(persistService("bad", [], deps)).rejects.toMatchObject({ status: 400 });
    await expect(persistService(String(id(1)), [], deps)).rejects.toMatchObject({ status: 404 });
  });

  it("acknowledges older retried requests without undoing newer main or service ordering", async () => {
    await db.collection("treatments").insertMany([
      { _id: id(1), services: [{ _id: "a" }, { _id: "b" }] }, { _id: id(2), services: [] },
    ]);
    const request = (clientId, sequence) => ({ ...deps, request: { clientId, sequence } });
    await persistMain([String(id(2)), String(id(1))], request("browser-a", 2));
    await persistMain([String(id(2)), String(id(1))], request("browser-b", 1));
    await persistMain([String(id(1)), String(id(2))], request("browser-a", 1));
    expect(await ordering.getTreatmentOrder(deps)).toEqual([String(id(2)), String(id(1))]);
    await persistService(String(id(1)), ["b", "a"], request("browser-a", 2));
    await persistService(String(id(1)), ["b", "a"], request("browser-b", 1));
    await persistService(String(id(1)), ["a", "b"], request("browser-a", 1));
    expect((await db.collection("treatments").findOne({ _id: id(1) })).services.map(s => s._id)).toEqual(["b", "a"]);
  });

  it("rejects stale intent when a concurrent request advances the accepted sequence", async () => {
    const treatments = db.collection("treatments");
    await treatments.insertOne({ _id: id(1), services: [{ _id: "a" }, { _id: "b" }, { title: "legacy" }] });
    let intercepted = false;
    const wrapped = {
      findOne: (...args) => treatments.findOne(...args),
      updateOne: async (...args) => {
        if (!intercepted) {
          intercepted = true;
          await treatments.updateOne({ _id: id(1) }, { $set: {
            services: [{ _id: "b" }, { _id: "a" }, { _id: "c", title: "legacy" }],
            serviceOrderSequences: { browser: 2 },
          } });
        }
        return treatments.updateOne(...args);
      },
    };
    await persistService(String(id(1)), ["a", "b"], {
      getCollection: async () => wrapped, request: { clientId: "browser", sequence: 1 },
    });
    const saved = await treatments.findOne({ _id: id(1) });
    expect(saved.services.map(service => service._id)).toEqual(["b", "a", "c"]);
    expect(saved.serviceOrderSequences.browser).toBe(2);
  });
});

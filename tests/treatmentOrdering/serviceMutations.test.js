import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient, ObjectId } from "mongodb";
import { MongoMemoryServer } from "mongodb-memory-server-core";

let db, server, client, collectionOverride;
const { deleteFile } = vi.hoisted(() => ({ deleteFile: vi.fn(async () => {}) }));
vi.mock("@/lib/db", () => ({ getCollection: async (name) => collectionOverride || db.collection(name) }));
vi.mock("@/lib/cloudStorage", () => ({ getStorageBucket: async () => ({ file: (path) => ({ delete: () => deleteFile(path) }) }) }));
vi.mock("@/lib/cache/redisReadCache", () => ({ advanceTreatmentCatalogCacheGeneration: vi.fn(async () => true) }));
const servicesRoute = await import("@/app/api/admin/treatments/services/route");
const imageRoute = await import("@/app/api/admin/treatments/services/delete-image/route");
const treatmentId = "123456789012345678901234";
const first = { _id: "service-a", title: "A", price: 10, imagePath: "a.jpg", imageUrl: "a-url" };
const second = { _id: "service-b", title: "B", price: 20, imagePath: "b.jpg", imageUrl: "b-url" };
const request = (payload) => ({ json: async () => ({ treatmentId, ...payload }) });
const stored = () => db.collection("treatments").findOne({ _id: new ObjectId(treatmentId) });

beforeAll(async () => {
  server = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1", launchTimeout: 120_000 }, spawn: { windowsHide: true } });
  const uri = server.getUri();
  if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Loopback database required");
  client = await new MongoClient(uri).connect();
  db = client.db("service_order_mutations_test");
}, 120_000);
afterAll(async () => { await client?.close(); await server?.stop(); });
beforeEach(async () => {
  collectionOverride = null;
  deleteFile.mockClear();
  await db.dropDatabase();
  await db.collection("treatments").insertOne({ _id: new ObjectId(treatmentId), services: [second, first] });
});

describe("service changes while an order save is pending", () => {
  it("assigns and returns a stable server-generated ID for a new service", async () => {
    const response = await servicesRoute.POST(request({ service: { _id: "client-id", title: "C" } }));
    const body = await response.json();
    expect(response.status).toBe(201);
    expect(body.service._id).toMatch(/^[a-f0-9]{24}$/);
    expect((await stored()).services[2]).toEqual(body.service);
  });

  it("edits by stable ID rather than the stale displayed index and preserves the ID", async () => {
    const response = await servicesRoute.PUT(request({ serviceId: first._id, serviceIndex: 0, service: { _id: "replacement", title: "Changed A" } }));
    expect(response.status).toBe(200);
    expect((await stored()).services).toEqual([second, { ...first, title: "Changed A" }]);
  });

  it("deletes the stable-ID target and preserves other subtreatments", async () => {
    const response = await servicesRoute.DELETE(request({ serviceId: first._id, serviceIndex: 0 }));
    expect(response.status).toBe(200);
    expect((await stored()).services).toEqual([second]);
    expect(deleteFile).toHaveBeenCalledWith("a.jpg");
  });

  it.each(["PUT", "DELETE"])("does not fall back to an index when %s receives a missing ID", async (method) => {
    const response = await servicesRoute[method](request({ serviceId: "deleted-service", serviceIndex: 0, service: { title: "Changed" } }));
    expect(response.status).toBe(404);
    expect((await stored()).services).toEqual([second, first]);
  });

  it("removes only the target service's image after reordering", async () => {
    const response = await imageRoute.POST(request({ serviceId: first._id, serviceIndex: 0 }));
    expect(response.status).toBe(200);
    expect((await stored()).services).toEqual([second, { ...first, imagePath: "", imageUrl: "" }]);
    expect(deleteFile).toHaveBeenCalledWith("a.jpg");
    expect(deleteFile).not.toHaveBeenCalledWith("b.jpg");
  });

  it("keeps legacy index edits working", async () => {
    const response = await servicesRoute.PUT(request({ serviceIndex: 0, service: { title: "Changed B" } }));
    expect(response.status).toBe(200);
    expect((await stored()).services).toEqual([{ ...second, title: "Changed B" }, first]);
  });

  it("rejects a legacy index delete if the order changes between the read and write", async () => {
    const collection = db.collection("treatments");
    collectionOverride = {
      findOne: (...args) => collection.findOne(...args),
      updateOne: async (...args) => {
        await collection.updateOne({ _id: new ObjectId(treatmentId) }, { $set: { services: [first, second] } });
        return collection.updateOne(...args);
      },
    };
    const response = await servicesRoute.DELETE(request({ serviceIndex: 0 }));
    expect(response.status).toBe(409);
    expect((await stored()).services).toEqual([first, second]);
    expect(deleteFile).not.toHaveBeenCalled();
  });
});

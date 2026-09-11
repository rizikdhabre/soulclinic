import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { ObjectId } from "mongodb";

const io = vi.hoisted(() => {
  const file = { save: vi.fn(), makePublic: vi.fn(), delete: vi.fn() };
  const bucket = { name: "existing-project.appspot.com", file: vi.fn(() => file) };
  return {
    file,
    bucket,
    Storage: vi.fn(function () { this.bucket = vi.fn(() => bucket); }),
    collection: {
      findOne: vi.fn(), find: vi.fn(), updateOne: vi.fn(),
      insertOne: vi.fn(), deleteOne: vi.fn(),
    },
    getCollection: vi.fn(),
    advanceHero: vi.fn(), advanceTreatments: vi.fn(),
  };
});

vi.mock("server-only", () => ({}));
vi.mock("@google-cloud/storage", () => ({ Storage: io.Storage }));
vi.mock("@/lib/db", () => ({ getCollection: io.getCollection }));
vi.mock("@/lib/cache/redisReadCache", () => ({
  advanceHeroCacheGeneration: io.advanceHero,
  advanceTreatmentCatalogCacheGeneration: io.advanceTreatments,
  getHomepageHeroWithCache: (loader) => loader(),
  getTreatmentCatalogWithCache: (loader) => loader(),
}));

const parentId = "000000000000000000000001";
const perfumeId = "000000000000000000000002";
const timestamp = 1800000000000;
const oldPath = "legacy/existing-image.jpg";
const newPath = "legacy/new-image.jpg";

const routes = {
  hero: () => import("@/app/api/admin/upload-hero-image/route"),
  serviceUpload: () => import("@/app/api/admin/upload-service-image/route"),
  perfumeUpload: () => import("@/app/api/admin/perfumes/upload-image/route"),
  perfumeImage: () => import("@/app/api/admin/perfumes/delete-image/route"),
  perfumes: () => import("@/app/api/admin/perfumes/route"),
  perfume: () => import("@/app/api/admin/perfumes/sub/route"),
  treatments: () => import("@/app/api/admin/treatments/route"),
  service: () => import("@/app/api/admin/treatments/services/route"),
  serviceImage: () => import("@/app/api/admin/treatments/services/delete-image/route"),
};

const jsonRequest = (body) => ({ json: async () => body });
function imageRequest(fields = {}, image = { type: "image/png", size: 3, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }) {
  const values = { ...fields, image };
  return { formData: async () => ({ get: (key) => values[key] ?? null }) };
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  vi.stubEnv("FIREBASE_STORAGE_BUCKET", io.bucket.name);
  for (const key of ["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"]) vi.stubEnv(key, "");
  vi.spyOn(Date, "now").mockReturnValue(timestamp);
  vi.spyOn(console, "error").mockImplementation(() => {});
  for (const fn of Object.values(io.file)) fn.mockReset().mockResolvedValue(undefined);
  for (const fn of Object.values(io.collection)) fn.mockReset().mockResolvedValue({});
  io.collection.findOne.mockResolvedValue(null);
  io.collection.find.mockReturnValue({ toArray: async () => [] });
  io.getCollection.mockResolvedValue(io.collection);
  io.advanceHero.mockResolvedValue(true);
  io.advanceTreatments.mockResolvedValue(true);
});

afterEach(() => vi.unstubAllEnvs());

describe("image uploads", () => {
  it.each([
    ["serviceUpload", "treatmentId", "services/000000000000000000000001/1800000000000.jpg"],
    ["perfumeUpload", "categoryId", "perfumes/000000000000000000000001/1800000000000.jpg"],
  ])("%s preserves bytes, content type, public access, path and cache-busted URL", async (route, field, path) => {
    const { POST } = await routes[route]();
    const response = await POST(imageRequest({ [field]: parentId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path, url: `https://storage.googleapis.com/existing-project.appspot.com/${path}?v=1800000000000`,
    });
    expect(io.Storage).toHaveBeenCalledWith({});
    expect(io.bucket.file).toHaveBeenCalledWith(path);
    expect(io.file.save).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), { metadata: { contentType: "image/png" } });
    expect(io.file.makePublic).toHaveBeenCalledTimes(1);
    expect(io.file.save.mock.invocationCallOrder[0]).toBeLessThan(io.file.makePublic.mock.invocationCallOrder[0]);
  });

  it.each(["serviceUpload", "perfumeUpload"])("%s keeps image validation ahead of storage initialization", async (route) => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "");
    const { POST } = await routes[route]();
    for (const image of [null, { type: "text/plain", size: 3 }, { type: "image/png", size: 5 * 1024 * 1024 + 1 }]) {
      const response = await POST(imageRequest({}, image));
      expect(response.status).toBe(400);
      expect(await response.json()).toHaveProperty("error");
    }
    expect(io.Storage).not.toHaveBeenCalled();
    expect(io.file.save).not.toHaveBeenCalled();
  });

  it.each(["serviceUpload", "perfumeUpload", "hero"])("%s returns its existing 500 response without leaking provider details", async (route) => {
    io.file.save.mockRejectedValue(Object.assign(new Error("private-pem private-token"), { credentials: "private-credentials" }));
    const { POST } = await routes[route]();
    const response = await POST(imageRequest({ treatmentId: parentId, categoryId: parentId }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual(route === "hero" ? { message: "Failed to upload hero image" } : { error: "Upload failed" });
    expect(io.file.makePublic).not.toHaveBeenCalled();
    expect(io.collection.updateOne).not.toHaveBeenCalled();
    expect(io.file.delete).not.toHaveBeenCalled();
    expect(inspect(console.error.mock.calls)).not.toMatch(/private-pem|private-token|private-credentials/);
  });

  it.each(["serviceUpload", "perfumeUpload"])("%s does not claim success when making the image public fails", async (route) => {
    io.file.makePublic.mockRejectedValue(new Error("private-token"));
    const { POST } = await routes[route]();
    const response = await POST(imageRequest({ treatmentId: parentId, categoryId: parentId }));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "Upload failed" });
    expect(inspect(console.error.mock.calls)).not.toContain("private-token");
  });

  it("keeps hero first-upload persistence and public save options", async () => {
    const { POST } = await routes.hero();
    const response = await POST(imageRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      message: "Hero image saved successfully", isFirstUpload: true,
      path: "homepage/hero-1800000000000.jpg",
      url: "https://storage.googleapis.com/existing-project.appspot.com/homepage/hero-1800000000000.jpg",
    });
    expect(io.Storage).toHaveBeenCalledWith({});
    expect(io.file.save).toHaveBeenCalledWith(Buffer.from([1, 2, 3]), {
      metadata: { contentType: "image/png" }, public: true, resumable: false,
    });
    expect(io.collection.insertOne).toHaveBeenCalledWith(expect.objectContaining({
      key: "homepage", heroImagePath: "homepage/hero-1800000000000.jpg",
      heroImageUrl: "https://storage.googleapis.com/existing-project.appspot.com/homepage/hero-1800000000000.jpg",
    }));
    expect(io.advanceHero).toHaveBeenCalledTimes(1);
    expect(io.file.delete).not.toHaveBeenCalled();
  });

  it("keeps the new hero and cache invalidation when old-image cleanup fails", async () => {
    io.collection.findOne.mockResolvedValue({ heroImagePath: oldPath });
    io.file.delete.mockRejectedValue(new Error("private-token"));
    const { POST } = await routes.hero();
    const response = await POST(imageRequest());
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ isFirstUpload: false });
    expect(io.bucket.file).toHaveBeenLastCalledWith(oldPath);
    expect(io.collection.updateOne).toHaveBeenCalledWith({ key: "homepage" }, {
      $set: expect.objectContaining({ heroImagePath: "homepage/hero-1800000000000.jpg" }),
    });
    expect(io.advanceHero.mock.invocationCallOrder[0]).toBeLessThan(io.file.delete.mock.invocationCallOrder[0]);
    expect(inspect(console.error.mock.calls)).not.toContain("private-token");
  });

  it("does not delete the previous hero when database persistence fails", async () => {
    io.collection.findOne.mockResolvedValue({ heroImagePath: oldPath });
    io.collection.updateOne.mockRejectedValue(new Error("private-token"));
    const { POST } = await routes.hero();
    expect((await POST(imageRequest())).status).toBe(500);
    expect(io.file.delete).not.toHaveBeenCalled();
    expect(io.advanceHero).not.toHaveBeenCalled();
    expect(inspect(console.error.mock.calls)).not.toContain("private-token");
  });

  it("rejects a missing hero image before storage initialization", async () => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "");
    const { POST } = await routes.hero();
    const response = await POST(imageRequest({}, null));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ message: "No image provided" });
    expect(io.Storage).not.toHaveBeenCalled();
  });

  it.each(["serviceUpload", "perfumeUpload", "hero"])("%s fails cleanly without a configured bucket", async (route) => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "");
    const { POST } = await routes[route]();
    const response = await POST(imageRequest());
    expect(response.status).toBe(500);
    expect(io.file.save).not.toHaveBeenCalled();
    expect(io.Storage).not.toHaveBeenCalled();
  });
});

function existingImages() {
  return { perfumes: [{ _id: new ObjectId(perfumeId), imagePath: oldPath }], services: [{ imagePath: oldPath }] };
}
const deleteCases = [
  ["perfumeImage", "POST", { categoryId: parentId, perfumeId }, false, "Image deleted"],
  ["perfume", "DELETE", { categoryId: parentId, perfumeId }, false, "Deleted"],
  ["serviceImage", "POST", { treatmentId: parentId, serviceIndex: 0 }, true, "Image deleted"],
];

describe("image deletion and replacement", () => {
  it.each(deleteCases)("%s deletes the stored path before clearing its database reference", async (route, method, body, invalidates, message) => {
    io.collection.findOne.mockResolvedValue(existingImages());
    const routeModule = await routes[route]();
    const response = await routeModule[method](jsonRequest(body));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message });
    expect(io.Storage).toHaveBeenCalledWith({});
    expect(io.bucket.file).toHaveBeenCalledWith(oldPath);
    expect(io.file.delete).toHaveBeenCalledTimes(1);
    expect(io.file.delete.mock.invocationCallOrder[0]).toBeLessThan(io.collection.updateOne.mock.invocationCallOrder[0]);
    expect(io.advanceTreatments).toHaveBeenCalledTimes(invalidates ? 1 : 0);
    const update = io.collection.updateOne.mock.calls[0][1];
    if (route === "perfume") expect(update.$pull.perfumes._id.toString()).toBe(perfumeId);
    else expect(update.$set).toMatchObject(route === "perfumeImage" ? {
      "perfumes.$.imageUrl": "", "perfumes.$.imagePath": "",
    } : { "services.0.imageUrl": "", "services.0.imagePath": "" });
  });

  it.each(deleteCases)("%s keeps the database reference if cloud deletion fails", async (route, method, body) => {
    io.collection.findOne.mockResolvedValue(existingImages());
    io.file.delete.mockRejectedValue(Object.assign(new Error("private-token"), { credentials: "private-pem" }));
    const routeModule = await routes[route]();
    const response = await routeModule[method](jsonRequest(body));
    expect(response.status).toBe(500);
    expect(io.collection.updateOne).not.toHaveBeenCalled();
    expect(io.advanceTreatments).not.toHaveBeenCalled();
    expect(inspect(console.error.mock.calls)).not.toMatch(/private-token|private-pem/);
  });

  it.each(["perfume", "service"])("%s replacement deletes only the old path after database persistence", async (route) => {
    io.collection.findOne.mockResolvedValue(existingImages());
    const { PUT } = await routes[route]();
    const response = await PUT(jsonRequest({
      categoryId: parentId, perfumeId, treatmentId: parentId, serviceIndex: 0,
      perfume: { name: "Updated", imagePath: newPath }, service: { imagePath: newPath },
    }));
    expect(response.status).toBe(200);
    expect(io.Storage).toHaveBeenCalledWith({});
    expect(io.bucket.file).toHaveBeenCalledExactlyOnceWith(oldPath);
    expect(io.collection.updateOne.mock.invocationCallOrder[0]).toBeLessThan(io.file.delete.mock.invocationCallOrder[0]);
  });

  it.each(["perfume", "service"])("%s replacement preserves best-effort cleanup failure behavior", async (route) => {
    io.collection.findOne.mockResolvedValue(existingImages());
    io.file.delete.mockRejectedValue(new Error("private-token"));
    const { PUT } = await routes[route]();
    const response = await PUT(jsonRequest({
      categoryId: parentId, perfumeId, treatmentId: parentId, serviceIndex: 0,
      perfume: { name: "Updated", imagePath: newPath }, service: { imagePath: newPath },
    }));
    expect(response.status).toBe(200);
    expect(io.file.delete).toHaveBeenCalledTimes(1);
    expect(inspect(console.error.mock.calls)).not.toContain("private-token");
  });

  it.each(["perfume", "service"])("%s leaves unchanged images alone without requiring storage configuration", async (route) => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "");
    io.collection.findOne.mockResolvedValue(existingImages());
    const { PUT } = await routes[route]();
    const response = await PUT(jsonRequest({
      categoryId: parentId, perfumeId, treatmentId: parentId, serviceIndex: 0,
      perfume: { name: "Updated", imagePath: oldPath }, service: { imagePath: oldPath },
    }));
    expect(response.status).toBe(200);
    expect(io.Storage).not.toHaveBeenCalled();
    expect(io.file.delete).not.toHaveBeenCalled();
  });

  it.each(["perfumes", "treatments"])("%s category deletion targets each stored image and keeps best-effort failures", async (route) => {
    io.collection.findOne.mockResolvedValue({
      perfumes: [{ imagePath: oldPath }, { imagePath: newPath }, {}],
      services: [{ imagePath: oldPath }, { imagePath: newPath }, {}],
    });
    io.file.delete.mockRejectedValueOnce(new Error("private-token"));
    const { DELETE } = await routes[route]();
    const response = await DELETE(jsonRequest({ id: parentId }));
    expect(response.status).toBe(200);
    expect(io.Storage).toHaveBeenCalledWith({});
    expect(io.bucket.file.mock.calls).toEqual([[oldPath], [newPath]]);
    expect(io.file.delete).toHaveBeenCalledTimes(2);
    expect(io.collection.deleteOne).toHaveBeenCalledWith({ _id: new ObjectId(parentId) });
    expect(io.advanceTreatments).toHaveBeenCalledTimes(route === "treatments" ? 1 : 0);
    expect(inspect(console.error.mock.calls)).not.toContain("private-token");
  });

  it("service deletion keeps its index-removal pipeline and best-effort image cleanup", async () => {
    io.collection.findOne.mockResolvedValue(existingImages());
    io.file.delete.mockRejectedValue(new Error("private-token"));
    const { DELETE } = await routes.service();
    const response = await DELETE(jsonRequest({ treatmentId: parentId, serviceIndex: "0" }));
    expect(response.status).toBe(200);
    expect(io.Storage).toHaveBeenCalledWith({});
    expect(io.bucket.file).toHaveBeenCalledWith(oldPath);
    const pipeline = io.collection.updateOne.mock.calls[0][1];
    expect(pipeline[0].$set.services.$let.in.$map.input.$filter.cond).toEqual({ $ne: ["$$serviceIndex", 0] });
    expect(io.advanceTreatments.mock.invocationCallOrder[0]).toBeLessThan(io.file.delete.mock.invocationCallOrder[0]);
    expect(inspect(console.error.mock.calls)).not.toContain("private-token");
  });

  it("service deletion rejects invalid indices without touching images", async () => {
    const { DELETE } = await routes.service();
    for (const serviceIndex of [-1, "no", 0.5]) {
      expect((await DELETE(jsonRequest({ treatmentId: parentId, serviceIndex }))).status).toBe(400);
    }
    expect(io.collection.updateOne).not.toHaveBeenCalled();
    expect(io.Storage).not.toHaveBeenCalled();
  });
});

describe("read routes remain independent of storage", () => {
  it.each(["hero", "perfumes", "treatments"])("%s can return stored data with no storage configuration", async (route) => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "");
    io.collection.findOne.mockResolvedValue({ heroImageUrl: "https://storage.googleapis.com/existing-project.appspot.com/legacy.jpg" });
    const { GET } = await routes[route]();
    const response = await GET();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(route === "hero" ? {
      heroImageUrl: "https://storage.googleapis.com/existing-project.appspot.com/legacy.jpg",
    } : []);
    expect(io.Storage).not.toHaveBeenCalled();
    expect(io.bucket.file).not.toHaveBeenCalled();
  });
});

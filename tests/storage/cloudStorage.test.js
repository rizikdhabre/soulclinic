import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { Storage, bucket } = vi.hoisted(() => ({
  Storage: vi.fn(),
  bucket: vi.fn((name) => ({ name })),
}));

vi.mock("server-only", () => ({}));
vi.mock("@google-cloud/storage", () => ({ Storage }));

beforeEach(() => {
  vi.resetModules();
  Storage.mockReset().mockImplementation(function () {
    this.bucket = bucket;
  });
  bucket.mockClear();
  for (const key of [
    "FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY", "FIREBASE_STORAGE_BUCKET",
    "GCS_PROJECT_ID", "GCS_CLIENT_EMAIL", "GCS_PRIVATE_KEY", "GCS_BUCKET",
  ]) {
    vi.stubEnv(key, "");
  }
});

afterEach(() => vi.unstubAllEnvs());

const loadStorage = () => import("@/lib/cloudStorage");

describe("lazy Cloud Storage configuration", () => {
  it("can be imported without credentials or a bucket and does not initialize storage", async () => {
    const storageModule = await loadStorage();
    expect(storageModule.getStorageBucket).toBeTypeOf("function");
    expect(Storage).not.toHaveBeenCalled();
  });

  it.each(["", "   "])("rejects a missing bucket (%j) before constructing a client", async (name) => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", name);
    const { getStorageBucket } = await loadStorage();
    await expect(getStorageBucket()).rejects.toThrow("FIREBASE_STORAGE_BUCKET is required");
    expect(Storage).not.toHaveBeenCalled();
  });

  it("does not use renamed or public settings instead of existing server configuration", async () => {
    vi.stubEnv("GCS_BUCKET", "renamed.invalid");
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET", "public.invalid");
    const { getStorageBucket } = await loadStorage();
    await expect(getStorageBucket()).rejects.toThrow("FIREBASE_STORAGE_BUCKET is required");
    expect(Storage).not.toHaveBeenCalled();
  });

  it.each(["existing-project.appspot.com", "existing-project.firebasestorage.app"])(
    "uses the exact existing bucket name %s with ADC",
    async (name) => {
      vi.stubEnv("FIREBASE_STORAGE_BUCKET", name);
      const { getStorageBucket } = await loadStorage();
      expect(await getStorageBucket()).toEqual({ name });
      expect(Storage).toHaveBeenCalledWith({});
      expect(bucket).toHaveBeenCalledWith(name);
    },
  );

  it("supports an optional project override with ADC", async () => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", " existing-project.appspot.com ");
    vi.stubEnv("FIREBASE_PROJECT_ID", " existing-project ");
    const { getStorageBucket } = await loadStorage();
    expect((await getStorageBucket()).name).toBe("existing-project.appspot.com");
    expect(Storage).toHaveBeenCalledWith({ projectId: "existing-project" });
  });

  it.each(["first-line\\nsecond-line", "first-line\nsecond-line"])(
    "uses only explicit server credentials and normalizes PEM newlines (%j)",
    async (key) => {
      vi.stubEnv("FIREBASE_STORAGE_BUCKET", "existing-project.appspot.com");
      vi.stubEnv("FIREBASE_PROJECT_ID", "existing-project");
      vi.stubEnv("FIREBASE_CLIENT_EMAIL", "storage@example.invalid");
      vi.stubEnv("FIREBASE_PRIVATE_KEY", key);
      const { getStorageBucket } = await loadStorage();
      await getStorageBucket();
      expect(Storage).toHaveBeenCalledWith({
        projectId: "existing-project",
        credentials: {
          client_email: "storage@example.invalid",
          private_key: "first-line\nsecond-line",
        },
      });
    },
  );

  it("ignores renamed credentials and bucket when existing variables are configured", async () => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "existing-project.appspot.com");
    vi.stubEnv("FIREBASE_PROJECT_ID", "existing-project");
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "storage@example.invalid");
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "existing-key");
    vi.stubEnv("GCS_BUCKET", "wrong-bucket.invalid");
    vi.stubEnv("GCS_PROJECT_ID", "wrong-project");
    vi.stubEnv("GCS_CLIENT_EMAIL", "wrong-email@example.invalid");
    vi.stubEnv("GCS_PRIVATE_KEY", "wrong-key");
    const { getStorageBucket } = await loadStorage();
    expect((await getStorageBucket()).name).toBe("existing-project.appspot.com");
    expect(Storage).toHaveBeenCalledWith({
      projectId: "existing-project",
      credentials: { client_email: "storage@example.invalid", private_key: "existing-key" },
    });
  });

  it.each(["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"])(
    "rejects incomplete explicit credentials when %s is missing without exposing values",
    async (missing) => {
      vi.stubEnv("FIREBASE_STORAGE_BUCKET", "existing-project.appspot.com");
      vi.stubEnv("FIREBASE_PROJECT_ID", "private-project");
      vi.stubEnv("FIREBASE_CLIENT_EMAIL", "private-email@example.invalid");
      vi.stubEnv("FIREBASE_PRIVATE_KEY", "private-pem");
      vi.stubEnv(missing, "   ");
      const { getStorageBucket } = await loadStorage();
      await expect(getStorageBucket()).rejects.toThrow(/FIREBASE_PROJECT_ID.*FIREBASE_CLIENT_EMAIL.*FIREBASE_PRIVATE_KEY/);
      await expect(getStorageBucket()).rejects.not.toThrow(/private-project|private-email|private-pem/);
      expect(Storage).not.toHaveBeenCalled();
    },
  );

  it("shares one bucket initialization across concurrent requests", async () => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "existing-project.appspot.com");
    const { getStorageBucket } = await loadStorage();
    const [first, second, third] = await Promise.all([
      getStorageBucket(), getStorageBucket(), getStorageBucket(),
    ]);
    expect(first).toBe(second);
    expect(second).toBe(third);
    expect(Storage).toHaveBeenCalledTimes(1);
    expect(bucket).toHaveBeenCalledTimes(1);
  });

  it("can retry after configuration is corrected", async () => {
    const { getStorageBucket } = await loadStorage();
    await expect(getStorageBucket()).rejects.toThrow("FIREBASE_STORAGE_BUCKET is required");
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "existing-project.appspot.com");
    expect((await getStorageBucket()).name).toBe("existing-project.appspot.com");
  });

  it("can retry client initialization without logging provider errors", async () => {
    vi.stubEnv("FIREBASE_STORAGE_BUCKET", "existing-project.appspot.com");
    const errorLog = vi.spyOn(console, "error").mockImplementation(() => {});
    Storage.mockImplementationOnce(function () { throw new Error("private-pem"); });
    const { getStorageBucket } = await loadStorage();
    await expect(getStorageBucket()).rejects.toThrow("private-pem");
    expect((await getStorageBucket()).name).toBe("existing-project.appspot.com");
    expect(errorLog).not.toHaveBeenCalled();
  });
});

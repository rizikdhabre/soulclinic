import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";

const sdk = vi.hoisted(() => ({
  apps: [],
  cert: vi.fn(),
  applicationDefault: vi.fn(),
  initializeApp: vi.fn(),
  getApps: vi.fn(),
  getAuth: vi.fn(),
  auth: { verifyIdToken: vi.fn() },
}));

vi.mock("server-only", () => ({}));
vi.mock("firebase-admin/app", () => ({
  cert: sdk.cert, applicationDefault: sdk.applicationDefault,
  initializeApp: sdk.initializeApp, getApps: sdk.getApps,
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: sdk.getAuth }));

const PROJECT = "soulclinc-production";
const ENV = {
  FIREBASE_PROJECT_ID: PROJECT,
  FIREBASE_CLIENT_EMAIL: "otp@example.invalid",
  FIREBASE_PRIVATE_KEY: "test-only-first-line\\nsecond-line",
};
const load = () => import("@/lib/otp/firebaseAdminAuth");

beforeEach(() => {
  vi.resetModules();
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
  sdk.apps = [];
  sdk.cert.mockReset().mockReturnValue({ kind: "test-certificate" });
  sdk.applicationDefault.mockReset().mockReturnValue({ kind: "test-adc" });
  sdk.getApps.mockReset().mockImplementation(() => sdk.apps);
  sdk.initializeApp.mockReset().mockImplementation((options, name) => {
    const app = { options, name };
    sdk.apps.push(app);
    return app;
  });
  sdk.getAuth.mockReset().mockReturnValue(sdk.auth);
  for (const method of ["log", "warn", "error", "info"]) vi.spyOn(console, method).mockImplementation(() => {});
});

afterEach(() => vi.unstubAllEnvs());

describe("Firebase Admin Auth initialization", () => {
  it("imports lazily without credentials, SDK initialization, or storage access", async () => {
    const authModule = await load();
    expect(authModule.getFirebaseAdminAuth).toBeTypeOf("function");
    expect(sdk.initializeApp).not.toHaveBeenCalled();
    expect(sdk.cert).not.toHaveBeenCalled();
    expect(sdk.getAuth).not.toHaveBeenCalled();
  });

  it("shares one initialization promise and a dedicated named app across concurrent requests", async () => {
    const { getFirebaseAdminAuth } = await load();
    const first = getFirebaseAdminAuth({ env: ENV });
    const second = getFirebaseAdminAuth({ env: ENV });
    expect(first).toBe(second);
    expect(await first).toBe(sdk.auth);
    expect(await second).toBe(sdk.auth);
    expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
    const [options, name] = sdk.initializeApp.mock.calls[0];
    expect(name).toBeTruthy();
    expect(name).not.toBe("[DEFAULT]");
    expect(options).toEqual({ projectId: PROJECT, credential: { kind: "test-certificate" } });
    expect(sdk.getAuth).toHaveBeenCalledExactlyOnceWith(sdk.apps[0]);
  });

  it.each(["test-only-first-line\\nsecond-line", "test-only-first-line\nsecond-line"])(
    "uses the existing explicit credential names and normalizes PEM newlines (%j)", async (privateKey) => {
      const { getFirebaseAdminAuth } = await load();
      await getFirebaseAdminAuth({ env: { ...ENV, FIREBASE_PRIVATE_KEY: privateKey,
        FIREBASE_PROJECT_ID: ` ${PROJECT} `, FIREBASE_CLIENT_EMAIL: " otp@example.invalid " } });
      expect(sdk.cert).toHaveBeenCalledExactlyOnceWith({
        projectId: PROJECT, clientEmail: "otp@example.invalid", privateKey: "test-only-first-line\nsecond-line",
      });
      expect(sdk.applicationDefault).not.toHaveBeenCalled();
    },
  );

  it("allows ADC only when both explicit credential values are absent, retaining the project", async () => {
    const { getFirebaseAdminAuth } = await load();
    await getFirebaseAdminAuth({ env: { FIREBASE_PROJECT_ID: PROJECT } });
    expect(sdk.applicationDefault).toHaveBeenCalledTimes(1);
    expect(sdk.cert).not.toHaveBeenCalled();
    expect(sdk.apps[0].options).toEqual({ projectId: PROJECT, credential: { kind: "test-adc" } });
  });

  it.each(["FIREBASE_PROJECT_ID", "FIREBASE_CLIENT_EMAIL", "FIREBASE_PRIVATE_KEY"])(
    "rejects incomplete configuration missing %s before SDK access", async (missing) => {
      const { getFirebaseAdminAuth } = await load();
      await expect(getFirebaseAdminAuth({ env: { ...ENV, [missing]: " " } })).rejects.toMatchObject({
        name: "OtpError", code: "OTP_SERVICE_NOT_CONFIGURED", status: 503,
      });
      expect(sdk.initializeApp).not.toHaveBeenCalled();
      expect(sdk.cert).not.toHaveBeenCalled();
    },
  );

  it("never uses public or renamed server settings as credential fallbacks", async () => {
    const { getFirebaseAdminAuth } = await load();
    await expect(getFirebaseAdminAuth({ env: {
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT, GCS_PROJECT_ID: PROJECT,
      GCS_CLIENT_EMAIL: ENV.FIREBASE_CLIENT_EMAIL, GCS_PRIVATE_KEY: ENV.FIREBASE_PRIVATE_KEY,
    } })).rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED", status: 503 });
    expect(sdk.initializeApp).not.toHaveBeenCalled();
  });

  it("validates the public project alignment even after initialization was cached", async () => {
    const { getFirebaseAdminAuth, getFirebaseProjectId } = await load();
    expect(getFirebaseProjectId({ ...ENV, NEXT_PUBLIC_FIREBASE_PROJECT_ID: ` ${PROJECT} ` })).toBe(PROJECT);
    await getFirebaseAdminAuth({ env: ENV });
    await expect(getFirebaseAdminAuth({ env: { ...ENV, NEXT_PUBLIC_FIREBASE_PROJECT_ID: "another-project" } }))
      .rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED", status: 503 });
  });

  it("does not return a cached app for a different configured project", async () => {
    const { getFirebaseAdminAuth } = await load();
    await getFirebaseAdminAuth({ env: ENV });
    await expect(getFirebaseAdminAuth({ env: { ...ENV, FIREBASE_PROJECT_ID: "another-project" } }))
      .rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED", status: 503 });
  });

  it("reuses its named app after module reload without adopting the default app", async () => {
    sdk.apps.push({ name: "[DEFAULT]", options: { projectId: "unrelated-project" } });
    await (await load()).getFirebaseAdminAuth({ env: ENV });
    const ownedApp = sdk.apps[1];
    vi.resetModules();
    expect(await (await load()).getFirebaseAdminAuth({ env: ENV })).toBe(sdk.auth);
    expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
    expect(sdk.getAuth).toHaveBeenLastCalledWith(ownedApp);
  });

  it("rejects a conflicting project on its existing named app", async () => {
    await (await load()).getFirebaseAdminAuth({ env: ENV });
    sdk.apps[0].options.projectId = "another-project";
    vi.resetModules();
    await expect((await load()).getFirebaseAdminAuth({ env: ENV }))
      .rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED", status: 503 });
  });

  it("retries after correcting missing configuration", async () => {
    const { getFirebaseAdminAuth } = await load();
    await expect(getFirebaseAdminAuth({ env: {} })).rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED" });
    expect(await getFirebaseAdminAuth({ env: ENV })).toBe(sdk.auth);
  });

  it.each(["cert", "initializeApp", "getAuth"])("retries after %s initialization fails without leaking errors", async (stage) => {
    sdk[stage].mockImplementationOnce(() => { throw Object.assign(new Error("test-only-private-provider-body"), {
      code: stage === "cert" ? "app/invalid-credential" : "app/network-error",
    }); });
    const { getFirebaseAdminAuth } = await load();
    const error = await getFirebaseAdminAuth({ env: ENV }).catch((value) => value);
    expect(error).toMatchObject({ name: "OtpError", status: 503,
      code: stage === "cert" ? "OTP_SERVICE_NOT_CONFIGURED" : "OTP_VERIFY_TEMPORARY_FAILURE" });
    expect(inspect(error)).not.toContain("test-only-private-provider-body");
    expect(await getFirebaseAdminAuth({ env: ENV })).toBe(sdk.auth);
    if (stage === "getAuth") expect(sdk.initializeApp).toHaveBeenCalledTimes(1);
    for (const method of ["log", "warn", "error", "info"]) expect(console[method]).not.toHaveBeenCalled();
  });

  it.each(["injected", "process"])("rejects %s Auth emulator configuration instead of accepting unsigned tokens", async (source) => {
    const env = { ...ENV };
    if (source === "process") vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "127.0.0.1:9099");
    else env.FIREBASE_AUTH_EMULATOR_HOST = "127.0.0.1:9099";
    const { getFirebaseAdminAuth } = await load();
    await expect(getFirebaseAdminAuth({ env })).rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED", status: 503 });
    expect(sdk.getAuth).not.toHaveBeenCalled();
  });
});

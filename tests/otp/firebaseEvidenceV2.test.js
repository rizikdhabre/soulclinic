import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inspect } from "node:util";
import { OtpError } from "@/lib/otp/errors";

const sdk = vi.hoisted(() => ({ verifyIdToken: vi.fn(), initializeApp: vi.fn(), getAuth: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("firebase-admin/app", () => ({
  getApps: () => [], cert: () => ({}), applicationDefault: () => ({}), initializeApp: sdk.initializeApp,
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: sdk.getAuth }));

const PROJECT = "soulclinc-production";
const ENV = { FIREBASE_PROJECT_ID: PROJECT };
const PHONE = "+972500000001";
const NOW = new Date("2026-09-11T10:00:30.500Z");
const NOW_SECONDS = Math.floor(+NOW / 1000);
const TOKEN = "test-only-opaque-id-token";
const challenge = () => ({ phone: PHONE, createdAt: new Date("2026-09-11T10:00:00.900Z"),
  expiresAt: new Date("2026-09-11T10:10:00.900Z") });
const claims = () => ({
  uid: "firebase-phone-user", sub: "firebase-phone-user", aud: PROJECT,
  iss: `https://securetoken.google.com/${PROJECT}`, phone_number: PHONE,
  firebase: { sign_in_provider: "phone", identities: { phone: [PHONE] } },
  auth_time: NOW_SECONDS - 10, iat: NOW_SECONDS - 10, exp: NOW_SECONDS + 3590,
});
const load = () => import("@/lib/otp/firebaseEvidence");
let verifyIdToken;

async function verify(options = {}) {
  return (await load()).verifyFirebaseEvidence(TOKEN, challenge(), { env: ENV, now: NOW, verifyIdToken, ...options });
}

async function expectError(promise, code = "OTP_VERIFICATION_INVALID", status = 401) {
  const error = await promise.catch((value) => value);
  expect(error).toBeInstanceOf(OtpError);
  expect(error).toMatchObject({ name: "OtpError", code, status });
  expect(inspect(error)).not.toMatch(/test-only-|\+972500000001|firebase-phone-user/);
  expect(error.cause).toBeUndefined();
}

beforeEach(() => {
  vi.stubEnv("FIREBASE_AUTH_EMULATOR_HOST", "");
  verifyIdToken = vi.fn().mockResolvedValue(claims());
  sdk.initializeApp.mockReset().mockImplementation((options, name) => ({ options, name }));
  sdk.verifyIdToken.mockReset().mockResolvedValue(claims());
  sdk.getAuth.mockReset().mockReturnValue({ verifyIdToken: sdk.verifyIdToken });
  for (const method of ["log", "info", "warn", "error"]) vi.spyOn(console, method).mockImplementation(() => {});
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe("Firebase signed phone evidence", () => {
  it("requires SDK verification with revocation checks and returns only bounded identity evidence", async () => {
    verifyIdToken.mockResolvedValue({ ...claims(), email: "test-only-private-email", unrelated: { token: TOKEN } });
    expect(await verify()).toEqual({ uid: "firebase-phone-user", authTime: NOW_SECONDS - 10 });
    expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith(TOKEN, true);
    expect(sdk.getAuth).not.toHaveBeenCalled();
  });

  it("defaults to the named Admin Auth verifier without decoding tokens locally", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    vi.stubEnv("FIREBASE_PROJECT_ID", PROJECT);
    vi.stubEnv("NEXT_PUBLIC_FIREBASE_PROJECT_ID", "");
    vi.stubEnv("FIREBASE_CLIENT_EMAIL", "");
    vi.stubEnv("FIREBASE_PRIVATE_KEY", "");
    const { verifyFirebaseEvidence } = await load();
    expect(await verifyFirebaseEvidence(TOKEN, challenge())).toEqual({ uid: "firebase-phone-user", authTime: NOW_SECONDS - 10 });
    expect(sdk.verifyIdToken).toHaveBeenCalledExactlyOnceWith(TOKEN, true);
  });

  it("propagates a default Admin SDK rejection without returning decoded evidence", async () => {
    sdk.verifyIdToken.mockRejectedValue(Object.assign(new Error("test-only-revoked"), { code: "auth/id-token-revoked" }));
    await expectError(verify({ verifyIdToken: undefined }));
  });

  it.each([undefined, null, "", " ", 123, {}, "a".repeat(16385)])("rejects malformed or oversized token input (%#) before SDK access", async (token) => {
    await expectError((await load()).verifyFirebaseEvidence(token, challenge(), { env: ENV, now: NOW, verifyIdToken }));
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each(["password", "custom", "anonymous", "google.com", undefined, null])("rejects non-phone sign-in provider %j even with a phone claim", async (provider) => {
    verifyIdToken.mockResolvedValue({ ...claims(), firebase: { sign_in_provider: provider } });
    await expectError(verify());
  });

  it.each(["uid", "sub", "aud", "iss", "phone_number", "firebase", "auth_time", "iat", "exp"])("rejects missing %s", async (claim) => {
    const decoded = claims();
    delete decoded[claim];
    verifyIdToken.mockResolvedValue(decoded);
    await expectError(verify());
  });

  it.each([null, undefined, "decoded", [], {}])("rejects malformed decoded claims (%j)", async (decoded) => {
    verifyIdToken.mockResolvedValue(decoded);
    await expectError(verify());
  });

  it.each([
    ["aud", "another-project"], ["aud", [PROJECT]], ["iss", `https://securetoken.google.com/${PROJECT}/`],
    ["iss", "https://securetoken.google.com/another-project"], ["sub", "another-user"],
    ["uid", ""], ["uid", "u".repeat(129)], ["uid", 123],
    ["phone_number", "+972500000002"], ["phone_number", "0500000001"],
    ["phone_number", `${PHONE} `], ["phone_number", { toString: () => PHONE }],
  ])("rejects mismatched or unbounded %s (%#)", async (claim, value) => {
    verifyIdToken.mockResolvedValue({ ...claims(), [claim]: value });
    await expectError(verify());
  });

  it("accepts the maximum Firebase UID length but copies no extra claims", async () => {
    verifyIdToken.mockResolvedValue({ ...claims(), uid: "u".repeat(128), sub: "u".repeat(128) });
    expect(await verify()).toEqual({ uid: "u".repeat(128), authTime: NOW_SECONDS - 10 });
  });

  it.each(["0500000001", `${PHONE} `, null, 972500000001])("rejects a noncanonical stored phone (%j)", async (phone) => {
    await expectError((await load()).verifyFirebaseEvidence(TOKEN, { ...challenge(), phone }, { env: ENV, now: NOW, verifyIdToken }));
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([undefined, null, "", "other-project", [PROJECT]])("fails configuration when public project is mismatched or invalid (%#)", async (publicProject) => {
    if (publicProject === undefined || publicProject === null || publicProject === "") {
      expect(await verify({ env: { ...ENV, NEXT_PUBLIC_FIREBASE_PROJECT_ID: publicProject } })).toHaveProperty("uid");
    } else {
      await expectError(verify({ env: { ...ENV, NEXT_PUBLIC_FIREBASE_PROJECT_ID: publicProject } }), "OTP_SERVICE_NOT_CONFIGURED", 503);
      expect(verifyIdToken).not.toHaveBeenCalled();
    }
  });

  it.each([undefined, "", " ", "bad/project", 123])("requires an explicit valid server project (%j)", async (project) => {
    await expectError(verify({ env: { FIREBASE_PROJECT_ID: project, NEXT_PUBLIC_FIREBASE_PROJECT_ID: PROJECT } }), "OTP_SERVICE_NOT_CONFIGURED", 503);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("rejects emulator mode even with an injected verifier", async () => {
    await expectError(verify({ env: { ...ENV, FIREBASE_AUTH_EMULATOR_HOST: "127.0.0.1:9099" } }), "OTP_SERVICE_NOT_CONFIGURED", 503);
    expect(verifyIdToken).not.toHaveBeenCalled();
  });
});

describe("Firebase authentication freshness", () => {
  it.each(["auth_time", "iat", "exp"])("rejects invalid numeric %s claims", async (claim) => {
    for (const value of [null, "123", NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      verifyIdToken.mockResolvedValue({ ...claims(), [claim]: value });
      await expectError(verify());
    }
  });

  it("allows the challenge creation second without any backward second slop", async () => {
    verifyIdToken.mockResolvedValue({ ...claims(), auth_time: NOW_SECONDS - 30 });
    expect(await verify()).toEqual({ uid: "firebase-phone-user", authTime: NOW_SECONDS - 30 });
    verifyIdToken.mockResolvedValue({ ...claims(), auth_time: NOW_SECONDS - 31 });
    await expectError(verify());
  });

  it("does not accept a refreshed token whose authentication predates a new challenge", async () => {
    expect(await verify()).toHaveProperty("uid");
    verifyIdToken.mockResolvedValue({ ...claims(), iat: NOW_SECONDS });
    await expectError((await load()).verifyFirebaseEvidence(TOKEN, { ...challenge(), createdAt: new Date(+NOW - 5000) },
      { env: ENV, now: NOW, verifyIdToken }));
    expect(verifyIdToken).toHaveBeenCalledTimes(2);
  });

  it("limits future authentication and issuance to 30 seconds of clock skew", async () => {
    verifyIdToken.mockResolvedValue({ ...claims(), auth_time: NOW_SECONDS + 30, iat: NOW_SECONDS + 30 });
    expect(await verify()).toHaveProperty("authTime", NOW_SECONDS + 30);
    for (const claim of ["auth_time", "iat"]) {
      verifyIdToken.mockResolvedValue({ ...claims(), [claim]: NOW_SECONDS + 31 });
      await expectError(verify());
    }
  });

  it("rejects authentication after token issuance", async () => {
    verifyIdToken.mockResolvedValue({ ...claims(), auth_time: NOW_SECONDS, iat: NOW_SECONDS - 1 });
    await expectError(verify());
  });

  it("rejects an expired verified token at the exact second boundary", async () => {
    verifyIdToken.mockResolvedValue({ ...claims(), exp: NOW_SECONDS });
    await expectError(verify(), "OTP_VERIFICATION_EXPIRED");
  });

  it("rejects non-increasing token lifetime", async () => {
    verifyIdToken.mockResolvedValue({ ...claims(), iat: NOW_SECONDS + 10, exp: NOW_SECONDS + 10 });
    await expectError(verify());
  });

  it("caps authentication age at the ten-minute challenge lifetime independently of token expiry", async () => {
    const oldChallenge = { ...challenge(), createdAt: new Date(+NOW - 700000), expiresAt: new Date(+NOW + 10000) };
    verifyIdToken.mockResolvedValue({ ...claims(), auth_time: NOW_SECONDS - 601 });
    await expectError((await load()).verifyFirebaseEvidence(TOKEN, oldChallenge, { env: ENV, now: NOW, verifyIdToken }), "OTP_VERIFICATION_EXPIRED");
    verifyIdToken.mockResolvedValue({ ...claims(), auth_time: NOW_SECONDS - 600 });
    expect(await (await load()).verifyFirebaseEvidence(TOKEN, oldChallenge, { env: ENV, now: NOW, verifyIdToken })).toHaveProperty("authTime", NOW_SECONDS - 600);
  });

  it("rejects expired challenges before contacting Firebase", async () => {
    await expectError((await load()).verifyFirebaseEvidence(TOKEN, { ...challenge(), expiresAt: NOW }, { env: ENV, now: NOW, verifyIdToken }), "OTP_VERIFICATION_EXPIRED");
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    null, {}, { ...challenge(), createdAt: "2026-09-11" }, { ...challenge(), createdAt: new Date(NaN) },
    { ...challenge(), createdAt: new Date(+NOW + 1) }, { ...challenge(), expiresAt: new Date(NaN) },
    { ...challenge(), expiresAt: challenge().createdAt },
  ])("rejects malformed challenge timestamps (%#)", async (stored) => {
    await expectError((await load()).verifyFirebaseEvidence(TOKEN, stored, { env: ENV, now: NOW, verifyIdToken }));
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it("accepts an explicit millisecond clock as well as a Date", async () => {
    expect(await verify({ now: +NOW })).toHaveProperty("authTime", NOW_SECONDS - 10);
  });
});

describe("Firebase verification failure classification", () => {
  it.each(["auth/invalid-id-token", "auth/id-token-revoked", "auth/user-disabled", "auth/user-not-found", "auth/tenant-id-mismatch"])(
    "classifies %s as invalid evidence, not an infrastructure failure", async (code) => {
      verifyIdToken.mockRejectedValue(Object.assign(new Error("test-only-private-provider-body"), { code }));
      await expectError(verify());
    },
  );

  it.each([
    "Firebase ID token has invalid signature.", "Firebase ID token has no \"kid\" claim.",
    "Firebase ID token has incorrect algorithm.", "Firebase ID token has incorrect \"aud\" (audience) claim.",
    "Firebase ID token has incorrect \"iss\" (issuer) claim.", "Firebase ID token has no \"sub\" (subject) claim.",
    "Firebase ID token has an empty \"sub\" (subject) claim.", "Firebase ID token has a \"sub\" (subject) claim longer than 128 characters.",
    "Firebase ID token has \"kid\" claim which does not correspond to a known public key.",
    "Decoding Firebase ID token failed.", "verifyIdToken() expects an ID token, but was given a custom token.",
    "verifyIdToken() expects an ID token, but was given a legacy custom token.",
  ])("recognizes definitive SDK argument rejection: %s", async (message) => {
    verifyIdToken.mockRejectedValue(Object.assign(new Error(message), { code: "auth/argument-error" }));
    await expectError(verify());
  });

  it("maps SDK expiration separately from invalid evidence", async () => {
    verifyIdToken.mockRejectedValue(Object.assign(new Error("test-only-expired-token"), { code: "auth/id-token-expired" }));
    await expectError(verify(), "OTP_VERIFICATION_EXPIRED");
  });

  it.each([
    "auth/invalid-credential", "auth/insufficient-permission", "auth/project-not-found", "auth/invalid-config",
    "app/invalid-credential", "app/invalid-app-options",
  ])("maps %s to service configuration without leaking SDK details", async (code) => {
    verifyIdToken.mockRejectedValue(Object.assign(new Error("test-only-private-credential"), { code }));
    await expectError(verify(), "OTP_SERVICE_NOT_CONFIGURED", 503);
  });

  it.each([
    { code: "app/network-error" }, { code: "app/network-timeout" }, { code: "auth/internal-error" },
    { code: "auth/quota-exceeded" }, { code: "auth/too-many-requests" },
    { code: "ENOTFOUND" }, { code: "ECONNRESET" }, { code: "ETIMEDOUT" },
    { code: "auth/argument-error", message: "Error fetching public keys for Google certs: service unavailable" },
    { code: "auth/argument-error", message: "Error while making request: getaddrinfo ENOTFOUND www.googleapis.com. Error code: ENOTFOUND" },
    { code: "auth/argument-error", message: "Error while making request: socket hang up. Error code: ECONNRESET" },
    { code: "auth/argument-error", message: "Error fetching Json Web Keys: network failure" },
    { code: "auth/argument-error", message: "unrecognized certificate failure" },
    { code: "auth/invalid-argument", message: "unrecognized certificate failure" },
    { code: "auth/argument-error", message: "certificate has expired" },
    { status: 503 }, { cause: { code: "ECONNRESET" } }, {},
    { code: "app/invalid-credential", cause: { code: "ENOTFOUND" } },
    { code: "app/invalid-credential", cause: { response: { status: 503 } } },
    { code: "app/invalid-credential", cause: { cause: { code: "ETIMEDOUT" } } },
    { code: "app/invalid-credential", cause: { response: { status: 429 } } },
  ])("keeps certificate/network/revocation-service failures retryable (%#)", async (fields) => {
    verifyIdToken.mockRejectedValue(Object.assign(new Error("test-only-private-provider-body"), fields));
    await expectError(verify(), "OTP_VERIFY_TEMPORARY_FAILURE", 503);
    expect(verifyIdToken).toHaveBeenCalledExactlyOnceWith(TOKEN, true);
    for (const method of ["log", "info", "warn", "error"]) expect(console[method]).not.toHaveBeenCalled();
  });

  it("bounds cyclic credential failure inspection while retaining configuration failures", async () => {
    const error = Object.assign(new Error("test-only-private-credential"), { code: "app/invalid-credential" });
    error.cause = error;
    verifyIdToken.mockRejectedValue(error);
    await expectError(verify(), "OTP_SERVICE_NOT_CONFIGURED", 503);
  });

  it.each(["OTP_SERVICE_NOT_CONFIGURED", "OTP_VERIFY_TEMPORARY_FAILURE"])("sanitizes already-classified %s failures", async (code) => {
    verifyIdToken.mockRejectedValue(new OtpError(code, 503, "test-only-sensitive-message"));
    await expectError(verify(), code, 503);
  });
});

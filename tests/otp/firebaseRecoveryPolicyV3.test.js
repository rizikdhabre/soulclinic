import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyFirebaseSendFailure } from "@/lib/otp/firebaseSendPolicy";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { requestFirebaseSend, requestFirebaseFallback } from "@/lib/otp/firebaseSend";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { hashBearerToken } from "@/lib/otp/crypto";
import { OtpError } from "@/lib/otp/errors";
import { MemoryMongoCollection } from "../helpers/memoryOtpStores";

vi.mock("server-only", () => ({}));
afterEach(() => vi.restoreAllMocks());
const phone = "+972500000001";
const report = (code, stage, provenance = "firebase_sdk") => ({ code, stage, provenance });
const missing = report("client/sms-not-received", "delivery", "client");

async function fixture() {
  vi.spyOn(console, "info").mockImplementation(() => {});
  let now = new Date("2026-09-17T10:00:00Z");
  const collection = new MemoryMongoCollection();
  const store = createOtpChallengeStore({ collection });
  const deps = { env: { NODE_ENV: "test", OTP_PROVIDER_MODE: "firebase_first", CUSTOMER_SESSION_SECRET: "s".repeat(48) },
    clock: { now: () => now }, challengeStore: store, deriveSourceHash: () => "source-one",
    rateStore: { claimSourceAction: vi.fn(), claimPhoneStart: vi.fn(async () => ({ retryAt: new Date(+now + 60000).toISOString() })), claimGlobalSend: vi.fn(), reservePhoneVerifyAttempt: vi.fn() },
    sendVerification: vi.fn(async () => ({ sid: `VE${"a".repeat(32)}`, status: "pending", to: phone, channel: "sms" })),
    verifyFirebaseEvidence: vi.fn(async () => ({ uid: "test", authTime: Math.floor(+now / 1000) })),
  };
  const challenge = await createOtpChallenge({ phone, purpose: "login" }, deps);
  const input = { challengeToken: challenge.challengeToken, purpose: "login" };
  const { firebaseSendId } = await requestFirebaseSend({ ...input, operation: "reserve" }, deps);
  const accepted = () => requestFirebaseSend({ ...input, firebaseSendId, operation: "accepted" }, deps);
  const fallback = (failure) => requestFirebaseFallback({ ...input, firebaseSendId, failure }, deps);
  const current = () => store.findByTokenHash(hashBearerToken(input.challengeToken));
  return { deps, input, firebaseSendId, accepted, fallback, current, advance: ms => { now = new Date(+now + ms); } };
}

describe("bounded technical Firebase recovery", () => {
  it.each([
    ["client/module-load-failed", "initialize", "client"],
    ["auth/internal-error", "initialize", "firebase_sdk"],
    ["auth/network-request-failed", "initialize", "firebase_sdk"],
    ["auth/internal-error", "recaptcha_render", "firebase_sdk"],
    ["auth/timeout", "send", "firebase_sdk"],
    ["auth/network-request-failed", "confirm", "firebase_sdk"],
    ["auth/internal-error", "confirm", "firebase_sdk"],
    ["auth/network-request-failed", "token", "firebase_sdk"],
    ["client/sms-not-received", "delivery", "client"],
  ])("allows identified %s at %s", (code, stage, provenance) => {
    expect(classifyFirebaseSendFailure(report(code, stage, provenance)).eligible).toBe(true);
  });
  it.each(["auth/too-many-requests", "auth/code-expired", "auth/invalid-verification-code", "auth/user-disabled", "auth/captcha-check-failed", "auth/quota-exceeded", "auth/unauthorized-domain", "client/unclassified", "client/operation-pending"])("keeps %s blocked at every recovery stage", (code) => {
    for (const stage of ["initialize", "send", "confirm", "token", "delivery"]) expect(classifyFirebaseSendFailure(report(code, stage)).eligible).toBe(false);
  });
  it("does not reinterpret ChunkLoadError after sending as a module-load failure", () => {
    for (const stage of ["send", "confirm", "token"]) expect(classifyFirebaseSendFailure(report("client/module-load-failed", stage, "client")).eligible).toBe(false);
  });
  it("transfers an accepted challenge on technical confirmation failure exactly once, rejects Firebase proof afterward", async () => {
    const f = await fixture(); await f.accepted();
    const failure = report("auth/network-request-failed", "confirm");
    const results = await Promise.allSettled([f.fallback(failure), f.fallback(failure)]);
    expect(results.some(r => r.status === "fulfilled")).toBe(true);
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
    expect(f.deps.rateStore.claimPhoneStart).toHaveBeenCalledTimes(1);
    await expect(f.fallback(failure)).resolves.toMatchObject({ provider: "twilio", status: "pending" });
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
    await expect(completeOtpChallenge({ ...f.input, idToken: "mock-signed-firebase-token" }, f.deps)).rejects.toHaveProperty("code");
    expect(f.deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
  });
  it("does not accept a confirmation failure without send acceptance", async () => {
    const f = await fixture();
    await expect(f.fallback(report("auth/network-request-failed", "confirm"))).rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });
  it("non-receipt obeys server cooldown then reuses the same paid dispatch on recovery", async () => {
    const f = await fixture(); await f.accepted();
    await expect(f.fallback(missing)).rejects.toHaveProperty("code", "OTP_RATE_LIMITED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
    expect((await f.current()).provider).toBe("firebase");
    f.advance(60001);
    await expect(f.fallback(missing)).resolves.toMatchObject({ provider: "twilio" });
    await f.fallback(missing);
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });
  it.each(["auth/invalid-verification-code", "auth/code-expired", "auth/too-many-requests", "auth/user-disabled"])("a reported %s prevents a later non-receipt claim", async (code) => {
    const f = await fixture(); await f.accepted(); f.advance(60001);
    await requestFirebaseSend({ ...f.input, firebaseSendId: f.firebaseSendId, operation: "diagnostic", failure: report(code, "confirm") }, f.deps);
    await expect(f.fallback(missing)).rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });
  it("paid SMS limits still apply to post-send switching", async () => {
    const f = await fixture(); await f.accepted();
    f.deps.rateStore.claimGlobalSend.mockRejectedValue(new OtpError("OTP_SEND_BUDGET_EXCEEDED", 429, "test"));
    await expect(f.fallback(report("auth/internal-error", "confirm"))).rejects.toHaveProperty("code", "OTP_SEND_BUDGET_EXCEEDED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });
  it("retains a security block even when the diagnostic history is full", async () => {
    const f = await fixture(); await f.accepted(); f.advance(60001);
    const diagnose = failure => requestFirebaseSend({ ...f.input, firebaseSendId: f.firebaseSendId, operation: "diagnostic", failure }, f.deps);
    for (const stage of ["confirm", "token"]) for (const code of ["auth/internal-error", "auth/network-request-failed", "auth/timeout"]) await diagnose(report(code, stage));
    expect((await f.current()).firebaseClientFailures).toHaveLength(6);
    await diagnose(report("auth/user-disabled", "confirm"));
    expect((await f.current()).firebaseRecoveryBlocked).toBe(true);
    expect((await f.current()).firebaseClientFailures).toHaveLength(6);
    await expect(f.fallback(missing)).rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });
  it("a forged server-verification report cannot trigger fallback", async () => {
    const f = await fixture(); await f.accepted();
    await expect(f.fallback(report("server/firebase-verification-unavailable", "server_verify", "server"))).rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });
  it("in-flight Admin verification fences fallback and completed approval can never be superseded", async () => {
    const f = await fixture(); await f.accepted();
    let release;
    f.deps.verifyFirebaseEvidence.mockImplementation(() => new Promise(resolve => { release = resolve; }));
    const completing = completeOtpChallenge({ ...f.input, idToken: "mock-signed-firebase-token" }, f.deps);
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(f.fallback(report("auth/internal-error", "confirm"))).rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    release({ uid: "test", authTime: Math.floor(+f.deps.clock.now() / 1000) });
    await completing;
    await expect(f.fallback(report("auth/internal-error", "confirm"))).rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });
  it("a saved post-send Twilio acceptance survives a lost response without another SMS", async () => {
    const f = await fixture(); await f.accepted();
    const failure = report("auth/internal-error", "token");
    await f.fallback(failure);
    await f.fallback(failure);
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
    expect(f.deps.rateStore.claimGlobalSend).toHaveBeenCalledTimes(1);
  });
  it("known settled Admin infrastructure failure can transfer, but approval cannot", async () => {
    const f = await fixture(); await f.accepted();
    f.deps.verifyFirebaseEvidence.mockRejectedValue(Object.assign(new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "test"), { firebaseTechnicalFailure: true }));
    await expect(completeOtpChallenge({ ...f.input, idToken: "mock-signed-firebase-token" }, f.deps)).rejects.toHaveProperty("code", "OTP_VERIFY_TEMPORARY_FAILURE");
    await expect(f.fallback(report("server/firebase-verification-unavailable", "server_verify", "server"))).resolves.toMatchObject({ provider: "twilio" });
    expect(f.deps.sendVerification).toHaveBeenCalledTimes(1);
  });
  it("a server evidence rejection stays blocked after a later infrastructure failure", async () => {
    const f = await fixture(); await f.accepted();
    f.deps.verifyFirebaseEvidence.mockRejectedValueOnce(new OtpError("OTP_VERIFICATION_INVALID", 401, "test"));
    await completeOtpChallenge({ ...f.input, idToken: "mock-signed-firebase-token" }, f.deps).catch(() => {});
    f.deps.verifyFirebaseEvidence.mockRejectedValue(Object.assign(new OtpError("OTP_VERIFY_TEMPORARY_FAILURE", 503, "test"), { firebaseTechnicalFailure: true }));
    const error = await completeOtpChallenge({ ...f.input, idToken: "mock-signed-firebase-token" }, f.deps).catch(error => error);
    expect(error.firebaseFallbackAllowed).not.toBe(true);
    await expect(f.fallback(report("server/firebase-verification-unavailable", "server_verify", "server"))).rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    expect(f.deps.sendVerification).not.toHaveBeenCalled();
  });
});

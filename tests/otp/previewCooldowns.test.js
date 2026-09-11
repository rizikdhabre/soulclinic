import { describe, expect, it, vi } from "vitest";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import { createOtpChallengeService } from "@/lib/otp/challengeService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { createPhoneOtpController } from "@/hooks/usePhoneOtp";
import { createTestClock, MemoryMongoCollection, MemoryVersionedCollection } from "../helpers/memoryOtpStores";

const PHONE = "+972521234567";
const PREVIEW = { VERCEL_ENV: "preview", VERCEL_GIT_COMMIT_REF: "codex/firebase-first-otp-v2" };

function harness(env = PREVIEW) {
  const clock = createTestClock();
  const phoneCollection = new MemoryVersionedCollection("phone");
  const sourceCollection = new MemoryVersionedCollection("sourceHash");
  const options = { phoneCollection, sourceCollection, clock, env };
  return { ...options, store: createOtpRateLimitStore(options) };
}

describe("feature Preview request cooldown exception", () => {
  it("allows repeated phone/shared-source sends without clearing existing production limit state", async () => {
    const h = harness();
    const normal = createOtpRateLimitStore({ ...h, env: {} });
    await normal.claimPhoneStart(PHONE);
    for (let i = 0; i < 10; i += 1) await normal.claimSourceAction("shared-source", "challenge");
    for (let i = 0; i < 5; i += 1) await normal.claimSourceAction("shared-source", "send");
    const before = structuredClone([h.phoneCollection.documents, h.sourceCollection.documents]);
    for (let i = 0; i < 12; i += 1) {
      await expect(h.store.claimPhoneStart(PHONE)).resolves.toMatchObject({
        retryAt: "2026-08-23T12:00:00.000Z", retryAfterSeconds: 0,
      });
      await expect(h.store.claimSourceAction("shared-source", "challenge")).resolves.toBeUndefined();
      await expect(h.store.claimSourceAction("shared-source", "send")).resolves.toBeUndefined();
    }
    expect([h.phoneCollection.documents, h.sourceCollection.documents]).toEqual(before);
    await expect(normal.claimPhoneStart(PHONE)).rejects.toMatchObject({ code: "OTP_RATE_LIMITED" });
  });

  it.each([
    {},
    { ...PREVIEW, VERCEL_ENV: "production" },
    { ...PREVIEW, VERCEL_ENV: "development" },
    { ...PREVIEW, VERCEL_GIT_COMMIT_REF: "main" },
    { VERCEL_ENV: "preview" },
  ])("keeps phone and source restrictions outside the exact feature Preview (%#)", async (env) => {
    const { store } = harness(env);
    await store.claimPhoneStart(PHONE);
    await expect(store.claimPhoneStart(PHONE)).rejects.toMatchObject({ code: "OTP_RATE_LIMITED" });
    for (let i = 0; i < 5; i += 1) await store.claimSourceAction("shared-source", "send");
    await expect(store.claimSourceAction("shared-source", "send")).rejects.toMatchObject({ code: "OTP_SEND_SOURCE_RATE_LIMITED" });
  });

  it("still enforces paid SMS budgets and wrong-code limits", async () => {
    const { store } = harness({ ...PREVIEW, OTP_GLOBAL_SEND_HOUR_LIMIT: "1", OTP_GLOBAL_SEND_DAY_LIMIT: "1" });
    await store.claimGlobalSend();
    await expect(store.claimGlobalSend()).rejects.toMatchObject({ code: "OTP_SEND_BUDGET_EXCEEDED" });
    for (let i = 0; i < 5; i += 1) await store.reservePhoneVerifyAttempt(PHONE, `verify-${i}`);
    await expect(store.reservePhoneVerifyAttempt(PHONE, "verify-next")).rejects.toMatchObject({ code: "OTP_VERIFY_RATE_LIMITED" });
  });

  it.each(["login", "booking"])("returns zero cooldown through the real %s challenge/controller flow", async (purpose) => {
    const h = harness();
    const collection = new MemoryMongoCollection();
    const service = createOtpChallengeService({
      env: { ...PREVIEW, CUSTOMER_SESSION_SECRET: "s".repeat(48), OTP_PROVIDER_MODE: "firebase_first" },
      clock: h.clock, rateStore: h.store, challengeStore: createOtpChallengeStore({ collection }),
      deriveSourceHash: async () => "shared-source",
    });
    const api = {
      challenge: (input) => service.create(input),
      firebaseSend: async ({ operation }) => ({ provider: "firebase", phone: PHONE,
        firebaseSendId: "11111111-1111-4111-8111-111111111111", status: operation === "reserve" ? "reserved" : "pending" }),
      complete: vi.fn(),
    };
    const controller = createPhoneOtpController({ purpose, api, now: () => +h.clock.now(),
      firebaseClient: { send: async () => ({ confirm: vi.fn() }), clearConfirmation: vi.fn() } });
    try {
      await expect(controller.start(PHONE)).resolves.toMatchObject({ started: true, provider: "firebase" });
      expect(controller.getSnapshot()).toMatchObject({ smsSent: true, cooldownSeconds: 0 });
      await expect(controller.resend(PHONE)).resolves.toMatchObject({ started: true, provider: "firebase" });
      expect(controller.getSnapshot()).toMatchObject({ smsSent: true, cooldownSeconds: 0, error: null });
      expect(collection.documents).toHaveLength(2);
      expect(collection.documents[0].challengeTokenHash).not.toBe(collection.documents[1].challengeTokenHash);
      expect(api.complete).not.toHaveBeenCalled();
    } finally { controller.dispose(); }
  });
});

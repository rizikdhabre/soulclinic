import { expect, it, vi } from "vitest";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { requestTwilioFallback } from "@/lib/otp/twilioFallback";
import { createTestClock, MemoryMongoCollection, MemoryVersionedCollection } from "../helpers/memoryOtpStores";

const { getCollection } = vi.hoisted(() => ({ getCollection: vi.fn() }));
vi.mock("@/lib/db", () => ({ getCollection }));

it("propagates deps.env and its clock into internally created challenge and fallback rate stores", async () => {
  const clock = createTestClock();
  const collections = {
    otpSecurityState: new MemoryVersionedCollection("phone"),
    otpSourceSecurityState: new MemoryVersionedCollection("sourceHash"),
    otpChallenges: new MemoryMongoCollection(),
  };
  getCollection.mockImplementation(async (name) => {
    if (!collections[name]) throw new Error("Unexpected collection");
    return collections[name];
  });
  const sendVerification = vi.fn().mockResolvedValue({ status: "pending" });
  const deps = {
    clock, sendVerification,
    deriveSourceHash: () => "shared-test-source",
    env: { NODE_ENV: "test", OTP_SOURCE_CHALLENGE_SHORT_LIMIT: "12", OTP_SOURCE_FALLBACK_SHORT_LIMIT: "6" },
  };
  for (let index = 0; index < 12; index += 1) {
    const challenge = await createOtpChallenge({ phone: `05212345${String(index).padStart(2, "0")}`, purpose: "booking" }, deps);
    expect(challenge.retryAt).toBe("2026-08-23T12:01:00.000Z");
    if (index > 6) continue;
    const fallback = requestTwilioFallback({ challengeToken: challenge.challengeToken, firebaseErrorCode: "auth/internal-error" }, deps);
    if (index < 6) await expect(fallback).resolves.toMatchObject({ provider: "twilio" });
    else await expect(fallback).rejects.toMatchObject({ code: "OTP_FALLBACK_SOURCE_RATE_LIMITED", restrictionScope: "source" });
  }
  await expect(createOtpChallenge({ phone: "0521234567", purpose: "booking" }, deps)).rejects.toMatchObject({
    code: "OTP_SOURCE_RATE_LIMITED", retryAt: "2026-08-23T12:10:00.000Z", restrictionScope: "source",
  });
  expect(sendVerification).toHaveBeenCalledTimes(6);
  expect(collections.otpSourceSecurityState.documents[0]).toMatchObject({ challengeShortCount: 12, fallbackShortCount: 6 });
});

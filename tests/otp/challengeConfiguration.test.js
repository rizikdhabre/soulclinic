import { beforeEach, describe, expect, it, vi } from "vitest";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { requestTwilioSend } from "@/lib/otp/twilioSend";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { createTestClock, MemoryMongoCollection, MemoryVersionedCollection } from "../helpers/memoryOtpStores";

const { getCollection } = vi.hoisted(() => ({ getCollection: vi.fn() }));
vi.mock("@/lib/db", () => ({ getCollection }));

const SECRET = "s".repeat(48);

beforeEach(() => {
  getCollection.mockReset();
  getCollection.mockRejectedValue(new Error("Unexpected database access"));
  vi.spyOn(console, "info").mockImplementation(() => {});
});

it("propagates the injected env and clock into internally resolved challenge and send stores", async () => {
  const clock = createTestClock();
  const collections = {
    otpSecurityState: new MemoryVersionedCollection("phone"),
    otpSourceSecurityState: new MemoryVersionedCollection("sourceHash"),
    otpChallengesV2: new MemoryMongoCollection(),
  };
  getCollection.mockImplementation(async (name) => {
    if (!collections[name]) throw new Error(`Unexpected collection: ${name}`);
    return collections[name];
  });
  const sendVerification = vi.fn(async (phone) => ({
    sid: `VE${"a".repeat(32)}`, status: "pending", to: phone, channel: "sms",
  }));
  const deps = {
    clock, sendVerification, deriveSourceHash: () => "shared-test-source",
    env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: SECRET, OTP_SOURCE_CHALLENGE_SHORT_LIMIT: "12", OTP_SOURCE_SEND_SHORT_LIMIT: "6" },
  };
  for (let index = 0; index < 12; index += 1) {
    const challenge = await createOtpChallenge({ phone: `05212345${String(index).padStart(2, "0")}`, purpose: "booking" }, deps);
    expect(challenge.retryAt).toBe("2026-08-23T12:01:00.000Z");
    if (index > 6) continue;
    const send = requestTwilioSend({ challengeToken: challenge.challengeToken, purpose: "booking" }, deps);
    if (index < 6) await expect(send).resolves.toEqual({ provider: "twilio", status: "pending" });
    else await expect(send).rejects.toMatchObject({
      code: "OTP_SEND_SOURCE_RATE_LIMITED", status: 429, restrictionScope: "source",
      retryAt: "2026-08-23T12:10:00.000Z", phoneRetryAt: "2026-08-23T12:01:00.000Z",
    });
  }
  await expect(createOtpChallenge({ phone: "0521234567", purpose: "booking" }, deps)).rejects.toMatchObject({
    code: "OTP_SOURCE_RATE_LIMITED", retryAt: "2026-08-23T12:10:00.000Z", restrictionScope: "source",
  });
  expect(sendVerification).toHaveBeenCalledTimes(6);
  expect(collections.otpSourceSecurityState.documents.find((entry) => entry.sourceHash === "shared-test-source"))
    .toMatchObject({ challengeShortCount: 12, sendShortCount: 6 });
  expect(collections.otpChallengesV2.documents).toHaveLength(12);
  expect(getCollection.mock.calls.every(([name]) => Object.hasOwn(collections, name))).toBe(true);
});

describe.each([
  ["challenge", createOtpChallenge], ["send", requestTwilioSend], ["complete", completeOtpChallenge],
])("%s configuration guard", (_name, operation) => {
  it.each([undefined, null, "", "s".repeat(31), 12345, {}])(
    "rejects invalid session secret %j before any external work", async (secret) => {
      const deps = {
        env: { NODE_ENV: "test", CUSTOMER_SESSION_SECRET: secret, OTP_DEV_CODE: "654321" },
        clock: createTestClock(), deriveSourceHash: vi.fn(),
        rateStore: { claimSourceAction: vi.fn(), claimPhoneStart: vi.fn(), reservePhoneVerifyAttempt: vi.fn() },
        challengeStore: { create: vi.fn(), findByTokenHash: vi.fn(), transition: vi.fn() },
        sendVerification: vi.fn(), verifyTwilioCode: vi.fn(),
        usersData: { findOne: vi.fn() }, signCustomerSession: vi.fn(), issueBookingGrant: vi.fn(),
      };
      await expect(operation({ phone: "+972521234567", purpose: "booking", challengeToken: "a".repeat(43), code: "654321" }, deps))
        .rejects.toMatchObject({ code: "OTP_SERVICE_NOT_CONFIGURED", status: 503 });
      for (const fn of [deps.deriveSourceHash, deps.sendVerification, deps.verifyTwilioCode, deps.signCustomerSession,
        deps.issueBookingGrant, deps.usersData.findOne, ...Object.values(deps.rateStore), ...Object.values(deps.challengeStore)]) {
        expect(fn).not.toHaveBeenCalled();
      }
      expect(getCollection).not.toHaveBeenCalled();
    },
  );
});

it.each(["development", "test", "production"])("never selects a fixed-code path in %s", async (NODE_ENV) => {
  const challengeStore = { create: vi.fn() };
  const result = await createOtpChallenge({ phone: "0521234567", purpose: "login" }, {
    env: { NODE_ENV, CUSTOMER_SESSION_SECRET: SECRET, OTP_DEV_CODE: "654321" },
    clock: createTestClock(), deriveSourceHash: () => "source-hash", challengeStore,
    rateStore: { claimSourceAction: vi.fn(), claimPhoneStart: vi.fn() },
  });
  expect(result.provider).toBe("twilio");
  expect(challengeStore.create).toHaveBeenCalledTimes(1);
  expect(challengeStore.create.mock.calls[0][0]).not.toHaveProperty("code");
  expect(JSON.stringify(challengeStore.create.mock.calls)).not.toContain(result.challengeToken);
  expect(getCollection).not.toHaveBeenCalled();
});

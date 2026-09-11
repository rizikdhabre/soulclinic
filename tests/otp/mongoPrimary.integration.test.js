import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { MongoBinary, MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server-core";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import { requestTwilioSend } from "@/lib/otp/twilioSend";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { consumeBookingGrant, releaseBookingGrant } from "@/lib/otp/bookingGrant";
import { deriveBookingToken, hashBearerToken } from "@/lib/otp/crypto";

const external = vi.hoisted(() => ({
  getCollection: vi.fn(() => { throw new Error("Application database access is forbidden in integration tests."); }),
  getMongoClient: vi.fn(() => { throw new Error("Application MongoClient access is forbidden in integration tests."); }),
  getTwilioClient: vi.fn(() => { throw new Error("Real Twilio access is forbidden in integration tests."); }),
  getTwilioVerifyConfig: vi.fn(() => { throw new Error("Real Twilio configuration is forbidden in integration tests."); }),
}));
vi.mock("@/lib/db", () => ({ getCollection: external.getCollection, getMongoClient: external.getMongoClient }));
vi.mock("@/lib/twilio", () => ({ getTwilioClient: external.getTwilioClient, getTwilioVerifyConfig: external.getTwilioVerifyConfig }));

const TIMEOUT = 120_000;
const PHONE = "+972521234567";
const SID = `VE${"a".repeat(32)}`;
const ENV = {
  NODE_ENV: "test",
  CUSTOMER_SESSION_SECRET: "isolated-integration-test-secret-not-a-real-credential",
  OTP_SOURCE_HASH_SECRET: "isolated-integration-test-source-secret",
};
let binaryPath;

// The first binary download is installation work, separate from bounded server startup.
beforeAll(async () => {
  binaryPath = await MongoBinary.getPath();
}, 30 * 60_000);

describe.each(["standalone", "replica set"])("real Mongo primary booking: %s", (topology) => {
  let server;
  let client;
  let db;
  let deps;
  let phoneCollection;
  let sourceCollection;

  beforeAll(async () => {
    if (topology === "standalone") {
      server = new MongoMemoryServer({
        binary: { systemBinary: binaryPath },
        instance: { ip: "127.0.0.1", storageEngine: "wiredTiger", launchTimeout: TIMEOUT },
        spawn: { windowsHide: true },
      });
    } else {
      server = new MongoMemoryReplSet({
        binary: { systemBinary: binaryPath },
        instanceOpts: [{ launchTimeout: TIMEOUT }],
        replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger", spawn: { windowsHide: true } },
      });
    }
    await server.start();
    const uri = server.getUri();
    if (!uri.startsWith("mongodb://127.0.0.1:")) throw new Error("Expected an ephemeral loopback MongoDB URI.");
    client = new MongoClient(uri, { serverSelectionTimeoutMS: 15_000, monitorCommands: true });
    await client.connect();
    const hello = await client.db("admin").command({ hello: 1 });
    expect(Boolean(hello.setName)).toBe(topology === "replica set");
    if (topology === "replica set") expect(hello.hosts).toHaveLength(1);
  }, TIMEOUT);

  afterAll(async () => {
    try {
      await client?.close();
    } finally {
      await server?.stop();
    }
  }, TIMEOUT);

  beforeEach(async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    db = client.db(`otp_primary_${randomUUID().replaceAll("-", "")}`);
    const challenges = db.collection("otpChallengesV2");
    const grants = db.collection("otpVerificationGrants");
    const usersData = db.collection("usersData");
    phoneCollection = db.collection("otpSecurityState");
    sourceCollection = db.collection("otpSourceSecurityState");
    const clock = { now: () => new Date() };
    const challengeStore = createOtpChallengeStore({ collection: challenges });
    const rateStore = createOtpRateLimitStore({ phoneCollection, sourceCollection, clock, env: ENV });
    await usersData.insertOne({ phone: PHONE, firstName: "Test", lastName: "Customer", privateNote: "must not leave the database" });
    deps = {
      env: ENV, clock, client, challenges, grants, challengeStore, rateStore, usersData,
      sendVerification: vi.fn(async () => ({ sid: SID, to: PHONE, channel: "sms", status: "pending" })),
      verifyTwilioCode: vi.fn(async () => ({ sid: SID, to: PHONE, status: "approved" })),
    };
  }, TIMEOUT);

  async function prepare() {
    const challenge = await createOtpChallenge({ phone: "0521234567", purpose: "booking" }, deps);
    const input = { challengeToken: challenge.challengeToken, purpose: "booking", code: "654321" };
    return { challenge, input, tokenHash: hashBearerToken(challenge.challengeToken) };
  }

  function consume(verificationToken, appointmentId = "appointment-a", overrides = {}) {
    return consumeBookingGrant({ phone: PHONE, verificationToken, appointmentId, ...overrides }, deps);
  }

  function assertNoExternalAccess() {
    expect(external.getCollection).not.toHaveBeenCalled();
    expect(external.getMongoClient).not.toHaveBeenCalled();
    expect(external.getTwilioClient).not.toHaveBeenCalled();
    expect(external.getTwilioVerifyConfig).not.toHaveBeenCalled();
  }

  it("sends and checks once, recovers one deterministic grant, and consumes it once", async () => {
    const commands = [];
    const record = (event) => commands.push(event.commandName);
    client.on("commandStarted", record);
    try {
      const { challenge, input, tokenHash } = await prepare();
      expect(challenge.provider).toBe("twilio");
      expect(deps.sendVerification).not.toHaveBeenCalled();
      expect(await deps.challenges.countDocuments()).toBe(1);

      const sends = await Promise.allSettled(Array.from({ length: 8 }, () => requestTwilioSend(input, deps)));
      expect(sends.filter((result) => result.status === "fulfilled").length).toBeGreaterThan(0);
      for (const result of sends.filter((result) => result.status === "rejected")) {
        expect(result.reason.code).toBe("OTP_SEND_PENDING");
      }
      await expect(requestTwilioSend(input, deps)).resolves.toMatchObject({ provider: "twilio", status: "pending" });
      expect(deps.sendVerification).toHaveBeenCalledExactlyOnceWith(PHONE);
      expect(await deps.challengeStore.findByTokenHash(tokenHash)).toMatchObject({ status: "sent", verificationSid: SID, phone: PHONE });

      const completions = await Promise.allSettled(Array.from({ length: 8 }, () => completeOtpChallenge(input, deps)));
      const successes = completions.filter((result) => result.status === "fulfilled");
      expect(successes.length).toBeGreaterThan(0);
      for (const result of completions.filter((result) => result.status === "rejected")) {
        expect(result.reason.code).toBe("OTP_COMPLETION_IN_PROGRESS");
      }
      const verificationToken = successes[0].value.verificationToken;
      expect(new Set(successes.map((result) => result.value.verificationToken)).size).toBe(1);
      expect(successes[0].value.profile).toEqual({ hasCompleteName: true, firstName: "Test", lastName: "Customer" });
      expect(deps.verifyTwilioCode).toHaveBeenCalledExactlyOnceWith(PHONE, "654321", SID);

      const replays = await Promise.all(Array.from({ length: 8 }, () => completeOtpChallenge({ ...input, code: "" }, deps)));
      for (const replay of replays) expect(replay.verificationToken).toBe(verificationToken);
      const completed = await deps.challengeStore.findByTokenHash(tokenHash);
      const grant = await deps.grants.findOne({ challengeId: completed._id });
      expect(completed).toMatchObject({ status: "completed", completionId: completed._id, expiresAt: challenge.expiresAt });
      expect(grant).toMatchObject({
        challengeId: completed._id, completionId: completed._id,
        purpose: "booking", phone: PHONE, tokenHash: hashBearerToken(verificationToken),
        status: "prepared", used: false, usedAt: null, appointmentId: null,
        createdAt: completed.approvedAt, expiresAt: completed.completionExpiresAt,
      });
      expect(+grant.expiresAt - +grant.createdAt).toBe(600_000);
      expect(completed.bookingGrantTokenHash).toBe(grant.tokenHash);
      expect(JSON.stringify(grant)).not.toContain(verificationToken);
      expect(await deps.grants.countDocuments()).toBe(1);

      await expect(consume(verificationToken, "wrong-phone", { phone: "+972529999999" }))
        .rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID" });
      const consumers = await Promise.allSettled(Array.from({ length: 8 }, (_, index) => consume(verificationToken, `appointment-${index}`)));
      expect(consumers.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      for (const result of consumers.filter((result) => result.status === "rejected")) {
        expect(result.reason.code).toBe("OTP_VERIFICATION_ALREADY_USED");
      }
      await expect(consume(verificationToken)).rejects.toMatchObject({ code: "OTP_VERIFICATION_ALREADY_USED" });
      await expect(completeOtpChallenge(input, deps)).rejects.toMatchObject({ code: "OTP_VERIFICATION_ALREADY_USED" });
      expect(await deps.grants.countDocuments()).toBe(1);
      expect(await phoneCollection.findOne({ phone: PHONE })).toMatchObject({ sendCount: 1, verifyFailureCount: 1 });
      expect((await phoneCollection.findOne({ phone: PHONE })).verifyReservationIds).toHaveLength(1);
      expect(await sourceCollection.findOne({ sourceHash: completed.sourceHash })).toMatchObject({ challengeShortCount: 1, sendShortCount: 1 });
      expect(await sourceCollection.findOne({ sourceHash: "otp:global-send" })).toMatchObject({ globalHourCount: 1, globalDayCount: 1 });
      expect(deps.sendVerification).toHaveBeenCalledTimes(1);
      expect(deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
      expect(commands.includes("commitTransaction")).toBe(topology === "replica set");
      assertNoExternalAccess();
    } finally {
      client.off("commandStarted", record);
    }
  }, TIMEOUT);

  it("recovers publication failure without rechecking Twilio and releases a failed appointment", async () => {
    const { input, tokenHash } = await prepare();
    await requestTwilioSend(input, deps);
    const transition = deps.challengeStore.transition.bind(deps.challengeStore);
    let rejectPublication = true;
    vi.spyOn(deps.challengeStore, "transition").mockImplementation((args, options) => {
      if (args.patch.status === "completed" && rejectPublication) {
        rejectPublication = false;
        throw new Error("Simulated publication outage");
      }
      return transition(args, options);
    });

    await expect(completeOtpChallenge(input, deps)).rejects.toMatchObject({ code: "OTP_COMPLETION_FAILED" });
    expect((await deps.challengeStore.findByTokenHash(tokenHash)).status).toBe("approved");
    expect(await deps.grants.countDocuments()).toBe(topology === "standalone" ? 1 : 0);
    const token = deriveBookingToken(input.challengeToken, ENV);
    await expect(consume(token)).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID" });

    const result = await completeOtpChallenge(input, deps);
    expect(result.verificationToken).toBe(token);
    expect(deps.sendVerification).toHaveBeenCalledTimes(1);
    expect(deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
    expect(await deps.grants.countDocuments()).toBe(1);
    await consume(token);
    const releaseInput = { phone: PHONE, verificationToken: token, appointmentId: "appointment-a" };
    await releaseBookingGrant({ ...releaseInput, appointmentId: "another-appointment" }, deps);
    await expect(consume(token)).rejects.toMatchObject({ code: "OTP_VERIFICATION_ALREADY_USED" });
    await releaseBookingGrant(releaseInput, deps);
    await expect(consume(token, "appointment-retry")).resolves.toMatchObject({ used: true, appointmentId: "appointment-retry" });
    assertNoExternalAccess();
  }, TIMEOUT);
});

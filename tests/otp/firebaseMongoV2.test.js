import { randomUUID } from "node:crypto";
import { access } from "node:fs/promises";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MongoClient } from "mongodb";
import { MongoMemoryReplSet, MongoMemoryServer } from "mongodb-memory-server-core";
import { createOtpChallenge } from "@/lib/otp/challengeService";
import { createOtpChallengeStore } from "@/lib/otp/challengeStore";
import { createOtpRateLimitStore } from "@/lib/otp/rateLimitStore";
import { requestFirebaseFallback, requestFirebaseSend } from "@/lib/otp/firebaseSend";
import { requestTwilioSend } from "@/lib/otp/twilioSend";
import { completeOtpChallenge } from "@/lib/otp/completionService";
import { consumeBookingGrant } from "@/lib/otp/bookingGrant";
import { deriveBookingToken, hashBearerToken } from "@/lib/otp/crypto";
import { deriveOtpSourceHash } from "@/lib/otp/sourceIdentity";
import { verifyCustomerSession } from "@/lib/customerSession";
import {
  OTP_GRANT_TTL_MS,
  OTP_PHONE_START_COOLDOWN_MS,
  OTP_SOURCE_CHALLENGE_SHORT_LIMIT,
  OTP_SOURCE_SEND_SHORT_LIMIT,
} from "@/lib/otp/constants";

const external = vi.hoisted(() => {
  const forbidden = (name) => vi.fn(() => { throw new Error(`Forbidden external access: ${name}`); });
  return {
    getCollection: forbidden("production collection"),
    getMongoClient: forbidden("production MongoClient"),
    getTwilioClient: forbidden("Twilio client"),
    getTwilioVerifyConfig: forbidden("Twilio configuration"),
    getApps: forbidden("Firebase Admin apps"),
    initializeApp: forbidden("Firebase Admin initialization"),
    cert: forbidden("Firebase Admin credentials"),
    applicationDefault: forbidden("Firebase default credentials"),
    getAuth: forbidden("Firebase Admin Auth"),
  };
});
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ getCollection: external.getCollection, getMongoClient: external.getMongoClient }));
vi.mock("@/lib/twilio", () => ({ getTwilioClient: external.getTwilioClient, getTwilioVerifyConfig: external.getTwilioVerifyConfig }));
vi.mock("firebase-admin/app", () => ({
  getApps: external.getApps, initializeApp: external.initializeApp,
  cert: external.cert, applicationDefault: external.applicationDefault,
}));
vi.mock("firebase-admin/auth", () => ({ getAuth: external.getAuth }));

const TIMEOUT = 120_000;
const BINARY_CACHE = "C:/Users/rizik/.cache/mongodb-binaries";
const BINARY_VERSION = "8.2.6";
const PHONE = "+972500000001";
const SID = `VE${"a".repeat(32)}`;
const ID_TOKEN = "isolated-mocked-firebase-evidence-not-a-real-token";
const FAILURE = { code: "auth/network-request-failed", stage: "send", provenance: "firebase_sdk" };
const ENV = Object.freeze({
  NODE_ENV: "test",
  OTP_PROVIDER_MODE: "firebase_first",
  CUSTOMER_SESSION_SECRET: "isolated-firebase-mongo-test-secret-not-a-real-credential",
  OTP_SOURCE_HASH_SECRET: "isolated-firebase-mongo-shared-source-secret",
});
const COLLECTIONS = ["otpChallengesV2", "otpVerificationGrants", "otpSecurityState", "otpSourceSecurityState", "usersData"];
const settle = (promise) => promise.then(
  (value) => ({ status: "fulfilled", value }),
  (reason) => ({ status: "rejected", reason }),
);

function providerGate(mock) {
  let enter;
  let release;
  const started = new Promise((resolve) => { enter = resolve; });
  const released = new Promise((resolve) => { release = resolve; });
  const implementation = mock.getMockImplementation();
  mock.mockImplementation(async (...args) => {
    enter();
    await released;
    return implementation(...args);
  });
  return {
    release,
    wait: (attempt) => Promise.race([
      started,
      attempt.then((result) => { throw new Error(`Provider was not reached: ${result.reason?.code ?? result.status}`); }),
    ]),
  };
}

describe.each(["standalone", "replica set"])("isolated Firebase-first real Mongo: %s", (topology) => {
  let server;
  let client;
  let db;
  let deps;
  let phoneCollection;
  let sourceCollection;
  let time;
  let commands;
  let recordCommand;

  beforeAll(async () => {
    // Require the existing cache: this suite neither downloads binaries nor reads application env files.
    const systemBinary = path.join(BINARY_CACHE, `mongod-x64-win32-${BINARY_VERSION}.exe`);
    await access(systemBinary);
    const binary = { systemBinary, version: BINARY_VERSION, downloadDir: BINARY_CACHE };
    if (topology === "standalone") {
      server = new MongoMemoryServer({
        binary,
        instance: { ip: "127.0.0.1", storageEngine: "wiredTiger", launchTimeout: TIMEOUT },
        spawn: { windowsHide: true },
      });
    } else {
      server = new MongoMemoryReplSet({
        binary,
        instanceOpts: [{ launchTimeout: TIMEOUT }],
        replSet: { count: 1, ip: "127.0.0.1", storageEngine: "wiredTiger", spawn: { windowsHide: true } },
      });
    }
    await server.start();
    const uri = server.getUri();
    if (!/^mongodb:\/\/127\.0\.0\.1:\d+\//.test(uri)) throw new Error("Only ephemeral loopback MongoDB is allowed.");
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
    vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network fetch is forbidden in isolated Mongo tests."); });
    db = client.db(`otp_firebase_v2_${randomUUID().replaceAll("-", "")}`);
    commands = [];
    recordCommand = (event) => commands.push(event);
    client.on("commandStarted", recordCommand);
    time = Date.now();
    const clock = { now: () => new Date(time) };
    const challenges = db.collection("otpChallengesV2");
    const grants = db.collection("otpVerificationGrants");
    const usersData = db.collection("usersData");
    phoneCollection = db.collection("otpSecurityState");
    sourceCollection = db.collection("otpSourceSecurityState");
    const challengeStore = createOtpChallengeStore({ collection: challenges });
    const rateStore = createOtpRateLimitStore({ phoneCollection, sourceCollection, clock, env: ENV });
    await challengeStore.ensureIndexes();
    await rateStore.ensureIndexes();
    await usersData.insertOne({ phone: PHONE, firstName: "Test", lastName: "Customer", privateNote: "never expose this field" });
    deps = {
      env: { ...ENV }, clock, client, challenges, grants, usersData, challengeStore, rateStore,
      sendVerification: vi.fn(async (phone) => ({ sid: SID, to: phone, channel: "sms", status: "pending" })),
      verifyTwilioCode: vi.fn(async (phone) => ({ sid: SID, to: phone, status: "approved" })),
      verifyFirebaseEvidence: vi.fn(async (_token, challenge) => ({
        uid: `synthetic-firebase-${challenge._id}`, authTime: Math.floor(time / 1000),
      })),
    };
  }, TIMEOUT);

  afterEach(async () => {
    try {
      for (const mock of Object.values(external)) expect(mock).not.toHaveBeenCalled();
      expect(globalThis.fetch).not.toHaveBeenCalled();
      if (db) {
        const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(({ name }) => name);
        expect(names.filter((name) => !COLLECTIONS.includes(name))).toEqual([]);
      }
    } finally {
      client?.off("commandStarted", recordCommand);
      if (db) await db.dropDatabase();
      vi.restoreAllMocks();
    }
  }, TIMEOUT);

  async function prepare(purpose = "booking", phone = PHONE, dependencies = deps) {
    const challenge = await createOtpChallenge({ phone, purpose }, dependencies);
    const input = { challengeToken: challenge.challengeToken, purpose };
    const tokenHash = hashBearerToken(challenge.challengeToken);
    return {
      challenge, input, tokenHash,
      current: () => dependencies.challengeStore.findByTokenHash(tokenHash),
      reserve: () => requestFirebaseSend({ ...input, operation: "reserve" }, dependencies),
      accepted: (firebaseSendId) => requestFirebaseSend({ ...input, operation: "accepted", firebaseSendId }, dependencies),
      fallback: (firebaseSendId, extra = {}) => requestFirebaseFallback({ ...input, firebaseSendId, failure: FAILURE, ...extra }, dependencies),
      complete: (extra = {}) => completeOtpChallenge({ ...input, idToken: ID_TOKEN, ...extra }, dependencies),
    };
  }

  it("fences concurrent post-send fallback and completes only the Twilio-owned booking", async () => {
    const f = await prepare();
    const { firebaseSendId } = await f.reserve();
    await f.accepted(firebaseSendId);
    const phoneBefore = await phoneCollection.find({}).toArray();
    const failure = { code: "auth/network-request-failed", stage: "confirm", provenance: "firebase_sdk" };
    const results = await Promise.all(Array.from({ length: 10 }, () => settle(f.fallback(firebaseSendId, { failure }))));
    expect(results.some(result => result.status === "fulfilled")).toBe(true);
    expect(deps.sendVerification).toHaveBeenCalledTimes(1);
    expect(await phoneCollection.find({}).toArray()).toEqual(phoneBefore);
    expect(await f.current()).toMatchObject({ provider: "twilio", status: "sent" });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_PROVIDER_REJECTED" });
    const completed = await completeOtpChallenge({ ...f.input, code: "654321" }, deps);
    expect(completed).toMatchObject({ purpose: "booking", success: true });
    expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    expect(deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
    expect(await deps.grants.countDocuments()).toBe(1);
  });

  it("server deadline gates non-receipt and saved fallback cannot dispatch again", async () => {
    const f = await prepare();
    const { firebaseSendId } = await f.reserve();
    await f.accepted(firebaseSendId);
    const failure = { code: "client/sms-not-received", stage: "delivery", provenance: "client" };
    await expect(f.fallback(firebaseSendId, { failure })).rejects.toMatchObject({ code: "OTP_RATE_LIMITED" });
    expect(deps.sendVerification).not.toHaveBeenCalled();
    time += OTP_PHONE_START_COOLDOWN_MS + 1;
    expect(await f.fallback(firebaseSendId, { failure })).toMatchObject({ provider: "twilio", status: "pending" });
    expect(await f.fallback(firebaseSendId, { failure })).toMatchObject({ provider: "twilio", status: "pending" });
    expect(deps.sendVerification).toHaveBeenCalledTimes(1);
  });

  it("atomically deduplicates concurrent diagnostics while preserving challenge and security state", async () => {
    const f = await prepare();
    const { firebaseSendId } = await f.reserve();
    await f.accepted(firebaseSendId);
    const before = await f.current();
    const phoneBefore = await phoneCollection.find({}).toArray();
    const sourceBefore = await sourceCollection.find({}).toArray();
    const report = { ...f.input, firebaseSendId, operation: "diagnostic", failure: { code: "auth/network-request-failed", stage: "token", provenance: "firebase_sdk" },
      diagnostic: { sdkErrorCode: "auth/network-request-failed", message: "private-token" } };
    const results = await Promise.all(Array.from({ length: 10 }, () => requestFirebaseSend(report, deps)));
    expect(results.filter(value => value.recorded)).toHaveLength(1);
    const after = await f.current();
    expect(after.firebaseClientFailures).toEqual([expect.objectContaining({ errorCode: "auth/network-request-failed", sdkErrorCode: "auth/network-request-failed", failureStage: "token", failureCategory: "verification_technical", fallbackDecision: "eligible", observedAt: expect.any(Date) })]);
    expect(JSON.stringify(after.firebaseClientFailures)).not.toContain("private-token");
    expect(after).toMatchObject({ provider: before.provider, status: before.status, expiresAt: before.expiresAt, purgeAt: before.purgeAt });
    expect(await phoneCollection.find({}).toArray()).toEqual(phoneBefore);
    expect(await sourceCollection.find({}).toArray()).toEqual(sourceBefore);
    expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    expect(deps.sendVerification).not.toHaveBeenCalled();
    expect(await deps.grants.countDocuments()).toBe(0);
  });

  it("retains diagnostic-only send identity in Mongo without permitting fallback or spending", async () => {
    const f = await prepare();
    const { firebaseSendId } = await f.reserve();
    const phoneBefore = await phoneCollection.find({}).toArray();
    const sourceBefore = await sourceCollection.find({}).toArray();
    const failure = { code: "client/unclassified", stage: "send", provenance: "firebase_sdk" };
    await expect(f.fallback(firebaseSendId, { failure, diagnostic: { sdkErrorCode: "auth/internal-error" } }))
      .rejects.toHaveProperty("code", "OTP_PROVIDER_REJECTED");
    await requestFirebaseSend({ ...f.input, firebaseSendId, operation: "rejected", failure,
      diagnostic: { sdkErrorCode: "auth/invalid-credential", token: "private-token" } }, deps);
    const saved = await f.current();
    expect(saved).toMatchObject({ provider: "firebase", status: "failed", firebaseSendFailure: {
      errorCode: "client/unclassified", sdkErrorCode: "auth/invalid-credential", fallbackDecision: "blocked",
    } });
    expect(JSON.stringify(saved.firebaseSendFailure)).not.toContain("private-token");
    expect(await phoneCollection.find({}).toArray()).toEqual(phoneBefore);
    expect(await sourceCollection.find({}).toArray()).toEqual(sourceBefore);
    expect(deps.sendVerification).not.toHaveBeenCalled();
    expect(await deps.grants.countDocuments()).toBe(0);
  });

  it.each(["completion", "fallback"])("diagnostics racing %s cannot change final provider or issue duplicate grants", async (action) => {
    const f = await prepare();
    const { firebaseSendId } = await f.reserve();
    const input = { ...f.input, firebaseSendId, operation: "diagnostic", failure: { code: "client/operation-pending", stage: "send", provenance: "client" } };
    const [result] = await Promise.all([
      action === "completion" ? f.complete() : f.fallback(firebaseSendId),
      ...Array.from({ length: 10 }, () => settle(requestFirebaseSend(input, deps))),
    ]);
    const saved = await f.current();
    if (action === "completion") {
      expect(result).toMatchObject({ success: true, purpose: "booking" });
      expect(saved).toMatchObject({ provider: "firebase", status: "completed" });
      expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
      expect(deps.sendVerification).not.toHaveBeenCalled();
      expect(await deps.grants.countDocuments()).toBe(1);
    } else {
      expect(result).toMatchObject({ provider: "twilio", status: "pending" });
      expect(saved).toMatchObject({ provider: "twilio", status: "sent" });
      expect(deps.sendVerification).toHaveBeenCalledTimes(1);
      expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
      expect(await deps.grants.countDocuments()).toBe(0);
    }
    expect(saved.firebaseClientFailures?.length ?? 0).toBeLessThanOrEqual(1);
  });

  async function firebaseReady(purpose = "booking", phone = PHONE) {
    const f = await prepare(purpose, phone);
    const { firebaseSendId } = await f.reserve();
    await f.accepted(firebaseSendId);
    return { ...f, firebaseSendId };
  }

  function consume(verificationToken, appointmentId = "synthetic-consumer-a", phone = PHONE) {
    return consumeBookingGrant({ verificationToken, phone, appointmentId }, deps);
  }

  function restartDependencies() {
    return {
      ...deps,
      challengeStore: createOtpChallengeStore({ collection: deps.challenges }),
      rateStore: createOtpRateLimitStore({ phoneCollection, sourceCollection, clock: deps.clock, env: deps.env }),
    };
  }

  async function assertSingleGrant(f, verificationToken) {
    const completed = await f.current();
    const grant = await deps.grants.findOne({ challengeId: completed._id });
    expect(completed).toMatchObject({
      provider: "firebase", status: "completed", completionId: completed._id,
      bookingGrantTokenHash: hashBearerToken(verificationToken),
    });
    expect(grant).toMatchObject({
      challengeId: completed._id, completionId: completed._id, phone: PHONE,
      purpose: "booking", status: "prepared", used: false, usedAt: null, appointmentId: null,
      tokenHash: hashBearerToken(verificationToken), createdAt: completed.approvedAt,
      expiresAt: completed.completionExpiresAt,
    });
    expect(+grant.expiresAt - +grant.createdAt).toBe(OTP_GRANT_TTL_MS);
    expect(verificationToken).toBe(deriveBookingToken(f.input.challengeToken, deps.env));
    expect(JSON.stringify(grant)).not.toContain(verificationToken);
    expect(await deps.grants.countDocuments()).toBe(1);
    return grant;
  }

  it.each(["login", "booking"])("%s uses the same normalized customer identity as Twilio", async (purpose) => {
    const firebase = await firebaseReady(purpose, "0500000001");
    const firebaseResult = await firebase.complete();
    const firebaseChallenge = await firebase.current();
    expect(firebaseChallenge).toMatchObject({ phone: PHONE, provider: "firebase", status: "completed" });
    const customer = await deps.usersData.findOne({ phone: PHONE });
    time += OTP_PHONE_START_COOLDOWN_MS + 1;
    const twilioDeps = { ...deps, env: { ...deps.env, OTP_PROVIDER_MODE: "twilio_only" } };
    const twilio = await prepare(purpose, PHONE, twilioDeps);
    await requestTwilioSend(twilio.input, twilioDeps);
    const twilioResult = await completeOtpChallenge({ ...twilio.input, code: "654321" }, twilioDeps);
    expect((await twilio.current()).phone).toBe(firebaseChallenge.phone);
    if (purpose === "login") {
      const options = { env: deps.env, now: deps.clock.now() };
      expect(await verifyCustomerSession(firebaseResult.sessionToken, options)).toEqual({ type: "customer", phone: PHONE });
      expect(await verifyCustomerSession(twilioResult.sessionToken, options)).toEqual({ type: "customer", phone: PHONE });
    } else {
      expect(firebaseResult.profile).toEqual({ hasCompleteName: true, firstName: "Test", lastName: "Customer" });
      expect(twilioResult.profile).toEqual(firebaseResult.profile);
      await expect(consume(firebaseResult.verificationToken, "synthetic-firebase-identity")).resolves.toMatchObject({ phone: PHONE, used: true });
      await expect(consume(twilioResult.verificationToken, "synthetic-twilio-identity")).resolves.toMatchObject({ phone: PHONE, used: true });
      expect(await deps.grants.countDocuments()).toBe(2);
      expect(commands.some(({ commandName }) => commandName === "commitTransaction")).toBe(topology === "replica set");
    }
    expect(await deps.usersData.findOne({ phone: PHONE })).toEqual(customer);
    expect(await deps.usersData.countDocuments()).toBe(1);
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(deps.verifyTwilioCode).toHaveBeenCalledExactlyOnceWith(PHONE, "654321", SID);
    expect(deps.sendVerification).toHaveBeenCalledExactlyOnceWith(PHONE);
    expect(await phoneCollection.findOne({ phone: PHONE })).toMatchObject({ sendCount: 2, verifyFailureCount: 2 });
  }, TIMEOUT);

  it.each(["prepare acknowledgement", "publish"])("recovers a booking %s failure without an orphan usable grant", async (stage) => {
    const f = await firebaseReady();
    let fault;
    if (stage === "prepare acknowledgement") {
      const update = deps.grants.updateOne.bind(deps.grants);
      fault = vi.spyOn(deps.grants, "updateOne").mockImplementation(async (...args) => {
        await update(...args);
        throw new Error("Injected grant prepare acknowledgement failure");
      });
    } else {
      const transition = deps.challengeStore.transition.bind(deps.challengeStore);
      fault = vi.spyOn(deps.challengeStore, "transition").mockImplementation((args, options) => {
        if (args.patch.status === "completed") throw new Error("Injected grant publication failure");
        return transition(args, options);
      });
    }
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_COMPLETION_FAILED" });
    expect((await f.current()).status).toBe("approved");
    expect(await deps.grants.countDocuments()).toBe(topology === "standalone" ? 1 : 0);
    const partial = await deps.grants.findOne({ challengeId: (await f.current())._id });
    const token = deriveBookingToken(f.input.challengeToken, deps.env);
    await expect(consume(token)).rejects.toMatchObject({ code: "OTP_VERIFICATION_INVALID" });
    if (partial) expect((await deps.grants.findOne({ _id: partial._id })).used).toBe(false);
    fault.mockRestore();
    const result = await f.complete({ idToken: undefined });
    const grant = await assertSingleGrant(f, result.verificationToken);
    if (partial) expect(grant._id.equals(partial._id)).toBe(true);
    await expect(consume(token)).resolves.toMatchObject({ used: true, appointmentId: "synthetic-consumer-a" });
    await expect(consume(token, "synthetic-consumer-b")).rejects.toMatchObject({ code: "OTP_VERIFICATION_ALREADY_USED" });
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(deps.sendVerification).not.toHaveBeenCalled();
    expect(deps.verifyTwilioCode).not.toHaveBeenCalled();
  }, TIMEOUT);

  it("persists approval before a profile read failure and never checks Admin twice", async () => {
    const f = await firebaseReady();
    const profile = vi.spyOn(deps.usersData, "findOne").mockRejectedValueOnce(new Error("Injected profile database outage"));
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_PERSISTENCE_FAILED" });
    expect(await f.current()).toMatchObject({ status: "approved", firebaseUid: expect.any(String) });
    expect(await deps.grants.countDocuments()).toBe(0);
    profile.mockRestore();
    const result = await completeOtpChallenge(f.input, restartDependencies());
    expect(result.profile).toEqual({ hasCompleteName: true, firstName: "Test", lastName: "Customer" });
    await assertSingleGrant(f, result.verificationToken);
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(deps.verifyTwilioCode).not.toHaveBeenCalled();
  }, TIMEOUT);

  it("recovers login signing failure from persisted approval without another Admin check", async () => {
    const f = await firebaseReady("login");
    deps.signCustomerSession = vi.fn(async () => { throw new Error("Injected session signer outage"); });
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_COMPLETION_FAILED" });
    expect((await f.current()).status).toBe("approved");
    delete deps.signCustomerSession;
    const result = await completeOtpChallenge(f.input, restartDependencies());
    expect(await verifyCustomerSession(result.sessionToken, { env: deps.env, now: deps.clock.now() })).toEqual({ type: "customer", phone: PHONE });
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(await deps.grants.countDocuments()).toBe(0);
  }, TIMEOUT);

  it("concurrent Firebase completions and durable replays yield one deterministic one-use grant", async () => {
    const f = await firebaseReady();
    const completions = await Promise.allSettled(Array.from({ length: 10 }, () => f.complete()));
    const successes = completions.filter(({ status }) => status === "fulfilled");
    expect(successes.length).toBeGreaterThan(0);
    for (const result of completions.filter(({ status }) => status === "rejected")) {
      expect(result.reason.code).toBe("OTP_COMPLETION_IN_PROGRESS");
    }
    const token = successes[0].value.verificationToken;
    expect(new Set(successes.map(({ value }) => value.verificationToken))).toEqual(new Set([token]));
    const replayDeps = restartDependencies();
    const replays = await Promise.all(Array.from({ length: 10 }, () => completeOtpChallenge(f.input, replayDeps)));
    expect(new Set(replays.map(({ verificationToken }) => verificationToken))).toEqual(new Set([token]));
    await assertSingleGrant(f, token);
    const consumers = await Promise.allSettled(Array.from({ length: 10 }, (_, index) => consume(token, `synthetic-consumer-${index}`)));
    expect(consumers.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    for (const result of consumers.filter(({ status }) => status === "rejected")) {
      expect(result.reason.code).toBe("OTP_VERIFICATION_ALREADY_USED");
    }
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect((await phoneCollection.findOne({ phone: PHONE })).verifyReservationIds).toHaveLength(1);
  }, TIMEOUT);

  it("completion wins the provider race before Admin returns and rejects all fallback dispatches", async () => {
    const f = await prepare("login");
    const { firebaseSendId } = await f.reserve();
    const gate = providerGate(deps.verifyFirebaseEvidence);
    const completion = settle(f.complete());
    try {
      await gate.wait(completion);
      expect(await f.current()).toMatchObject({ provider: "firebase", status: "verifying" });
      const fallbacks = await Promise.allSettled(Array.from({ length: 10 }, () => f.fallback(firebaseSendId)));
      expect(fallbacks.every(({ status }) => status === "rejected")).toBe(true);
      for (const { reason } of fallbacks) expect(reason.code).toBe("OTP_PROVIDER_REJECTED");
      expect(deps.sendVerification).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await completion;
    }
    expect(await completion).toMatchObject({ status: "fulfilled", value: { purpose: "login" } });
    expect(await f.current()).toMatchObject({ provider: "firebase", status: "completed" });
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(deps.verifyTwilioCode).not.toHaveBeenCalled();
  }, TIMEOUT);

  it("simultaneous fallback and completion contenders cannot acquire both providers", async () => {
    const f = await prepare("login");
    const { firebaseSendId } = await f.reserve();
    const contenders = Array.from({ length: 10 }, () => [f.fallback(firebaseSendId), f.complete()]).flat();
    const outcomes = await Promise.allSettled(contenders);
    for (const result of outcomes.filter(({ status }) => status === "rejected")) {
      expect(["OTP_PROVIDER_REJECTED", "OTP_COMPLETION_IN_PROGRESS", "OTP_SEND_PENDING"]).toContain(result.reason.code);
    }
    expect(outcomes.some(({ status }) => status === "fulfilled")).toBe(true);
    const owner = (await f.current()).provider;
    expect(["firebase", "twilio"]).toContain(owner);
    expect(deps.sendVerification).toHaveBeenCalledTimes(owner === "twilio" ? 1 : 0);
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(owner === "firebase" ? 1 : 0);
    const completed = await f.complete(owner === "twilio" ? { idToken: undefined, code: "654321" } : { idToken: undefined });
    expect(await verifyCustomerSession(completed.sessionToken, { env: deps.env, now: deps.clock.now() })).toEqual({ type: "customer", phone: PHONE });
    expect(await f.current()).toMatchObject({ provider: owner, status: "completed", firebaseSendId });
    expect(await deps.challenges.countDocuments()).toBe(1);
    expect(deps.sendVerification).toHaveBeenCalledTimes(owner === "twilio" ? 1 : 0);
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(owner === "firebase" ? 1 : 0);
    expect(deps.verifyTwilioCode).toHaveBeenCalledTimes(owner === "twilio" ? 1 : 0);
  }, TIMEOUT);

  it("fallback wins the provider race and ten competing fallbacks dispatch Twilio only once", async () => {
    const f = await prepare("login");
    const { firebaseSendId } = await f.reserve();
    const gate = providerGate(deps.sendVerification);
    const fallback = settle(f.fallback(firebaseSendId));
    try {
      await gate.wait(fallback);
      expect(await f.current()).toMatchObject({ provider: "twilio", status: "sending" });
      await expect(f.complete()).rejects.toMatchObject({ code: "OTP_PROVIDER_REJECTED" });
      await expect(f.accepted(firebaseSendId)).rejects.toMatchObject({ code: "OTP_PROVIDER_REJECTED" });
      const competing = await Promise.allSettled(Array.from({ length: 10 }, () => f.fallback(firebaseSendId)));
      for (const result of competing) expect(result).toMatchObject({ status: "rejected", reason: { code: "OTP_SEND_PENDING" } });
      expect(deps.sendVerification).toHaveBeenCalledTimes(1);
      expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    } finally {
      gate.release();
      await fallback;
    }
    expect(await fallback).toMatchObject({ status: "fulfilled", value: { provider: "twilio", status: "pending" } });
    expect(await f.fallback(firebaseSendId)).toMatchObject({ provider: "twilio", status: "pending" });
    expect(await f.complete({ idToken: undefined, code: "654321" })).toMatchObject({ purpose: "login" });
    expect(await f.current()).toMatchObject({ provider: "twilio", providerPolicy: "firebase_first", status: "completed" });
    expect(deps.sendVerification).toHaveBeenCalledTimes(1);
    expect(deps.verifyTwilioCode).toHaveBeenCalledTimes(1);
    expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
  }, TIMEOUT);

  it("recovers fallback send evidence after a real-store write outage, then replays the saved send", async () => {
    const f = await prepare("login");
    const { firebaseSendId } = await f.reserve();
    const update = deps.challenges.findOneAndUpdate.bind(deps.challenges);
    let failedWrites = 0;
    const fault = vi.spyOn(deps.challenges, "findOneAndUpdate").mockImplementation((filter, updateDoc, options) => {
      if (updateDoc.$set.status === "sent") {
        failedWrites += 1;
        throw new Error("Injected send-result database outage");
      }
      return update(filter, updateDoc, options);
    });
    const failed = await settle(f.fallback(firebaseSendId));
    expect(failed).toMatchObject({ status: "rejected", reason: { code: "OTP_PERSISTENCE_FAILED", recoveryReceipt: expect.any(String) } });
    expect(failedWrites).toBe(3);
    const receipt = failed.reason.recoveryReceipt;
    expect(await f.current()).toMatchObject({ provider: "twilio", status: "sending" });
    fault.mockRestore();
    await expect(f.fallback(firebaseSendId)).rejects.toMatchObject({ code: "OTP_SEND_PENDING" });
    const tamperedReceipt = `${receipt[0] === "x" ? "y" : "x"}${receipt.slice(1)}`;
    await expect(f.fallback(firebaseSendId, { recoveryReceipt: tamperedReceipt })).rejects.toMatchObject({ code: "OTP_RECOVERY_INVALID" });
    await expect(requestFirebaseFallback({ ...f.input, firebaseSendId, failure: FAILURE, recoveryReceipt: receipt }, {
      ...restartDependencies(), deriveSourceHash: () => "another-source",
    })).rejects.toMatchObject({ code: "OTP_CHALLENGE_FAILED" });
    const replayDeps = restartDependencies();
    const recovered = await requestFirebaseFallback({ ...f.input, firebaseSendId, failure: FAILURE, recoveryReceipt: receipt }, replayDeps);
    expect(recovered).toEqual({ provider: "twilio", status: "pending" });
    const replays = await Promise.all(Array.from({ length: 10 }, () => requestFirebaseFallback({ ...f.input, firebaseSendId, failure: FAILURE }, replayDeps)));
    for (const replay of replays) expect(replay).toEqual(recovered);
    expect((await f.current()).verificationSid).toBe(SID);
    expect(await phoneCollection.findOne({ phone: PHONE })).toMatchObject({ sendCount: 1 });
    expect(await sourceCollection.findOne({ sourceHash: deriveOtpSourceHash(undefined, { env: deps.env }) })).toMatchObject({ challengeShortCount: 1, sendShortCount: 1 });
    expect(await sourceCollection.findOne({ sourceHash: "otp:global-send" })).toMatchObject({ globalHourCount: 1, globalDayCount: 1 });
    expect(deps.sendVerification).toHaveBeenCalledTimes(1);
    expect(deps.verifyFirebaseEvidence).not.toHaveBeenCalled();
    expect(deps.verifyTwilioCode).not.toHaveBeenCalled();
  }, TIMEOUT);

  it.each(["login", "booking"])("recovers %s approval through its bound receipt after a database outage", async (purpose) => {
    const f = await firebaseReady(purpose);
    const update = deps.challenges.findOneAndUpdate.bind(deps.challenges);
    let failedWrites = 0;
    const fault = vi.spyOn(deps.challenges, "findOneAndUpdate").mockImplementation((filter, updateDoc, options) => {
      if (updateDoc.$set.status === "approved") {
        failedWrites += 1;
        throw new Error("Injected Firebase approval database outage");
      }
      return update(filter, updateDoc, options);
    });
    const failed = await settle(f.complete());
    expect(failed).toMatchObject({ status: "rejected", reason: { code: "OTP_PERSISTENCE_FAILED", recoveryReceipt: expect.any(String) } });
    expect(failedWrites).toBe(3);
    expect(await f.current()).toMatchObject({ provider: "firebase", status: "verifying" });
    fault.mockRestore();
    await expect(f.complete()).rejects.toMatchObject({ code: "OTP_COMPLETION_IN_PROGRESS" });
    const recoveryReceipt = failed.reason.recoveryReceipt;
    const recovered = await completeOtpChallenge({ ...f.input, recoveryReceipt }, restartDependencies());
    expect(recovered.purpose).toBe(purpose);
    expect(await completeOtpChallenge(f.input, restartDependencies())).toEqual(recovered);
    if (purpose === "booking") await assertSingleGrant(f, recovered.verificationToken);
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(deps.sendVerification).not.toHaveBeenCalled();
    expect(deps.verifyTwilioCode).not.toHaveBeenCalled();
  }, TIMEOUT);

  it.each(["login", "booking"])("lost HTTP responses replay %s reservation, acceptance, and completion from Mongo alone", async (purpose) => {
    const f = await prepare(purpose);
    const reservations = await Promise.all(Array.from({ length: 10 }, () => f.reserve()));
    expect(reservations.filter(({ status }) => status === "reserved")).toHaveLength(1);
    expect(reservations.filter(({ status }) => status === "sending")).toHaveLength(9);
    expect(new Set(reservations.map(({ firebaseSendId }) => firebaseSendId)).size).toBe(1);
    const firebaseSendId = reservations[0].firebaseSendId;
    const restarted = restartDependencies();
    expect(await requestFirebaseSend({ ...f.input, operation: "reserve" }, restarted)).toMatchObject({ status: "sending", firebaseSendId });
    await f.accepted(firebaseSendId);
    expect(await requestFirebaseSend({ ...f.input, operation: "accepted", firebaseSendId }, restarted)).toMatchObject({ status: "pending" });
    const lostResponse = await f.complete();
    const replay = await completeOtpChallenge(f.input, restartDependencies());
    expect(replay).toEqual(lostResponse);
    expect((await f.current()).status).toBe("completed");
    expect(await deps.challenges.countDocuments()).toBe(1);
    if (purpose === "booking") await assertSingleGrant(f, replay.verificationToken);
    else expect(await verifyCustomerSession(replay.sessionToken, { env: deps.env, now: deps.clock.now() })).toEqual({ type: "customer", phone: PHONE });
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(1);
    expect(deps.sendVerification).not.toHaveBeenCalled();
    expect(deps.verifyTwilioCode).not.toHaveBeenCalled();
    expect(await phoneCollection.findOne({ phone: PHONE })).toMatchObject({ sendCount: 1, verifyFailureCount: 1 });
  }, TIMEOUT);

  it.each(["firebase", "fallback"])("%s: 10 simultaneous distinct identities plus 10 sequential share unchanged real protection limits", async (flow) => {
    expect(OTP_SOURCE_CHALLENGE_SHORT_LIMIT).toBe(10);
    expect(OTP_SOURCE_SEND_SHORT_LIMIT).toBe(5);
    const identities = Array.from({ length: 20 }, (_, index) => `+972500000${String(index + 101).padStart(3, "0")}`);
    expect(new Set(identities).size).toBe(20);
    async function runIdentity(phone) {
      const f = await prepare("booking", phone);
      const { firebaseSendId } = await f.reserve();
      if (flow === "fallback") await f.fallback(firebaseSendId);
      else await f.accepted(firebaseSendId);
      const result = await f.complete(flow === "fallback" ? { idToken: undefined, code: "654321" } : {});
      return { phone, result, challenge: await f.current() };
    }
    const simultaneous = await Promise.allSettled(identities.slice(0, 10).map(runIdentity));
    const sequential = [];
    for (const phone of identities.slice(10)) sequential.push(await settle(runIdentity(phone)));
    const successes = simultaneous.filter(({ status }) => status === "fulfilled");
    const blocks = simultaneous.filter(({ status }) => status === "rejected");
    const expectedSuccesses = flow === "firebase" ? 10 : 5;
    const countOutcomes = (outcomes) => outcomes.reduce((counts, outcome) => {
      const key = outcome.status === "fulfilled" ? "completed" : `${outcome.reason.code}:${outcome.reason.status}`;
      counts[key] = (counts[key] ?? 0) + 1;
      return counts;
    }, {});
    const counts = { simultaneous: countOutcomes(simultaneous), sequential: countOutcomes(sequential) };
    expect(counts).toEqual({
      simultaneous: flow === "firebase" ? { completed: 10 } : { completed: 5, "OTP_SEND_SOURCE_RATE_LIMITED:429": 5 },
      sequential: { "OTP_SOURCE_RATE_LIMITED:429": 10 },
    });
    // A 503/state-busy failure is not counted as a successful protection decision.
    for (const result of blocks) expect(result.reason).toMatchObject({ code: "OTP_SEND_SOURCE_RATE_LIMITED", status: 429 });
    for (const result of sequential) expect(result).toMatchObject({ status: "rejected", reason: { code: "OTP_SOURCE_RATE_LIMITED", status: 429 } });
    expect(successes).toHaveLength(expectedSuccesses);
    expect(blocks).toHaveLength(10 - expectedSuccesses);
    expect(sequential).toHaveLength(10);
    expect(new Set(successes.map(({ value }) => value.result.verificationToken)).size).toBe(expectedSuccesses);
    for (const { value } of successes) {
      expect(value.challenge).toMatchObject({ provider: flow === "firebase" ? "firebase" : "twilio", phone: value.phone, status: "completed" });
      expect(value.result.profile).toEqual({ hasCompleteName: false });
      await expect(consume(value.result.verificationToken, `synthetic-load-${value.phone}`, value.phone)).resolves.toMatchObject({ phone: value.phone, used: true });
    }
    const sourceHash = deriveOtpSourceHash(undefined, { env: deps.env });
    expect(await sourceCollection.findOne({ sourceHash })).toMatchObject({
      challengeShortCount: 10, challengeHourCount: 10,
      sendShortCount: flow === "firebase" ? 0 : 5, sendHourCount: flow === "firebase" ? 0 : 5,
    });
    const global = await sourceCollection.findOne({ sourceHash: "otp:global-send" });
    if (flow === "firebase") expect(global).toBeNull();
    else expect(global).toMatchObject({ globalHourCount: 5, globalDayCount: 5 });
    expect(await sourceCollection.countDocuments()).toBe(flow === "firebase" ? 1 : 2);
    expect(await phoneCollection.countDocuments()).toBe(10);
    expect(await phoneCollection.countDocuments({ sendCount: 1 })).toBe(10);
    expect(await phoneCollection.countDocuments({ verifyFailureCount: 1 })).toBe(expectedSuccesses);
    expect(await deps.challenges.countDocuments()).toBe(10);
    expect(await deps.challenges.countDocuments({ status: "completed" })).toBe(expectedSuccesses);
    expect(await deps.grants.countDocuments()).toBe(expectedSuccesses);
    expect(deps.verifyFirebaseEvidence).toHaveBeenCalledTimes(flow === "firebase" ? 10 : 0);
    expect(deps.sendVerification).toHaveBeenCalledTimes(flow === "firebase" ? 0 : 5);
    expect(deps.verifyTwilioCode).toHaveBeenCalledTimes(flow === "firebase" ? 0 : 5);
  }, TIMEOUT);
});

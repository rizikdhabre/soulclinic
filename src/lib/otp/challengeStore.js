import { ObjectId } from "mongodb";
import { OTP_STATE_RETENTION_MS } from "./constants";

export const OTP_CHALLENGE_COLLECTION = "otpChallengesV2";

export function createOtpChallengeStore({ collection }) {
  let indexesPromise;
  function ensureIndexes() {
    if (!indexesPromise) {
      indexesPromise = Promise.all([
        collection.createIndex({ challengeTokenHash: 1 }, { unique: true, name: "otp_v2_token" }),
        collection.createIndex({ phone: 1, purpose: 1 }, { name: "otp_v2_phone_purpose" }),
        collection.createIndex({ purgeAt: 1 }, { expireAfterSeconds: 0, name: "otp_v2_retention" }),
      ]).catch((error) => { indexesPromise = null; throw error; });
    }
    return indexesPromise;
  }

  return {
    ensureIndexes,
    async create({ phone, purpose, challengeTokenHash, sourceHash, now, expiresAt, correlationId, retryAt }) {
      await ensureIndexes();
      const challenge = {
        _id: new ObjectId(), phone, purpose, challengeTokenHash, sourceHash,
        provider: "twilio", status: "prepared", correlationId, retryAt,
        createdAt: now, updatedAt: now, expiresAt,
        purgeAt: new Date(now.getTime() + OTP_STATE_RETENTION_MS),
      };
      await collection.insertOne(challenge, { writeConcern: { w: "majority" } });
      return challenge;
    },
    async findByTokenHash(challengeTokenHash, options = {}) {
      await ensureIndexes();
      return collection.findOne({ challengeTokenHash }, options.session ? options : {
        readPreference: "primary", readConcern: { level: "majority" }, ...options,
      });
    },
    async transition({ challengeTokenHash, from, now, patch, match = {} }, options = {}) {
      await ensureIndexes();
      return collection.findOneAndUpdate(
        { ...match, challengeTokenHash, provider: "twilio", status: Array.isArray(from) ? { $in: from } : from },
        { $set: { ...patch, updatedAt: now } },
        { ...(options.session ? {} : { writeConcern: { w: "majority" } }), ...options, returnDocument: "after" },
      );
    },
  };
}

let productionStorePromise;
export async function getOtpChallengeStore() {
  if (!productionStorePromise) {
    productionStorePromise = import("@/lib/db").then(async ({ getCollection }) => {
      const store = createOtpChallengeStore({ collection: await getCollection(OTP_CHALLENGE_COLLECTION) });
      await store.ensureIndexes();
      return store;
    }).catch((error) => { productionStorePromise = null; throw error; });
  }
  return productionStorePromise;
}

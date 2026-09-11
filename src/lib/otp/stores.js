import { createOtpRateLimitStore } from "./rateLimitStore";

let productionRateStorePromise;
export async function getOtpRateStore(deps = {}) {
  if (deps.rateStore || deps.rateLimitStore) return deps.rateStore ?? deps.rateLimitStore;
  const create = async () => {
    const { getCollection } = await import("@/lib/db");
    const [phoneCollection, sourceCollection] = await Promise.all([
      getCollection("otpSecurityState"), getCollection("otpSourceSecurityState"),
    ]);
    const store = createOtpRateLimitStore({ phoneCollection, sourceCollection, env: deps.env, clock: deps.clock });
    await store.ensureIndexes();
    return store;
  };
  if (deps.env || deps.clock) return create();
  if (!productionRateStorePromise) {
    productionRateStorePromise = create().catch((error) => { productionRateStorePromise = null; throw error; });
  }
  return productionRateStorePromise;
}

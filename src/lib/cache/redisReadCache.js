const CACHE_PREFIX = "soulclinic:cache:v1";
const REDIS_COMMAND_TIMEOUT_MS = 250;

const HERO_GENERATION_KEY = `${CACHE_PREFIX}:hero:generation`;
const TREATMENT_GENERATION_KEY = `${CACHE_PREFIX}:treatments:generation`;

const TREATMENT_CATALOG_ITEM_FIELDS = new Set([
  "_id",
  "title",
  "description",
  "services",
  "createdAt",
  "updatedAt",
]);
const TREATMENT_CATALOG_SERVICE_FIELDS = new Set([
  "title",
  "description",
  "duration",
  "price",
  "currency",
  "imageUrl",
  "imagePath",
  "cupsCount",
]);

export const HERO_CACHE_TTL_SECONDS = 60 * 60;
export const TREATMENT_CATALOG_CACHE_TTL_SECONDS = 5 * 60;

function hasRedisConfiguration(env) {
  return (
    env.REDIS_CACHE_ENABLED === "true" &&
    typeof env.UPSTASH_REDIS_REST_KV_REST_API_URL === "string" &&
    env.UPSTASH_REDIS_REST_KV_REST_API_URL.trim().length > 0 &&
    typeof env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN === "string" &&
    env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN.trim().length > 0
  );
}

function getEnvironmentNamespace(env) {
  const rawEnvironment = env.VERCEL_ENV || env.NODE_ENV || "local";
  const namespace = String(rawEnvironment)
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return namespace || "local";
}

function parseGeneration(value) {
  if (value === null || value === undefined) {
    return 0;
  }

  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  }

  if (typeof value === "string" && /^\d+$/.test(value)) {
    const generation = Number(value);
    return Number.isSafeInteger(generation) ? generation : null;
  }

  return null;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasOnlyAllowedFields(value, allowedFields) {
  return Object.keys(value).every((field) => allowedFields.has(field));
}

function isOptionalStringField(value, field) {
  return (
    !Object.prototype.hasOwnProperty.call(value, field) ||
    typeof value[field] === "string"
  );
}

function isOptionalStringOrNumberField(value, field) {
  if (!Object.prototype.hasOwnProperty.call(value, field)) {
    return true;
  }

  return (
    typeof value[field] === "string" ||
    (typeof value[field] === "number" && Number.isFinite(value[field]))
  );
}

function isTreatmentCatalogService(value) {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedFields(value, TREATMENT_CATALOG_SERVICE_FIELDS) &&
    typeof value.title === "string" &&
    ["description", "currency", "imageUrl", "imagePath"].every((field) =>
      isOptionalStringField(value, field),
    ) &&
    ["duration", "price", "cupsCount"].every((field) =>
      isOptionalStringOrNumberField(value, field),
    )
  );
}

function isTreatmentCatalogItem(value) {
  return (
    isPlainObject(value) &&
    hasOnlyAllowedFields(value, TREATMENT_CATALOG_ITEM_FIELDS) &&
    typeof value._id === "string" &&
    /^[a-f\d]{24}$/i.test(value._id) &&
    typeof value.title === "string" &&
    typeof value.description === "string" &&
    isOptionalStringField(value, "createdAt") &&
    isOptionalStringField(value, "updatedAt") &&
    Array.isArray(value.services) &&
    value.services.every(isTreatmentCatalogService)
  );
}

function normalizeHero(value) {
  if (
    !isPlainObject(value) ||
    !Object.prototype.hasOwnProperty.call(value, "heroImageUrl") ||
    !(
      value.heroImageUrl === null ||
      (typeof value.heroImageUrl === "string" && value.heroImageUrl.trim().length > 0)
    )
  ) {
    return null;
  }

  return {
    valid: true,
    value: { heroImageUrl: value.heroImageUrl },
  };
}

function normalizeTreatmentCatalog(value) {
  if (!Array.isArray(value)) {
    return null;
  }

  try {
    const jsonValue = JSON.parse(JSON.stringify(value));
    if (!Array.isArray(jsonValue) || !jsonValue.every(isTreatmentCatalogItem)) {
      return null;
    }

    return { valid: true, value: jsonValue };
  } catch {
    return null;
  }
}

async function createUpstashClient({ url, token }) {
  const { Redis } = await import("@upstash/redis");

  return new Redis({
    url,
    token,
    retry: false,
    enableTelemetry: false,
    signal: () => AbortSignal.timeout(REDIS_COMMAND_TIMEOUT_MS),
  });
}

function warn(logger, operation) {
  logger?.warn?.(`[redis-cache] ${operation} failed; continuing without cache`);
}

export function createRedisReadCache({
  env = process.env,
  clientFactory = createUpstashClient,
  logger = console,
} = {}) {
  let clientPromise;

  function isConfigured() {
    return hasRedisConfiguration(env);
  }

  async function getClient() {
    if (!clientPromise) {
      clientPromise = Promise.resolve().then(() =>
        clientFactory({
          url: env.UPSTASH_REDIS_REST_KV_REST_API_URL.trim(),
          token: env.UPSTASH_REDIS_REST_KV_REST_API_TOKEN.trim(),
        }),
      );
    }

    try {
      return await clientPromise;
    } catch (error) {
      clientPromise = undefined;
      throw error;
    }
  }

  async function readThrough({
    generationKey,
    dataKey,
    normalize,
    ttlSeconds,
    load,
    logName,
  }) {
    if (!isConfigured()) {
      return load();
    }

    let client;
    try {
      client = await getClient();
    } catch {
      warn(logger, `${logName} client initialization`);
      return load();
    }

    let generation;
    let key;
    try {
      generation = parseGeneration(await client.get(generationKey));
      if (generation === null) {
        warn(logger, `${logName} generation read`);
        return load();
      }

      key = dataKey(getEnvironmentNamespace(env), generation);
      const cachedValue = await client.get(key);
      if (cachedValue !== null && cachedValue !== undefined) {
        const normalizedCachedValue = normalize(cachedValue);
        if (normalizedCachedValue) {
          return normalizedCachedValue.value;
        }
      }
    } catch {
      warn(logger, `${logName} read`);
      return load();
    }

    const sourceValue = await load();
    const normalizedSourceValue = normalize(sourceValue);
    if (!normalizedSourceValue) {
      return sourceValue;
    }

    try {
      await client.set(key, normalizedSourceValue.value, { ex: ttlSeconds });
    } catch {
      warn(logger, `${logName} write`);
    }

    return sourceValue;
  }

  async function advanceGeneration(generationKey, logName) {
    if (!isConfigured()) {
      return false;
    }

    try {
      const client = await getClient();
      await client.incr(generationKey);
      return true;
    } catch {
      warn(logger, `${logName} invalidation`);
      return false;
    }
  }

  return {
    getHomepageHero(load) {
      return readThrough({
        generationKey: HERO_GENERATION_KEY,
        dataKey: (environment, generation) =>
          `${CACHE_PREFIX}:${environment}:hero:g${generation}:url`,
        normalize: normalizeHero,
        ttlSeconds: HERO_CACHE_TTL_SECONDS,
        load,
        logName: "hero cache",
      });
    },

    getTreatmentCatalog(load) {
      return readThrough({
        generationKey: TREATMENT_GENERATION_KEY,
        dataKey: (environment, generation) =>
          `${CACHE_PREFIX}:${environment}:treatments:g${generation}:catalog`,
        normalize: normalizeTreatmentCatalog,
        ttlSeconds: TREATMENT_CATALOG_CACHE_TTL_SECONDS,
        load,
        logName: "treatment catalog cache",
      });
    },

    advanceHeroGeneration() {
      return advanceGeneration(HERO_GENERATION_KEY, "hero cache");
    },

    advanceTreatmentGeneration() {
      return advanceGeneration(TREATMENT_GENERATION_KEY, "treatment catalog cache");
    },
  };
}

const redisReadCache = createRedisReadCache();

export function getHomepageHeroWithCache(load) {
  return redisReadCache.getHomepageHero(load);
}

export function getTreatmentCatalogWithCache(load) {
  return redisReadCache.getTreatmentCatalog(load);
}

export function advanceHeroCacheGeneration() {
  return redisReadCache.advanceHeroGeneration();
}

export function advanceTreatmentCatalogCacheGeneration() {
  return redisReadCache.advanceTreatmentGeneration();
}

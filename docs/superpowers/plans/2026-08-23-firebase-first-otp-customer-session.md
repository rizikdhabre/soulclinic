# Firebase-First OTP and Customer Session Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the insecure Twilio-only OTP path with a bounded Firebase-first challenge flow, tightly controlled Twilio fallback, purpose-bound booking grants/customer sessions, and ownership-checked appointment APIs.

**Architecture:** Three Mongo-backed stores hold one expiring phone state, one expiring HMAC-derived source state, and one rotating challenge per `phone + purpose`; no serverless process memory is a security boundary. Browser Firebase confirmation produces transient ID-token evidence, while backend Twilio/development verification and purpose-specific completion converge in one service. Booking completion atomically coordinates challenge and grant state, while login completion sets a separate HttpOnly customer cookie.

**Tech Stack:** Next.js 16.1.4 App Router, React 19.2.3, Firebase client 12.15.0, Firebase Admin 13.6.0, Twilio 5.12.0, MongoDB driver 7.0.0, `jose` 6.1.3, Axios 1.13.2, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-23-firebase-first-otp-customer-session-design.md`

## Global Constraints

- Work only in `C:\Users\rizik\Desktop\realProjects\soulclinic-firebase-first-otp` on `codex/firebase-first-otp-customer-session`; never push.
- Firebase is always the production primary provider. Twilio may send only after an active challenge, a server-allowlisted Firebase SEND error report, source limits, and the challenge's one atomic fallback reservation.
- `auth/network-request-failed`, wrong/missing/expired Firebase codes, reCAPTCHA errors, abuse errors, invalid phones, and user-state errors never trigger Twilio.
- Never persist or log OTP values, failed OTP values, Firebase ID tokens, customer JWTs, challenge tokens, booking grant tokens, Firebase private keys, or Twilio credentials.
- Frontend API calls use the already-installed Axios dependency; no new `fetch()` calls are introduced.
- Production rate limits use MongoDB, not process memory: phone starts are `1/60 seconds` and `5/hour`; source starts are `10/10 minutes` and `30/hour`; source fallback attempts are `3/10 minutes` and `10/hour`; backend-observed Twilio/development failures are `5/10 minutes`.
- Persist only `HMAC-SHA-256(OTP_SOURCE_HASH_SECRET, normalizedClientIp)` for source limiting. On Vercel trust only platform-overwritten forwarding data under `VERCEL=1`; non-Vercel production fails closed until a tested trusted-ingress adapter exists.
- `OTP_DEV_CODE` has no default, works only when `NODE_ENV !== "production"`, and still requires a valid development-provider challenge.
- Keep public booking `requireOtp: true`, admin manual booking `requireOtp: false`, appointment race protection, WhatsApp notifications, Hujama behavior, and Firebase Storage exports working.
- Delete migrated insecure OTP and public customer-lookup routes rather than retaining compatibility bypasses.
- Do not change `.env.local` or print secrets. Document only `CUSTOMER_SESSION_SECRET`, optional `CUSTOMER_SESSION_TTL_SECONDS`, and `OTP_SOURCE_HASH_SECRET` as new names.
- Do not run `npm audit fix --force`. Report the existing audit and ESLint configuration failures separately.

---

## File Structure

### OTP Core

- Create `src/lib/otp/constants.js`: purposes, providers, TTLs, rate policies, completion lease, and Firebase fallback allowlist-independent constants.
- Create `src/lib/otp/errors.js`: typed `OtpError` with stable code, HTTP status, and optional retry interval.
- Create `src/lib/otp/crypto.js`: random bearer-token creation, SHA-256 token hashing, and constant-time development-code comparison.
- Create `src/lib/otp/firebaseErrors.js`: shared client classifier and server allowlist lookup with explicit `fallback`, `ambiguous`, and `reject` outcomes.
- Create `src/lib/otp/sourceIdentity.js`: trusted Vercel source extraction, IP validation, fail-closed host policy, and HMAC source identifier.
- Create `src/lib/otp/rateLimitStore.js`: bounded versioned-CAS phone/source documents and TTL indexes.
- Create `src/lib/otp/challengeStore.js`: rotating challenge persistence, challenge indexes, and conditional state transitions.
- Create `src/lib/otp/challengeService.js`: input validation, source/phone claims, provider selection, token rotation, and public challenge response.
- Create `src/lib/otp/firebaseEvidence.js`: Firebase Admin token verification, phone binding, provider binding, and freshness checks.
- Create `src/lib/otp/twilioFallback.js`: one-fallback reservation, bounded retry orchestration, send summaries, and Twilio verification classification.
- Create `src/lib/otp/bookingGrant.js`: atomic challenge/grant completion, leased non-transaction fallback, grant consumption, and grant release.
- Create `src/lib/otp/completionService.js`: stored-purpose/provider dispatch and minimized verified booking profile lookup.
- Create `src/lib/otp/client.js`: Axios API adapter and dependency-injected Firebase-first browser orchestration.
- Create `src/hooks/usePhoneOtp.js`: shared in-flight, resend cooldown, verifier cleanup, and flow state for booking/login UIs.
- Modify `src/lib/phoneAuth.js`: unique-container Firebase verifier registry with safe lifecycle.
- Modify `src/lib/twilioOTP.js`: Twilio-only provider operations and classifiers; remove automatic development/default-code behavior.
- Modify `src/lib/firebaseAdmin.js`: preserve singleton Storage and export singleton Admin Auth.

### HTTP and Authorization

- Create `src/app/api/otp/challenge/route.js`, `src/app/api/otp/fallback/route.js`, and `src/app/api/otp/complete/route.js`.
- Delete `src/app/api/otp/start/route.js` and `src/app/api/otp/verify/route.js` after callers migrate.
- Delete `src/app/api/appointments/user/route.js` after public/admin callers migrate.
- Create `src/lib/customerSession.js` and `src/app/api/customer/logout/route.js`.
- Create `src/lib/customerAppointments.js` for ownership-checked appointment reads/cancellation.
- Create `src/lib/adminAuth.js` for reusable endpoint-level role checks and cookie options.
- Create `src/lib/mongoTransactions.js` for shared transaction-support error classification.
- Modify appointment/customer/admin routes named in the tasks below; do not broaden unrelated API behavior.

### Frontend

- Modify `src/components/ui/AppointmentForm.jsx`, `src/components/ui/LoginPage.jsx`, `src/app/userAppointments/UserAppointmentsClient.js`, `src/components/admin/BookForCustomer.jsx`, and `src/app/admin/users/page.js`.
- Keep `src/app/appointments/AppointmentsClient.js` unchanged as the booking payload owner; it already forwards `verificationToken` and honors `onSubmit(data) === false`.

### Tests

- Create `vitest.config.mjs`, `tests/helpers/memoryOtpStores.js`, and focused files under `tests/otp`, `tests/auth`, `tests/appointments`, and `tests/security` listed by task.
- Keep Vitest in the Node environment; do not install jsdom or React Testing Library because security-critical browser orchestration is tested through dependency injection.

---

### Task 1: Establish the Vitest Harness and Baseline Phone Contract

**Files:**
- Modify: `package.json`
- Modify: `package-lock.json`
- Create: `vitest.config.mjs`
- Create: `tests/phone.test.js`

**Interfaces:**
- Consumes: existing `normalizeIsraeliPhone(input)` and `getWhatsAppLink(input)` from `src/lib/phone.js`.
- Produces: `npm run test`, `npm run test:run`, and the `@` alias available in all later Node tests.

- [ ] **Step 1: Verify the branch baseline before dependency changes**

Run:

```powershell
git status --short
git branch --show-current
npm run build
```

Expected: clean status, branch `codex/firebase-first-otp-customer-session`, and a passing baseline build with the ignored local environment present.

- [ ] **Step 2: Install only Vitest and add test scripts/configuration**

Run:

```powershell
npm install --save-dev vitest
```

Add these scripts to `package.json`:

```json
{
  "test": "vitest",
  "test:run": "vitest run"
}
```

Create `vitest.config.mjs`:

```js
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["tests/**/*.test.js"],
    clearMocks: true,
    restoreMocks: true,
  },
});
```

- [ ] **Step 3: Add the phone regression tests**

Create `tests/phone.test.js` with exact assertions for all accepted input forms and rejection cases:

```js
import { describe, expect, it } from "vitest";
import { getWhatsAppLink, normalizeIsraeliPhone } from "@/lib/phone";

describe("normalizeIsraeliPhone", () => {
  it.each([
    ["0521234567", "+972521234567"],
    ["+972521234567", "+972521234567"],
    ["00972521234567", "+972521234567"],
    ["052-123-4567", "+972521234567"],
  ])("normalizes %s", (input, expected) => {
    expect(normalizeIsraeliPhone(input)).toBe(expected);
  });

  it.each([null, "", "041234567", "+972421234567", "052123456", "05212345678"])(
    "rejects %s",
    (input) => expect(normalizeIsraeliPhone(input)).toBeNull(),
  );

  it("preserves the WhatsApp helper contract", () => {
    expect(getWhatsAppLink("0521234567")).toBe("https://wa.me/972521234567");
    expect(getWhatsAppLink("bad")).toBe("https://wa.me/");
  });
});
```

- [ ] **Step 4: Run the harness and commit**

Run:

```powershell
npm run test:run -- tests/phone.test.js
npm run test:run
git diff --check
```

Expected: all tests pass and no whitespace errors.

Commit:

```powershell
git add package.json package-lock.json vitest.config.mjs tests/phone.test.js
git commit -m "test: add OTP security test harness"
```

---

### Task 2: Define OTP Contracts and Firebase Send-Error Policy

**Files:**
- Create: `src/lib/otp/constants.js`
- Create: `src/lib/otp/errors.js`
- Create: `src/lib/otp/crypto.js`
- Create: `src/lib/otp/firebaseErrors.js`
- Create: `tests/otp/contracts.test.js`
- Create: `tests/otp/firebaseErrors.test.js`

**Interfaces:**
- Produces: `assertOtpPurpose(value)`, `selectInitialOtpProvider(env)`, `OtpError`, `createBearerToken()`, `hashBearerToken(token)`, `safeCompareDevelopmentCode(submitted, configured)`, `classifyFirebaseSendError(codeOrError)`, and `isServerApprovedFallbackCode(code)`.
- Constants: challenge TTL `600_000ms`, state retention `7_200_000ms`, completion lease `30_000ms`, grant TTL `600_000ms`, and two-minute Firebase clock-skew tolerance.

- [ ] **Step 1: Write failing contract and classifier tests**

Create `tests/otp/contracts.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  assertOtpPurpose,
  selectInitialOtpProvider,
} from "@/lib/otp/constants";
import { hashBearerToken, safeCompareDevelopmentCode } from "@/lib/otp/crypto";

describe("OTP contracts", () => {
  it.each(["booking", "login"])("accepts purpose %s", (purpose) => {
    expect(assertOtpPurpose(purpose)).toBe(purpose);
  });

  it.each([undefined, null, "", "admin", "booking "])("rejects purpose %s", (purpose) => {
    expect(() => assertOtpPurpose(purpose)).toThrowError(
      expect.objectContaining({ code: "INVALID_OTP_PURPOSE", status: 400 }),
    );
  });

  it("uses development only when an explicit non-production code exists", () => {
    expect(selectInitialOtpProvider({ NODE_ENV: "development" })).toBe("firebase");
    expect(
      selectInitialOtpProvider({ NODE_ENV: "development", OTP_DEV_CODE: "654321" }),
    ).toBe("development");
    expect(
      selectInitialOtpProvider({ NODE_ENV: "production", OTP_DEV_CODE: "654321" }),
    ).toBe("firebase");
  });

  it("hashes bearer values and compares only an explicitly configured dev code", () => {
    expect(hashBearerToken("plain-token")).toMatch(/^[a-f0-9]{64}$/);
    expect(hashBearerToken("plain-token")).not.toContain("plain-token");
    expect(safeCompareDevelopmentCode("654321", "654321")).toBe(true);
    expect(safeCompareDevelopmentCode("123456", undefined)).toBe(false);
  });
});
```

Create `tests/otp/firebaseErrors.test.js`:

```js
import { describe, expect, it } from "vitest";
import {
  classifyFirebaseSendError,
  isServerApprovedFallbackCode,
} from "@/lib/otp/firebaseErrors";

describe("Firebase send-error policy", () => {
  it.each([
    "auth/internal-error",
    "auth/operation-not-allowed",
    "auth/app-not-authorized",
    "auth/quota-exceeded",
  ])("allows technical SEND fallback for %s", (code) => {
    expect(classifyFirebaseSendError({ code })).toEqual({ action: "fallback", code });
    expect(isServerApprovedFallbackCode(code)).toBe(true);
  });

  it.each([
    "auth/invalid-verification-code",
    "auth/missing-verification-code",
    "auth/code-expired",
    "auth/too-many-requests",
    "auth/captcha-check-failed",
    "auth/missing-app-credential",
    "auth/invalid-app-credential",
    "auth/invalid-phone-number",
    "auth/user-disabled",
  ])("rejects fallback for %s", (code) => {
    expect(classifyFirebaseSendError({ code }).action).toBe("reject");
    expect(isServerApprovedFallbackCode(code)).toBe(false);
  });

  it("classifies a network failure as ambiguous rather than fallback", () => {
    expect(classifyFirebaseSendError({ code: "auth/network-request-failed" })).toEqual({
      action: "ambiguous",
      code: "auth/network-request-failed",
    });
  });
});
```

- [ ] **Step 2: Run the tests and confirm missing-module failures**

Run:

```powershell
npm run test:run -- tests/otp/contracts.test.js tests/otp/firebaseErrors.test.js
```

Expected: FAIL because the `src/lib/otp` modules do not exist.

- [ ] **Step 3: Implement the exact public contracts**

Use frozen sets and constants in `constants.js`; `selectInitialOtpProvider` must trim `OTP_DEV_CODE` and must never supply `123456`. Implement `OtpError` as:

```js
export class OtpError extends Error {
  constructor(code, status, message, retryAfterSeconds) {
    super(message);
    this.name = "OtpError";
    this.code = code;
    this.status = status;
    if (retryAfterSeconds) this.retryAfterSeconds = retryAfterSeconds;
  }
}
```

Implement the classifier with exactly three actions:

```js
const FALLBACK_CODES = new Set([
  "auth/internal-error",
  "auth/operation-not-allowed",
  "auth/app-not-authorized",
  "auth/quota-exceeded",
]);

export function classifyFirebaseSendError(value) {
  const code = typeof value === "string" ? value : value?.code || "auth/unknown";
  if (code === "auth/network-request-failed") return { action: "ambiguous", code };
  if (FALLBACK_CODES.has(code)) return { action: "fallback", code };
  return { action: "reject", code };
}
```

Use `crypto.randomBytes(32).toString("base64url")`, SHA-256 hex hashing, and equal-length `crypto.timingSafeEqual` for the crypto helpers.

- [ ] **Step 4: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/otp/contracts.test.js tests/otp/firebaseErrors.test.js
npm run test:run
git diff --check
```

Expected: all tests pass.

Commit:

```powershell
git add src/lib/otp tests/otp
git commit -m "feat: define OTP security contracts"
```

---

### Task 3: Add Trusted Source Identity and Bounded CAS Rate State

**Files:**
- Create: `src/lib/otp/sourceIdentity.js`
- Create: `src/lib/otp/rateLimitStore.js`
- Create: `tests/helpers/memoryOtpStores.js`
- Create: `tests/otp/sourceIdentity.test.js`
- Create: `tests/otp/rateLimitStore.test.js`

**Interfaces:**
- Consumes: rate constants and `OtpError` from Task 2.
- Produces: `deriveOtpSourceHash(request, options)`, `createOtpRateLimitStore({ phoneCollection, sourceCollection, clock })`, `claimPhoneStart(phone)`, `claimSourceAction(sourceHash, "challenge" | "fallback")`, `getPhoneVerifyLimit(phone)`, `recordPhoneVerifyFailure(phone)`, and `clearPhoneVerifyFailures(phone)`.
- State documents use a monotonically increasing `version`; every claim is a compare-and-swap loop and extends `expiresAt` by two hours.

- [ ] **Step 1: Write failing trusted-source tests**

Create `tests/otp/sourceIdentity.test.js`:

```js
import { describe, expect, it } from "vitest";
import { deriveOtpSourceHash } from "@/lib/otp/sourceIdentity";

const secret = "s".repeat(32);

describe("deriveOtpSourceHash", () => {
  it("uses Vercel's platform header only in a configured Vercel runtime", () => {
    const request = new Request("https://soulclinc.net/api/otp/challenge", {
      headers: {
        "x-vercel-forwarded-for": "203.0.113.9",
        "x-forwarded-for": "198.51.100.7",
      },
    });
    const hash = deriveOtpSourceHash(request, {
      env: { NODE_ENV: "production", VERCEL: "1", OTP_SOURCE_HASH_SECRET: secret },
    });
    expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hash).not.toContain("203.0.113.9");
  });

  it("does not let forwarded headers choose development buckets", () => {
    const first = deriveOtpSourceHash(
      new Request("http://localhost", { headers: { "x-forwarded-for": "1.1.1.1" } }),
      { env: { NODE_ENV: "development", OTP_SOURCE_HASH_SECRET: secret } },
    );
    const second = deriveOtpSourceHash(
      new Request("http://localhost", { headers: { "x-forwarded-for": "8.8.8.8" } }),
      { env: { NODE_ENV: "development", OTP_SOURCE_HASH_SECRET: secret } },
    );
    expect(first).toBe(second);
  });

  it.each([
    [{ NODE_ENV: "production", OTP_SOURCE_HASH_SECRET: secret }, { "x-forwarded-for": "1.1.1.1" }],
    [{ NODE_ENV: "production", VERCEL: "1", OTP_SOURCE_HASH_SECRET: secret }, { "x-vercel-forwarded-for": "bad-ip" }],
    [{ NODE_ENV: "production", VERCEL: "1" }, { "x-vercel-forwarded-for": "203.0.113.9" }],
  ])("fails closed when trusted source derivation is unavailable", (env, headers) => {
    expect(() => deriveOtpSourceHash(new Request("https://example.com", { headers }), { env }))
      .toThrowError(expect.objectContaining({ code: "OTP_SOURCE_UNAVAILABLE" }));
  });
});
```

- [ ] **Step 2: Write failing bounded-state tests**

Create a deterministic `MemoryVersionedCollection` in `tests/helpers/memoryOtpStores.js` with `findOne`, `insertOne`, `updateOne`, and `createIndex`; enforce unique `phone` or `sourceHash` keys and CAS on `_id + version`.

Create `tests/otp/rateLimitStore.test.js` with these concrete cases:

```js
it("rejects a second phone start inside 60 seconds", async () => {
  await store.claimPhoneStart("+972521234567");
  await expect(store.claimPhoneStart("+972521234567")).rejects.toMatchObject({
    code: "OTP_RATE_LIMITED",
    status: 429,
  });
  expect(phoneCollection.documents).toHaveLength(1);
});

it("rejects the sixth phone start inside one hour", async () => {
  for (let index = 0; index < 5; index += 1) {
    await store.claimPhoneStart("+972521234567");
    clock.advance(61_000);
  }
  await expect(store.claimPhoneStart("+972521234567")).rejects.toMatchObject({
    code: "OTP_RATE_LIMITED",
  });
  expect(phoneCollection.documents).toHaveLength(1);
});

it("limits challenge creation across different phone numbers by source", async () => {
  for (let index = 0; index < 10; index += 1) {
    await store.claimSourceAction("source-a", "challenge");
  }
  await expect(store.claimSourceAction("source-a", "challenge")).rejects.toMatchObject({
    code: "OTP_SOURCE_RATE_LIMITED",
  });
  expect(sourceCollection.documents).toHaveLength(1);
});

it("rejects the thirty-first source challenge inside one hour", async () => {
  for (let window = 0; window < 3; window += 1) {
    for (let index = 0; index < 10; index += 1) {
      await store.claimSourceAction("source-a", "challenge");
    }
    if (window < 2) clock.advance(10 * 60_000 + 1);
  }
  await expect(store.claimSourceAction("source-a", "challenge")).rejects.toMatchObject({
    code: "OTP_SOURCE_RATE_LIMITED",
  });
});

it("applies stricter fallback limits", async () => {
  await store.claimSourceAction("source-a", "fallback");
  await store.claimSourceAction("source-a", "fallback");
  await store.claimSourceAction("source-a", "fallback");
  await expect(store.claimSourceAction("source-a", "fallback")).rejects.toMatchObject({
    code: "OTP_FALLBACK_SOURCE_RATE_LIMITED",
  });
});

it("rejects the eleventh source fallback inside one hour", async () => {
  for (let window = 0; window < 3; window += 1) {
    for (let index = 0; index < 3; index += 1) {
      await store.claimSourceAction("source-a", "fallback");
    }
    clock.advance(10 * 60_000 + 1);
  }
  await store.claimSourceAction("source-a", "fallback");
  await expect(store.claimSourceAction("source-a", "fallback")).rejects.toMatchObject({
    code: "OTP_FALLBACK_SOURCE_RATE_LIMITED",
  });
});

it("stores one bounded verification counter without submitted values", async () => {
  await store.recordPhoneVerifyFailure("+972521234567");
  await store.recordPhoneVerifyFailure("+972521234567");
  expect(phoneCollection.documents).toHaveLength(1);
  expect(phoneCollection.documents[0]).toMatchObject({ verifyFailureCount: 2 });
  expect(JSON.stringify(phoneCollection.documents[0])).not.toContain("654321");
});
```

Add a `Promise.all` case proving concurrent CAS claims produce the exact accepted count and one document, plus index assertions for unique key and TTL `expireAfterSeconds: 0`.

- [ ] **Step 3: Run the tests and confirm missing-module failures**

Run:

```powershell
npm run test:run -- tests/otp/sourceIdentity.test.js tests/otp/rateLimitStore.test.js
```

Expected: FAIL because source identity and rate stores do not exist.

- [ ] **Step 4: Implement source derivation and CAS windows**

`deriveOtpSourceHash` must use `node:net` `isIP`, reject comma-separated/malformed Vercel values, use the fixed literal `development-local-source` outside production, and return an HMAC hex digest. It must never return or log the raw address.

The rate store must follow this loop for each mutation:

```js
for (let attempt = 0; attempt < 8; attempt += 1) {
  const current = await collection.findOne(key);
  const decision = evaluatePolicy(current, now, policy);
  if (!decision.allowed) throw new OtpError(decision.code, 429, decision.message, decision.retryAfterSeconds);

  if (!current) {
    try {
      await collection.insertOne({ ...key, ...decision.next, version: 1 });
      return decision.publicResult;
    } catch (error) {
      if (error?.code === 11000) continue;
      throw error;
    }
  }

  const result = await collection.updateOne(
    { _id: current._id, version: current.version },
    { $set: decision.next, $inc: { version: 1 } },
  );
  if (result.modifiedCount === 1) return decision.publicResult;
}
throw new OtpError("OTP_STATE_BUSY", 503, "OTP security state is busy.");
```

Window evaluation must reset expired counters before incrementing, calculate bounded `retryAfterSeconds`, maintain only summary fields from the spec, and create unique/TTL indexes on both state collections.

- [ ] **Step 5: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/otp/sourceIdentity.test.js tests/otp/rateLimitStore.test.js
npm run test:run
git diff --check
```

Expected: all tests pass.

Commit:

```powershell
git add src/lib/otp/sourceIdentity.js src/lib/otp/rateLimitStore.js tests/helpers tests/otp
git commit -m "feat: add bounded OTP source and phone limits"
```

---

### Task 4: Create Rotating Server Challenges and the Challenge API

**Files:**
- Create: `src/lib/otp/challengeStore.js`
- Create: `src/lib/otp/challengeService.js`
- Create: `src/app/api/otp/challenge/route.js`
- Create: `tests/otp/challengeService.test.js`
- Create: `tests/otp/challengeRoute.test.js`

**Interfaces:**
- Consumes: `deriveOtpSourceHash`, rate-store claims, token helpers, `assertOtpPurpose`, and `selectInitialOtpProvider`.
- Produces: `createOtpChallenge({ request, phone, purpose }, deps)` returning `{ challengeToken, provider, expiresAt, retryAfterSeconds }`; `challengeStore.findByTokenHash`, `rotate`, `reserveFallback`, `markTwilioSent`, `markTwilioFailure`, `completeLogin`, and completion lease operations used later.

- [ ] **Step 1: Write failing challenge-service tests**

Use memory stores and a deterministic token factory. Required assertions:

```js
it("creates a normalized booking challenge and stores only its hash", async () => {
  const result = await service.create({
    request,
    phone: "0521234567",
    purpose: "booking",
  });
  expect(result).toMatchObject({ provider: "firebase" });
  expect(result.challengeToken).toBe("challenge-plaintext");
  const [stored] = challengeStore.documents;
  expect(stored).toMatchObject({
    phone: "+972521234567",
    purpose: "booking",
    status: "pending",
    provider: "firebase",
    fallbackUsed: false,
  });
  expect(stored.challengeTokenHash).toBe(hashBearerToken("challenge-plaintext"));
  expect(JSON.stringify(stored)).not.toContain("challenge-plaintext");
});

it.each(["booking", "login"])("rotates one document for %s", async (purpose) => {
  await service.create({ request, phone: "0521234567", purpose });
  clock.advance(61_000);
  await service.create({ request, phone: "0521234567", purpose });
  expect(challengeStore.documents.filter((item) => item.purpose === purpose)).toHaveLength(1);
});

it("does not expose customer existence or profile data", async () => {
  const result = await service.create({ request, phone: "0521234567", purpose: "booking" });
  expect(result).not.toHaveProperty("exists");
  expect(result).not.toHaveProperty("firstName");
  expect(result).not.toHaveProperty("lastName");
  expect(usersCollection.findOne).not.toHaveBeenCalled();
});
```

Also test invalid phone, invalid purpose, ten-minute expiry, login purpose, explicit non-production development provider, production ignoring `OTP_DEV_CODE`, source claim before phone claim, and old token invalidation after rotation.

- [ ] **Step 2: Write failing route-validation tests**

In `tests/otp/challengeRoute.test.js`, mock `createOtpChallenge`, invoke `POST(new Request(...))`, and assert malformed JSON/invalid phone/invalid purpose produce safe `400` responses; `OtpError` rate failures preserve `429` and `retryAfterSeconds`; unexpected errors return `500` without stack/provider details.

- [ ] **Step 3: Run the focused tests and confirm failure**

Run:

```powershell
npm run test:run -- tests/otp/challengeService.test.js tests/otp/challengeRoute.test.js
```

Expected: FAIL because the store, service, and route do not exist.

- [ ] **Step 4: Implement rotation, indexes, service, and route**

Challenge rotation uses one `findOneAndUpdate` with `{ phone, purpose }`, `$set` of the complete fresh state, `$unset` of completion/fallback residue, `upsert: true`, and `returnDocument: "after"`. Create these indexes:

```js
await Promise.all([
  collection.createIndex({ phone: 1, purpose: 1 }, { unique: true, name: "otp_challenge_phone_purpose" }),
  collection.createIndex({ challengeTokenHash: 1 }, { unique: true, name: "otp_challenge_token_hash" }),
  collection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "otp_challenge_expires_ttl" }),
]);
```

The route must pass the actual `Request` into trusted-source derivation, parse only `{ phone, purpose }`, and serialize only the service's public result. Use stable error codes `INVALID_PHONE`, `INVALID_OTP_PURPOSE`, `OTP_RATE_LIMITED`, `OTP_SOURCE_RATE_LIMITED`, `OTP_SOURCE_UNAVAILABLE`, and `OTP_CHALLENGE_FAILED`.

- [ ] **Step 5: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/otp/challengeService.test.js tests/otp/challengeRoute.test.js
npm run test:run
git diff --check
```

Expected: all tests pass.

Commit:

```powershell
git add src/lib/otp/challengeStore.js src/lib/otp/challengeService.js src/app/api/otp/challenge tests/otp
git commit -m "feat: add server-owned OTP challenges"
```

---

### Task 5: Build the Firebase-First Browser Orchestrator and Safe reCAPTCHA Registry

**Files:**
- Modify: `src/lib/phoneAuth.js`
- Create: `src/lib/otp/client.js`
- Create: `src/hooks/usePhoneOtp.js`
- Create: `tests/otp/clientFlow.test.js`
- Create: `tests/otp/phoneAuth.test.js`

**Interfaces:**
- Consumes: `classifyFirebaseSendError` and the three new OTP HTTP endpoints.
- Produces: `sendFirebaseOtp(phone, containerId)`, `clearFirebaseRecaptcha(containerId)`, `createOtpApiClient(httpClient)`, `startOtpClientFlow(args)`, `completeOtpClientFlow(args)`, and `usePhoneOtp({ purpose, recaptchaContainerId })`.
- Hook result: `{ phase, provider, loading, error, cooldownSeconds, start, verify, resend, reset }`; `verify(code)` resolves to the public completion payload.

- [ ] **Step 1: Write failing client-orchestration tests**

Create `tests/otp/clientFlow.test.js` using only mocked dependencies:

```js
import { describe, expect, it, vi } from "vitest";
import {
  completeOtpClientFlow,
  startOtpClientFlow,
} from "@/lib/otp/client";

function createApi() {
  return {
    challenge: vi.fn().mockResolvedValue({
      challengeToken: "challenge-token",
      provider: "firebase",
      retryAfterSeconds: 60,
    }),
    fallback: vi.fn().mockResolvedValue({ provider: "twilio" }),
    complete: vi.fn().mockResolvedValue({ success: true, purpose: "booking" }),
  };
}

it("obtains a backend challenge before sending Firebase OTP", async () => {
  const order = [];
  const api = createApi();
  api.challenge.mockImplementation(async () => {
    order.push("challenge");
    return { challengeToken: "challenge-token", provider: "firebase" };
  });
  const sendFirebaseOtp = vi.fn(async () => {
    order.push("firebase");
    return { confirm: vi.fn() };
  });
  await startOtpClientFlow({
    phone: "+972521234567",
    purpose: "booking",
    containerId: "appointment-recaptcha",
    api,
    sendFirebaseOtp,
    clearFirebaseRecaptcha: vi.fn(),
  });
  expect(order).toEqual(["challenge", "firebase"]);
});

it("requests fallback once for an eligible Firebase SEND failure", async () => {
  const api = createApi();
  const firebaseError = Object.assign(new Error("send failed"), {
    code: "auth/internal-error",
  });
  const flow = await startOtpClientFlow({
    phone: "+972521234567",
    purpose: "booking",
    containerId: "appointment-recaptcha",
    api,
    sendFirebaseOtp: vi.fn().mockRejectedValue(firebaseError),
    clearFirebaseRecaptcha: vi.fn(),
  });
  expect(api.fallback).toHaveBeenCalledTimes(1);
  expect(api.fallback).toHaveBeenCalledWith({
    challengeToken: "challenge-token",
    firebaseErrorCode: "auth/internal-error",
  });
  expect(flow.provider).toBe("twilio");
});

it.each([
  "auth/too-many-requests",
  "auth/captcha-check-failed",
  "auth/invalid-phone-number",
  "auth/network-request-failed",
])("never requests fallback for %s", async (code) => {
  const api = createApi();
  await expect(
    startOtpClientFlow({
      phone: "+972521234567",
      purpose: "booking",
      containerId: "appointment-recaptcha",
      api,
      sendFirebaseOtp: vi.fn().mockRejectedValue(Object.assign(new Error(code), { code })),
      clearFirebaseRecaptcha: vi.fn(),
    }),
  ).rejects.toMatchObject({ code });
  expect(api.fallback).not.toHaveBeenCalled();
});

it("never falls back when Firebase code confirmation fails", async () => {
  const api = createApi();
  const flow = {
    challengeToken: "challenge-token",
    provider: "firebase",
    confirmationResult: {
      confirm: vi.fn().mockRejectedValue(
        Object.assign(new Error("wrong code"), { code: "auth/invalid-verification-code" }),
      ),
    },
  };
  await expect(completeOtpClientFlow({ flow, code: "000000", api })).rejects.toMatchObject({
    code: "auth/invalid-verification-code",
  });
  expect(api.fallback).not.toHaveBeenCalled();
  expect(api.complete).not.toHaveBeenCalled();
});

it("sends only a transient Firebase ID token to completion", async () => {
  const api = createApi();
  const getIdToken = vi.fn().mockResolvedValue("firebase-id-token");
  await completeOtpClientFlow({
    flow: {
      challengeToken: "challenge-token",
      provider: "firebase",
      confirmationResult: {
        confirm: vi.fn().mockResolvedValue({ user: { getIdToken } }),
      },
    },
    code: "654321",
    api,
  });
  expect(api.complete).toHaveBeenCalledWith({
    challengeToken: "challenge-token",
    provider: "firebase",
    idToken: "firebase-id-token",
  });
});
```

- [ ] **Step 2: Write failing verifier-lifecycle tests**

In `tests/otp/phoneAuth.test.js`, mock `firebase/auth` and `@/lib/firebase`, install minimal `global.window`/`global.document` objects, then assert:

```js
expect(RecaptchaVerifier).toHaveBeenCalledWith(
  auth,
  "appointment-recaptcha",
  expect.objectContaining({ size: "invisible" }),
);
expect(RecaptchaVerifier).toHaveBeenCalledWith(
  auth,
  "login-recaptcha",
  expect.objectContaining({ size: "invisible" }),
);
```

Also prove different container IDs receive different verifier instances, `clear()` is called at most once per instance, a send failure rethrows the exact original error, cleanup waits until `signInWithPhoneNumber` settles, a missing container throws before Firebase is called, and a container object whose `innerHTML` setter throws is never mutated.

- [ ] **Step 3: Run tests and confirm the old single-global implementation fails**

Run:

```powershell
npm run test:run -- tests/otp/clientFlow.test.js tests/otp/phoneAuth.test.js
```

Expected: FAIL because the new APIs do not exist and `phoneAuth.js` still owns one global container/verifier.

- [ ] **Step 4: Implement the client API and flow functions**

`createOtpApiClient` must use Axios only:

```js
export function createOtpApiClient(http = axios) {
  return {
    challenge: async (payload) => (await http.post("/api/otp/challenge", payload)).data,
    fallback: async (payload) => (await http.post("/api/otp/fallback", payload)).data,
    complete: async (payload) => (await http.post("/api/otp/complete", payload)).data,
  };
}
```

`startOtpClientFlow` returns a development code-entry flow without calling Firebase when the challenge provider is `development`; for Firebase it retains only the in-memory `ConfirmationResult`; eligible send failure clears that container and calls fallback exactly once. Ambiguous errors receive code `auth/network-request-failed` and remain outside Twilio.

`completeOtpClientFlow` confirms Firebase locally, immediately obtains `credential.user.getIdToken()`, posts it, and drops local references on success. Twilio/development completion posts `{ challengeToken, provider, code }` and never sends a phone/purpose.

- [ ] **Step 5: Refactor `phoneAuth.js` and add the shared hook**

Replace `window.recaptchaVerifier` with module-scoped maps keyed by `containerId`:

```js
const verifiers = new Map();
const sendsInProgress = new Set();
const pendingClears = new Set();
```

Create verifiers only in a browser and only after `document.getElementById(containerId)` succeeds. Use modern Firebase 12 ordering:

```js
new RecaptchaVerifier(auth, containerId, {
  size: "invisible",
  "expired-callback": () => clearFirebaseRecaptcha(containerId),
});
```

`clearFirebaseRecaptcha` calls only Firebase's `verifier.clear()`, deletes map state, and never removes/empties DOM. Preserve safe logs of phone, hostname, error code/message/customData and rethrow the original Firebase error.

The hook must guard `start`, `verify`, and `resend` with one in-flight ref, keep challenge/confirmation only in refs, count down server-provided cooldown with `setTimeout`, call `clearFirebaseRecaptcha(recaptchaContainerId)` on reset/unmount/provider transition, and expose stable callbacks to both components.

- [ ] **Step 6: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/otp/clientFlow.test.js tests/otp/phoneAuth.test.js
npm run test:run
git diff --check
```

Expected: all tests pass.

Commit:

```powershell
git add src/lib/phoneAuth.js src/lib/otp/client.js src/hooks/usePhoneOtp.js tests/otp
git commit -m "feat: add Firebase-first OTP client flow"
```

---

### Task 6: Verify Fresh Firebase Phone Evidence with Firebase Admin

**Files:**
- Modify: `src/lib/firebaseAdmin.js`
- Create: `src/lib/otp/firebaseEvidence.js`
- Create: `tests/otp/firebaseEvidence.test.js`

**Interfaces:**
- Consumes: an active challenge containing `phone`, `createdAt`, `provider`, and `status`.
- Produces: `firebaseAdminAuth` alongside the existing `bucket`; `verifyFirebaseEvidence({ idToken, challenge, now }, deps)` returning the normalized verified phone or throwing an `OtpError`.

- [ ] **Step 1: Write failing Firebase evidence tests**

Create `tests/otp/firebaseEvidence.test.js` with a mocked `verifyIdToken` and fixed challenge time:

```js
const createdAt = new Date("2026-08-23T12:00:00.000Z");
const now = new Date("2026-08-23T12:01:00.000Z");
const challenge = {
  phone: "+972521234567",
  provider: "firebase",
  status: "pending",
  createdAt,
  expiresAt: new Date("2026-08-23T12:10:00.000Z"),
};

it("accepts a fresh matching Firebase phone token", async () => {
  const adminAuth = {
    verifyIdToken: vi.fn().mockResolvedValue({
      phone_number: "+972521234567",
      auth_time: Math.floor(createdAt.getTime() / 1000),
      firebase: { sign_in_provider: "phone" },
    }),
  };
  await expect(
    verifyFirebaseEvidence({ idToken: "transient-token", challenge, now }, { adminAuth }),
  ).resolves.toBe("+972521234567");
});
```

Add rejection cases for invalid token, absent/malformed phone, wrong phone, non-phone provider, `auth_time` older than `createdAt - 120 seconds`, `auth_time` later than `now + 120 seconds`, wrong challenge provider/status, and expired challenge. Assert errors/log arguments never contain the input token.

- [ ] **Step 2: Run the focused test and confirm failure**

Run:

```powershell
npm run test:run -- tests/otp/firebaseEvidence.test.js
```

Expected: FAIL because `firebaseEvidence.js` and `firebaseAdminAuth` do not exist.

- [ ] **Step 3: Extend the existing singleton Admin app safely**

Use modular Admin imports while preserving Storage behavior:

```js
import { cert, getApp, getApps, initializeApp } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getStorage } from "firebase-admin/storage";

const app = getApps().length ? getApp() : initializeApp({
  credential: cert({
    projectId: process.env.FIREBASE_PROJECT_ID,
    clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
    privateKey: process.env.FIREBASE_PRIVATE_KEY?.replace(/\\n/g, "\n"),
  }),
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
});

export const firebaseAdminAuth = getAuth(app);
export const bucket = getStorage(app).bucket();
export default app;
```

Do not log configuration values. Run the build after this edit to catch Storage compatibility immediately.

- [ ] **Step 4: Implement identity/provider/freshness checks**

Call `adminAuth.verifyIdToken(idToken)` exactly once. Normalize `decoded.phone_number`, require `decoded.firebase?.sign_in_provider === "phone"`, compare to the stored challenge phone, and compare second-based `auth_time` against challenge creation/current time with the two-minute skew. Convert provider exceptions to `INVALID_FIREBASE_TOKEN` without copying provider messages into the response.

- [ ] **Step 5: Run tests/build and commit**

Run:

```powershell
npm run test:run -- tests/otp/firebaseEvidence.test.js
npm run test:run
npm run build
git diff --check
```

Expected: tests and build pass; upload routes retain the same `bucket` export.

Commit:

```powershell
git add src/lib/firebaseAdmin.js src/lib/otp/firebaseEvidence.js tests/otp/firebaseEvidence.test.js
git commit -m "feat: verify Firebase phone evidence"
```

---

### Task 7: Implement Source-Limited One-Time Twilio Fallback

**Files:**
- Modify: `src/lib/twilioOTP.js`
- Create: `src/lib/otp/twilioFallback.js`
- Create: `src/app/api/otp/fallback/route.js`
- Create: `tests/otp/twilioFallback.test.js`
- Create: `tests/otp/fallbackRoute.test.js`

**Interfaces:**
- Consumes: active Firebase challenge, source fallback claim, server error allowlist, challenge conditional transitions, and existing `getTwilioClient()`/config.
- Produces: `sendTwilioVerification(phone)`, `verifyTwilioCode(phone, code)`, `classifyTwilioSendError(error)`, `classifyTwilioVerifyError(error)`, and `requestTwilioFallback({ request, challengeToken, firebaseErrorCode }, deps)`.

- [ ] **Step 1: Write failing fallback service tests**

Required cases in `tests/otp/twilioFallback.test.js`:

```js
it("uses the stored challenge phone for one approved fallback", async () => {
  const result = await requestTwilioFallback(
    { request, challengeToken: "challenge-token", firebaseErrorCode: "auth/internal-error" },
    deps,
  );
  expect(deps.sendVerification).toHaveBeenCalledWith("+972521234567");
  expect(result).toMatchObject({ provider: "twilio", status: "pending" });
  expect(challengeStore.current).toMatchObject({
    provider: "twilio",
    status: "twilio_sent",
    fallbackUsed: true,
    providerAttemptCount: 1,
  });
});

it("allows only one fallback reservation per challenge", async () => {
  await requestTwilioFallback(validRequest, deps);
  await expect(requestTwilioFallback(validRequest, deps)).rejects.toMatchObject({
    code: "OTP_FALLBACK_ALREADY_USED",
  });
  expect(deps.sendVerification).toHaveBeenCalledTimes(1);
});

it.each([
  "auth/invalid-verification-code",
  "auth/too-many-requests",
  "auth/captcha-check-failed",
  "auth/network-request-failed",
])("rejects unapproved browser report %s without Twilio", async (firebaseErrorCode) => {
  await expect(
    requestTwilioFallback({ ...validRequest, firebaseErrorCode }, deps),
  ).rejects.toBeDefined();
  expect(deps.sendVerification).not.toHaveBeenCalled();
});
```

Also test: a random invalid challenge token does not create source state; every valid-challenge attempt consumes source capacity before allowlist rejection; fourth short-window fallback is `429`; source limits span phone numbers; concurrent requests produce one reservation/send; retryable pre-delivery/5xx failures make at most three calls; timeout/socket ambiguity makes one call and status `delivery_unknown`; permanent/configuration failures make one call and status `failed`; challenge stores only aggregate safe fields.

- [ ] **Step 2: Write failing fallback route tests**

Test malformed payload (`400`), unsupported report (`400`), already-used fallback (`409`), source rate limit (`429` plus retry), missing Twilio configuration (`503`), ambiguous delivery (`503` with safe pending message), and success. Response bodies must not include Twilio SID, raw Twilio body, phone, or provider error message.

- [ ] **Step 3: Run tests and confirm failures**

Run:

```powershell
npm run test:run -- tests/otp/twilioFallback.test.js tests/otp/fallbackRoute.test.js
```

Expected: FAIL because fallback service/route do not exist and `twilioOTP.js` still mixes development behavior.

- [ ] **Step 4: Make `twilioOTP.js` Twilio-only**

Remove `DEVELOPMENT_OTP_CODE`, `getStoredOtpCode`, `getOtpSuccessMessage`, `isDevelopmentOtpMode`, and automatic provider selection. Keep provider SDK calls behind:

```js
export async function sendTwilioVerification(phone) {
  const client = getTwilioClient();
  const { serviceSid } = getTwilioVerifyConfig();
  return client.verify.v2.services(serviceSid).verifications.create({
    to: phone,
    channel: "sms",
  });
}

export async function verifyTwilioCode(phone, code) {
  const client = getTwilioClient();
  const { serviceSid } = getTwilioVerifyConfig();
  return client.verify.v2.services(serviceSid).verificationChecks.create({ to: phone, code });
}
```

Do not log phone/code or return SID from the fallback API.

- [ ] **Step 5: Implement reservation, retry policy, and route**

Order operations exactly: hash/find valid active challenge; claim source fallback slot; verify Firebase provider/status; validate server allowlist; CAS `{ fallbackUsed: false, provider: "firebase", status: "pending" }` to `twilio_sending`; perform up to three classified sends; update the same challenge after every result. Never retry `ETIMEDOUT`, `ESOCKETTIMEDOUT`, `ECONNRESET`, `EPIPE`, or unknown socket delivery.

The route accepts only `{ challengeToken, firebaseErrorCode }`, derives source from the request, and maps typed errors to safe responses.

- [ ] **Step 6: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/otp/twilioFallback.test.js tests/otp/fallbackRoute.test.js
npm run test:run
git diff --check
```

Expected: all tests pass and no old attempt collection is touched.

Commit:

```powershell
git add src/lib/twilioOTP.js src/lib/otp/twilioFallback.js src/app/api/otp/fallback tests/otp
git commit -m "feat: add controlled Twilio OTP fallback"
```

---

### Task 8: Make Booking Challenge Completion and Grant Creation Atomic

**Files:**
- Create: `src/lib/mongoTransactions.js`
- Create: `src/lib/otp/bookingGrant.js`
- Create: `tests/otp/bookingGrant.test.js`
- Modify: `tests/helpers/memoryOtpStores.js`

**Interfaces:**
- Consumes: challenge/grant collections, Mongo client, token helpers, ten-minute grant TTL, and a provider-verified active challenge.
- Produces: `issueBookingGrant({ challenge, challengeTokenHash }, deps)`, `consumeBookingGrant({ phone, verificationToken, appointmentId, session })`, `releaseBookingGrant(args)`, `OtpVerificationGrantError`, and `isTransactionUnsupportedError(error)`.
- Grant records: `{ challengeId, completionId, phone, tokenHash, status: "prepared", used, usedAt, appointmentId, createdAt, expiresAt }`; only a linked challenge with `status: "completed"` and the same `completionId` makes a prepared grant usable.

- [ ] **Step 1: Write failing transaction and concurrency tests**

Create `tests/otp/bookingGrant.test.js` with snapshot-capable in-memory transaction fakes. Required transaction assertions:

```js
it("commits challenge completion and exactly one matching grant together", async () => {
  const result = await issueBookingGrant({ challenge, challengeTokenHash }, deps);
  expect(result.verificationToken).toBeDefined();
  expect(challenges.current).toMatchObject({ status: "completed" });
  expect(grants.documents).toHaveLength(1);
  expect(grants.documents[0]).toMatchObject({
    challengeId: challenge._id,
    completionId: challenges.current.completionId,
    phone: challenge.phone,
    status: "prepared",
    used: false,
  });
  expect(JSON.stringify(grants.documents[0])).not.toContain(result.verificationToken);
});

it("rolls back both documents when grant insertion fails in a transaction", async () => {
  grants.failNextPrepare = true;
  await expect(issueBookingGrant({ challenge, challengeTokenHash }, deps)).rejects.toBeDefined();
  expect(challenges.current.status).toBe("pending");
  expect(grants.documents).toHaveLength(0);
});

it("allows one winner under concurrent completion", async () => {
  const results = await Promise.allSettled([
    issueBookingGrant({ challenge, challengeTokenHash }, deps),
    issueBookingGrant({ challenge, challengeTokenHash }, deps),
  ]);
  expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
  expect(grants.documents).toHaveLength(1);
});
```

- [ ] **Step 2: Write failing non-transaction fault-injection tests**

Force `isTransactionUnsupportedError` and test each stage:

- grant prepare failure restores `pending`/`twilio_sent` and leaves no prepared record;
- final challenge CAS failure deletes the matching prepared grant and restores the previous status;
- simulated process exit after prepare leaves `completing` plus a non-usable prepared record; after advancing 31 seconds the next call deletes it, restores, and creates one new grant;
- a prepared grant linked to `completing` is rejected by `consumeBookingGrant`;
- a prepared grant linked to completed challenge consumes exactly once, checks phone binding/expiry, and can be conditionally released for appointment rollback;
- duplicate grant upsert by `challengeId` cannot create a second record.

Use error codes `OTP_COMPLETION_IN_PROGRESS`, `OTP_CHALLENGE_ALREADY_COMPLETED`, `OTP_VERIFICATION_REQUIRED`, `OTP_VERIFICATION_INVALID`, `OTP_VERIFICATION_EXPIRED`, and `OTP_VERIFICATION_ALREADY_USED`.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```powershell
npm run test:run -- tests/otp/bookingGrant.test.js
```

Expected: FAIL because the grant coordinator does not exist.

- [ ] **Step 4: Implement preferred Mongo transaction completion**

Generate plaintext/token hash and `completionId` before starting the transaction. In `session.withTransaction`, conditionally update the exact challenge `_id + challengeTokenHash + provider/status + unexpired` to completed, then insert the prepared grant with the same `completionId`. Return plaintext only after `withTransaction` resolves. Add grant indexes:

```js
await Promise.all([
  grants.createIndex({ tokenHash: 1 }, { unique: true, name: "otp_grant_unique_tokenHash" }),
  grants.createIndex(
    { challengeId: 1 },
    {
      unique: true,
      name: "otp_grant_unique_challenge",
      partialFilterExpression: { challengeId: { $type: "objectId" } },
    },
  ),
  grants.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0, name: "otp_grant_expiresAt_ttl" }),
]);
```

The partial index must tolerate legacy grant documents lacking `challengeId`; do not drop the collection.

- [ ] **Step 5: Implement the leased fallback and grant consumer**

Use the four-step protocol from the spec: CAS to `completing` with `completionPreviousStatus` and 30-second lease; idempotent prepared-grant upsert; confirm the record; CAS challenge to completed. Compensation conditionally deletes only the same `challengeId + completionId` record and restores only the same active lease. Recovery runs before every reservation when an expired `completing` challenge is observed.

`consumeBookingGrant` must read the candidate grant, read its linked challenge in the same optional session, require matching completed `completionId`, then CAS `used: false` to used. Legacy unlinked grants are invalid after cutover.

- [ ] **Step 6: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/otp/bookingGrant.test.js
npm run test:run
git diff --check
```

Expected: all success, fault-injection, and concurrency tests pass.

Commit:

```powershell
git add src/lib/mongoTransactions.js src/lib/otp/bookingGrant.js tests/helpers tests/otp/bookingGrant.test.js
git commit -m "feat: complete booking OTP atomically"
```

---

### Task 9: Unify Provider Completion for Booking Purpose

**Files:**
- Create: `src/lib/otp/completionService.js`
- Create: `src/app/api/otp/complete/route.js`
- Create: `tests/otp/completionService.test.js`
- Create: `tests/otp/completeRoute.test.js`

**Interfaces:**
- Consumes: challenge lookup, Firebase evidence verifier, Twilio verifier/classifier, bounded phone verification counters, explicit development code, booking grant issuer, and `usersData` profile lookup.
- Produces: `completeOtpChallenge(payload, deps)`; booking result `{ success: true, purpose: "booking", verificationToken, expiresInSeconds, profile }` where profile is either `{ hasCompleteName: false }` or `{ hasCompleteName: true, firstName, lastName }`.
- Until Task 11 installs the real login handler, login purpose returns `OTP_LOGIN_COMPLETION_UNAVAILABLE` without changing the challenge.

- [ ] **Step 1: Write failing provider-completion tests**

Create `tests/otp/completionService.test.js` with a common active challenge and injected fakes. Required Firebase cases:

```js
it("uses Firebase evidence and the stored challenge phone/purpose", async () => {
  const result = await completeOtpChallenge(
    {
      challengeToken: "challenge-token",
      provider: "firebase",
      idToken: "transient-id-token",
      phone: "+972599999999",
      purpose: "login",
    },
    deps,
  );
  expect(deps.verifyFirebaseEvidence).toHaveBeenCalledWith(
    expect.objectContaining({ idToken: "transient-id-token", challenge }),
  );
  expect(deps.issueBookingGrant).toHaveBeenCalledWith(
    expect.objectContaining({ challenge }),
  );
  expect(result.purpose).toBe("booking");
});
```

Add valid token, invalid token, wrong token phone, non-phone provider, stale auth, future auth, expired challenge, wrong challenge provider/status, and already-completed rejection. Inspect every fake persisted document and logger call to prove `transient-id-token` is absent.

Required Twilio/development cases:

- Twilio verification uses only `challenge.phone`, accepts only status `approved`, clears bounded failures on success, increments the one phone-state counter on non-approved/invalid-code responses, and returns `OTP_VERIFY_RATE_LIMITED` after five failures.
- Twilio 5xx/timeout technical verification returns `OTP_VERIFY_TEMPORARY_FAILURE` and never calls `sendTwilioVerification` or fallback.
- Development succeeds only for a development-provider challenge, non-production env, and explicit matching `OTP_DEV_CODE`; wrong code increments the bounded counter; production always rejects development.
- Payload phone/purpose are ignored; malformed/missing provider evidence is rejected.

- [ ] **Step 2: Write failing booking-profile and route tests**

Add service tests proving profile lookup happens only after provider evidence succeeds and before challenge completion. For a complete profile assert trimmed first/last name; for missing/new profile assert exactly `{ hasCompleteName: false }` without an `exists` field.

In `tests/otp/completeRoute.test.js`, assert:

- Firebase payload accepts only challenge token/provider/ID token.
- Twilio/development payload accepts only challenge token/provider/code.
- Booking success includes no phone, ID token, challenge token, customer session, or provider raw data.
- Typed auth/rate/already-completed errors map to `400/401/409/429` safely.
- Login purpose returns safe `503` and remains uncompleted until Task 11.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```powershell
npm run test:run -- tests/otp/completionService.test.js tests/otp/completeRoute.test.js
```

Expected: FAIL because completion service/route do not exist.

- [ ] **Step 4: Implement evidence dispatch without storing evidence**

Load the challenge by SHA-256 token hash, reject expiry/completion/in-progress, and require `payload.provider === challenge.provider`. Dispatch evidence as follows:

```js
switch (challenge.provider) {
  case "firebase":
    await verifyFirebaseEvidence({ idToken: payload.idToken, challenge, now }, deps);
    break;
  case "twilio":
    await verifyStoredPhoneWithTwilio({ challenge, code: payload.code }, deps);
    break;
  case "development":
    await verifyDevelopmentChallenge({ challenge, code: payload.code, env }, deps);
    break;
  default:
    throw new OtpError("OTP_PROVIDER_MISMATCH", 400, "OTP provider mismatch.");
}
```

Do not pass payload evidence into store methods or logger objects.

- [ ] **Step 5: Implement booking purpose and minimized profile response**

After successful evidence, query `usersData` by the stored normalized phone with projection `{ firstName: 1, lastName: 1 }`. Trim both values. Read failure occurs before completion so the challenge remains retryable. Then call `issueBookingGrant`; return its plaintext token once and the minimized profile. For stored purpose `login`, throw `OTP_LOGIN_COMPLETION_UNAVAILABLE` before any state transition.

- [ ] **Step 6: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/otp/completionService.test.js tests/otp/completeRoute.test.js
npm run test:run
git diff --check
```

Expected: all booking completion tests pass.

Commit:

```powershell
git add src/lib/otp/completionService.js src/app/api/otp/complete tests/otp
git commit -m "feat: unify OTP booking completion"
```

---

### Task 10: Remove Pre-OTP PII Lookup and Migrate Public Booking

**Files:**
- Create: `src/lib/adminAuth.js`
- Modify: `src/app/api/admin/users/route.js`
- Modify: `src/app/api/admin/attendance/route.js`
- Modify: `src/app/api/admin/admin-notes/route.js`
- Modify: `src/components/admin/BookForCustomer.jsx`
- Modify: `src/components/ui/AppointmentForm.jsx`
- Modify: `src/lib/appointmentBooking.js`
- Modify: `src/app/api/appointments/route.js`
- Delete: `src/app/api/appointments/user/route.js`
- Create: `tests/auth/adminAuth.test.js`
- Create: `tests/security/customerLookup.test.js`
- Create: `tests/appointments/publicBookingOtp.test.js`

**Interfaces:**
- Consumes: `usePhoneOtp({ purpose: "booking" })`, booking completion profile/grant, and Task 8 grant consumer.
- Produces: `requireAdmin(request)`, `withAdminRoute(handler)`, authenticated `/api/admin/users?phone=...`, and a public booking UI that sends OTP before obtaining customer profile data.
- Public booking outcome remains: existing complete name submits directly after OTP; new/incomplete profile collects both names after OTP; `onSubmit(data) === false` never shows success.

- [ ] **Step 1: Write failing admin-auth and lookup-boundary tests**

Create `tests/auth/adminAuth.test.js`:

```js
it("rejects missing and invalid admin cookies", () => {
  expect(() => requireAdmin(requestWithoutCookie)).toThrowError(
    expect.objectContaining({ code: "UNAUTHORIZED", status: 401 }),
  );
  expect(() => requireAdmin(requestWithInvalidCookie)).toThrowError(
    expect.objectContaining({ code: "UNAUTHORIZED", status: 401 }),
  );
});

it("rejects a valid non-admin token", () => {
  expect(() => requireAdmin(requestWithUserCookie)).toThrowError(
    expect.objectContaining({ code: "FORBIDDEN", status: 403 }),
  );
});

it("returns a role-checked admin payload", () => {
  expect(requireAdmin(requestWithAdminCookie)).toMatchObject({ role: "admin" });
});
```

Create `tests/security/customerLookup.test.js` that asserts:

```js
expect(existsSync("src/app/api/appointments/user/route.js")).toBe(false);
expect(readFileSync("src/components/ui/AppointmentForm.jsx", "utf8"))
  .not.toContain("/api/appointments/user");
expect(readFileSync("src/components/admin/BookForCustomer.jsx", "utf8"))
  .toContain("/api/admin/users");
```

Mock each audited admin PII route and prove missing cookie returns `401` before `getCollection`; non-admin returns `403`; authenticated `/api/admin/users?phone=052...` returns only `{ exists, phone, firstName, lastName }`. Also prove challenge output contains no customer fields and failed completion evidence never calls profile lookup.

- [ ] **Step 2: Write failing public-booking grant tests**

In `tests/appointments/publicBookingOtp.test.js`, mock `createAppointmentBooking` and assert `POST /api/appointments` always invokes it with `{ requireOtp: true }`. Make the mock throw each `OtpVerificationGrantError` and assert missing, wrong-phone, expired, and reused grants map to `401/409`. Add a source guard proving `appointmentBooking.js` imports `consumeBookingGrant`/`releaseBookingGrant` from the new module and no longer imports `otpSecurity.js`.

- [ ] **Step 3: Run tests and confirm the existing lookup/boundaries fail**

Run:

```powershell
npm run test:run -- tests/auth/adminAuth.test.js tests/security/customerLookup.test.js tests/appointments/publicBookingOtp.test.js
```

Expected: FAIL because the public route exists, admin PII routes lack endpoint auth, and booking imports the legacy grant helper.

- [ ] **Step 4: Add the shared admin boundary and authenticated lookup**

`requireAdmin` reads only cookie `token`, calls existing `verifyToken`, returns `401` for absent/invalid and `403` for `role !== "admin"`. `withAdminRoute` catches only `AdminAuthError` and leaves handler errors to the route's existing error handling.

Wrap every method in `admin/users`, `admin/attendance`, and `admin/admin-notes`. Add optional phone behavior to authenticated admin users GET:

```js
const rawPhone = new URL(req.url).searchParams.get("phone");
if (rawPhone) {
  const phone = normalizeIsraeliPhone(rawPhone);
  if (!phone) return NextResponse.json({ error: "INVALID_PHONE" }, { status: 400 });
  const user = await users.findOne(
    { phone },
    { projection: { _id: 0, firstName: 1, lastName: 1 } },
  );
  return NextResponse.json({
    exists: Boolean(user),
    phone,
    firstName: user?.firstName || "",
    lastName: user?.lastName || "",
  });
}
```

Keep the existing authenticated all-users response for the admin users page. Change `BookForCustomer`'s Axios lookup URL to `/api/admin/users`; same-origin cookies require no frontend token handling.

- [ ] **Step 5: Migrate `AppointmentForm` to verified-profile-first name handling**

Use unique stable container ID `appointment-recaptcha-container`. Remove `handleLookupUser`, pre-OTP `details`, backend confirmation shim, direct OTP APIs, and `fetch`. Phone submit calls `otpFlow.start(normalizedPhone)` for every customer. OTP verify does:

```js
const completion = await otpFlow.verify(otp.trim());
const verificationToken = completion.verificationToken;

if (!completion.profile?.hasCompleteName) {
  setPendingVerificationToken(verificationToken);
  setStep("details");
  return;
}

const submitted = await onSubmit({
  ...data,
  phone: normalizedPhone,
  firstName: completion.profile.firstName,
  lastName: completion.profile.lastName,
  verificationToken,
});
if (submitted !== false) setStep("success");
```

The post-verification details submit requires both names and uses the pending grant. Resend calls the hook exactly once and obeys server cooldown. Existing name is shown only from successful completion. Keep note, selected date/time checks, booking error display, loading states, and `onSubmit(false)` behavior.

- [ ] **Step 6: Switch appointment booking to the linked grant module and delete public lookup**

Replace `consumeOtpVerificationGrant`/`releaseOtpVerificationGrant` imports with Task 8 names; preserve transaction and release-on-failed-appointment behavior. Export/import the new `OtpVerificationGrantError` in the route. Delete `src/app/api/appointments/user/route.js` only after both frontend callers are migrated.

- [ ] **Step 7: Run focused tests, accumulated tests, and build**

Run:

```powershell
npm run test:run -- tests/auth/adminAuth.test.js tests/security/customerLookup.test.js tests/appointments/publicBookingOtp.test.js
npm run test:run
npm run build
git diff --check
```

Expected: all tests/build pass; arbitrary unauthenticated phone lookup cannot return names; admin manual booking still finds existing customers with its cookie.

Commit:

```powershell
git add src/lib/adminAuth.js src/app/api/admin src/components/admin/BookForCustomer.jsx src/components/ui/AppointmentForm.jsx src/lib/appointmentBooking.js src/app/api/appointments tests
git commit -m "feat: secure booking identity lookup"
```

---

### Task 11: Add the Separate Customer Session and Login-Purpose Completion

**Files:**
- Create: `src/lib/customerSession.js`
- Create: `src/app/api/customer/logout/route.js`
- Modify: `src/lib/otp/completionService.js`
- Modify: `src/app/api/otp/complete/route.js`
- Create: `tests/auth/customerSession.test.js`
- Modify: `tests/otp/completionService.test.js`
- Modify: `tests/otp/completeRoute.test.js`

**Interfaces:**
- Consumes: `jose`, stored login challenge, and challenge conditional completion.
- Produces: `signCustomerSession(phone, options)`, `verifyCustomerSession(token, options)`, `requireCustomerSession(request, options)`, `setCustomerSessionCookie(response, token, ttl)`, `clearCustomerSessionCookie(response)`, and login completion that sets but never returns `customer_session`.

- [ ] **Step 1: Write failing customer-session tests**

Create `tests/auth/customerSession.test.js`:

```js
it("signs and verifies a distinct customer identity", async () => {
  const token = await signCustomerSession("+972521234567", {
    secret: "c".repeat(32),
    ttlSeconds: 3600,
    now: new Date("2026-08-23T12:00:00Z"),
  });
  await expect(
    verifyCustomerSession(token, {
      secret: "c".repeat(32),
      now: new Date("2026-08-23T12:30:00Z"),
    }),
  ).resolves.toMatchObject({ type: "customer", phone: "+972521234567" });
});

it("rejects invalid signatures, expiry, wrong type, and malformed phone", async () => {
  await expect(verifyCustomerSession(forgedToken, options)).rejects.toMatchObject({
    code: "CUSTOMER_UNAUTHORIZED",
    status: 401,
  });
});
```

Assert cookie options exactly: `httpOnly: true`, production-aware `secure`, `sameSite: "lax"`, `path: "/"`, `maxAge: 3600`; secret shorter than 32 characters or missing returns a configuration error without exposing value; customer token is not accepted by admin helper.

- [ ] **Step 2: Extend failing purpose-specific completion tests**

Add tests:

- login completion signs the session before conditionally completing the challenge, returns internal `sessionToken` to the route adapter, and never calls booking-grant issuer/profile lookup;
- booking completion never calls session signer and never sets a cookie;
- route login success body is exactly `{ success: true, purpose: "login" }`, has a `customer_session` HttpOnly cookie, and contains no JWT;
- failed JWT signing leaves the challenge active;
- concurrent/repeated login completion has one winner;
- logout expires only `customer_session`, not admin `token`.

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```powershell
npm run test:run -- tests/auth/customerSession.test.js tests/otp/completionService.test.js tests/otp/completeRoute.test.js
```

Expected: FAIL because the session helper and login completion do not exist.

- [ ] **Step 4: Implement `jose` session helpers**

Use `SignJWT` and `jwtVerify` with HS256, issuer `soulclinic`, audience `soulclinic-customer`, claims `{ type: "customer", phone }`, explicit issued/expiry times, and `CUSTOMER_SESSION_TTL_SECONDS` parsed as a positive finite integer defaulting to `3600`. Read no admin secret/cookie.

`requireCustomerSession` reads only `request.cookies.get("customer_session")?.value`, verifies signature/expiry/type/normalized phone, and throws one safe `CUSTOMER_UNAUTHORIZED` for all invalid credentials.

- [ ] **Step 5: Implement login completion without a booking grant**

After provider evidence succeeds, sign the JWT first. Then CAS the same active challenge to completed using its token hash/provider/status. If CAS loses, discard the JWT and return already-completed. The completion service returns `{ purpose: "login", sessionToken, sessionTtlSeconds }` only to the route module; the route removes internal fields from JSON and sets the cookie.

The logout route creates a JSON success response and calls `clearCustomerSessionCookie` with `maxAge: 0`.

- [ ] **Step 6: Run focused and accumulated tests, then commit**

Run:

```powershell
npm run test:run -- tests/auth/customerSession.test.js tests/otp/completionService.test.js tests/otp/completeRoute.test.js
npm run test:run
git diff --check
```

Expected: all tests pass and login completion creates no grant.

Commit:

```powershell
git add src/lib/customerSession.js src/app/api/customer/logout src/lib/otp/completionService.js src/app/api/otp/complete tests/auth tests/otp
git commit -m "feat: add customer OTP session"
```

---

### Task 12: Migrate `LoginPage` to the Shared Firebase-First Flow

**Files:**
- Modify: `src/components/ui/LoginPage.jsx`
- Create: `tests/security/loginClient.test.js`

**Interfaces:**
- Consumes: `usePhoneOtp({ purpose: "login", recaptchaContainerId: "login-recaptcha-container" })`.
- Produces: login redirect to `/userAppointments` with authorization exclusively in the HttpOnly cookie.

- [ ] **Step 1: Write the failing source-level bypass guard**

Create `tests/security/loginClient.test.js`:

```js
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync("src/components/ui/LoginPage.jsx", "utf8");

it("uses the shared challenge flow without URL identity", () => {
  expect(source).toContain('purpose: "login"');
  expect(source).toContain('recaptchaContainerId: "login-recaptcha-container"');
  expect(source).toContain('router.push("/userAppointments")');
  expect(source).not.toContain("/api/otp/start");
  expect(source).not.toContain("/api/otp/verify");
  expect(source).not.toContain("userAppointments?phone=");
  expect(source).not.toMatch(/localStorage|sessionStorage/);
});
```

- [ ] **Step 2: Run the guard and confirm the old flow fails**

Run:

```powershell
npm run test:run -- tests/security/loginClient.test.js
```

Expected: FAIL because `LoginPage` still calls old endpoints and writes phone into the redirect URL.

- [ ] **Step 3: Replace local backend OTP shims with the shared hook**

Keep the existing Arabic UI and phone/OTP steps. Phone submit normalizes then calls `otpFlow.start(normalizedPhone)`. OTP submit calls `await otpFlow.verify(otp.trim())` and then `router.push("/userAppointments")`; it never receives/reads a session token. Resend calls `otpFlow.resend(normalizedPhone)` and disables while loading/cooldown. Add exactly one stable `<div id="login-recaptcha-container" />` outside step conditionals.

Map safe errors for invalid phone, source/phone rate limit, ambiguous Firebase delivery, unavailable OTP provider, and invalid code. Do not display ID tokens, challenge tokens, Twilio details, or raw backend stack messages.

- [ ] **Step 4: Run focused tests, accumulated tests, and build**

Run:

```powershell
npm run test:run -- tests/security/loginClient.test.js tests/otp/clientFlow.test.js
npm run test:run
npm run build
git diff --check
```

Expected: tests/build pass and no phone appears in the destination URL.

Commit:

```powershell
git add src/components/ui/LoginPage.jsx tests/security/loginClient.test.js
git commit -m "feat: migrate customer login to Firebase-first OTP"
```

---

### Task 13: Authorize My Appointments from the Customer Cookie

**Files:**
- Create: `src/lib/customerAppointments.js`
- Modify: `src/app/api/userAppointments/route.js`
- Modify: `src/app/userAppointments/UserAppointmentsClient.js`
- Create: `tests/appointments/userAppointments.test.js`
- Create: `tests/security/userAppointmentsClient.test.js`

**Interfaces:**
- Consumes: `requireCustomerSession(request)` and `usersData`.
- Produces: `getCustomerAppointments(phone, deps)` and authenticated `GET /api/userAppointments`; response `{ appointments }` contains only the authenticated customer's records.

- [ ] **Step 1: Write failing API authorization tests**

Create `tests/appointments/userAppointments.test.js` with mocked session/collection dependencies:

```js
it.each(["missing", "invalid", "expired"])("returns 401 for %s session", async (kind) => {
  sessionVerifier.rejectWith(kind);
  const response = await GET(makeRequest("https://soulclinc.net/api/userAppointments"));
  expect(response.status).toBe(401);
  expect(users.findOne).not.toHaveBeenCalled();
});

it("derives customer A exclusively from the verified session", async () => {
  sessionVerifier.resolveWith({ type: "customer", phone: "+972521111111" });
  users.findOne.mockResolvedValue({ appointments: [{ _id: "a", date: "2026-09-01" }] });
  const response = await GET(
    makeRequest("https://soulclinc.net/api/userAppointments?phone=%2B972522222222"),
  );
  expect(users.findOne).toHaveBeenCalledWith(
    { phone: "+972521111111" },
    expect.any(Object),
  );
  expect(await response.json()).toEqual({
    appointments: [{ _id: "a", date: "2026-09-01" }],
  });
});
```

Also test invalid phone claim returns `401`, missing user returns `{ appointments: [] }` without an existence oracle, appointments sort by date/time, and no first name/last name/notes/adminNotes fields are returned.

- [ ] **Step 2: Write the failing client identity guard**

Create `tests/security/userAppointmentsClient.test.js`:

```js
const source = readFileSync("src/app/userAppointments/UserAppointmentsClient.js", "utf8");
expect(source).not.toMatch(/useSearchParams|normalizeIsraeliPhone|params:\s*\{\s*phone/);
expect(source).not.toMatch(/cancelaptByuser[\s\S]{0,160}data:\s*\{\s*phone/);
expect(source).toContain('axios.get("/api/userAppointments")');
expect(source).toContain('axios.post("/api/customer/logout")');
```

- [ ] **Step 3: Run focused tests and confirm failure**

Run:

```powershell
npm run test:run -- tests/appointments/userAppointments.test.js tests/security/userAppointmentsClient.test.js
```

Expected: FAIL because API/UI still authorize with the phone query.

- [ ] **Step 4: Implement session-derived reads**

`getCustomerAppointments` queries normalized session phone with projection `{ _id: 0, appointments: 1 }`, clones/sorts the array, and returns it. The route ignores any supplied query phone, calls `requireCustomerSession` before DB access, and returns a single safe `401` for all customer-auth errors.

Do not return the phone in JSON; the client does not need it as authorization state.

- [ ] **Step 5: Remove URL identity from the client and add logout**

Remove `useSearchParams`, phone normalization/memo, and all phone query/body values. Fetch exactly `axios.get("/api/userAppointments")`. On `401`, call `router.replace("/login")`. Add a logout button that posts `/api/customer/logout` and replaces to `/login`; no JWT is read or stored. Keep current table, future-date logic, and cancellation confirmation UI.

- [ ] **Step 6: Run focused/accumulated tests and commit**

Run:

```powershell
npm run test:run -- tests/appointments/userAppointments.test.js tests/security/userAppointmentsClient.test.js
npm run test:run
git diff --check
```

Expected: tests pass and customer B query input cannot alter customer A identity.

Commit:

```powershell
git add src/lib/customerAppointments.js src/app/api/userAppointments src/app/userAppointments/UserAppointmentsClient.js tests/appointments tests/security
git commit -m "feat: secure customer appointment reads"
```

---

### Task 14: Cancel Customer Appointments by Owned Shared ID

**Files:**
- Modify: `src/lib/customerAppointments.js`
- Modify: `src/app/api/appointments/cancelaptByuser/route.js`
- Modify: `src/app/userAppointments/UserAppointmentsClient.js`
- Create: `tests/appointments/customerCancellation.test.js`

**Interfaces:**
- Consumes: customer session phone, `ObjectId`, shared appointment `_id`, Mongo client, `usersData`, day-based `appointments`, and existing WhatsApp sender.
- Produces: `cancelCustomerAppointment({ phone, appointmentId }, deps)`; route accepts only appointment ID as authority and derives phone/date/time/title/name server-side.

- [ ] **Step 1: Write failing ownership and shared-ID tests**

Create `tests/appointments/customerCancellation.test.js` with customer A/B fixtures sharing distinct ObjectIds:

```js
it("customer A removes appointment A from both representations by _id", async () => {
  await cancelCustomerAppointment(
    { phone: customerA.phone, appointmentId: String(appointmentA._id) },
    deps,
  );
  expect(userA.appointments).not.toContainEqual(expect.objectContaining({ _id: appointmentA._id }));
  expect(day.appointments).not.toContainEqual(expect.objectContaining({ _id: appointmentA._id }));
  expect(userB.appointments).toContainEqual(expect.objectContaining({ _id: appointmentB._id }));
});

it("customer A cannot cancel customer B appointment", async () => {
  await expect(
    cancelCustomerAppointment(
      { phone: customerA.phone, appointmentId: String(appointmentB._id) },
      deps,
    ),
  ).rejects.toMatchObject({ code: "APPOINTMENT_NOT_FOUND", status: 404 });
  expect(day.appointments).toContainEqual(expect.objectContaining({ _id: appointmentB._id }));
});
```

Add invalid ID, missing/invalid session (`401` before DB), body phone/date/time unable to override session identity, notes removed using server-derived date/time, notifications after successful database work only, and no notification on ownership failure.

- [ ] **Step 2: Write transaction and non-transaction failure tests**

Test transaction rollback when either representation update fails. For unsupported transactions, test:

1. exact day appointment is captured;
2. day pull by `_id` succeeds;
3. user pull by authenticated phone + `_id` succeeds;
4. if user pull fails, the exact day appointment is restored only when `_id` is absent;
5. retry cannot delete another customer's record or duplicate the restored day appointment.

Assert all update filters contain the shared `_id`; no deletion filter relies only on date/time.

- [ ] **Step 3: Run focused tests and confirm the current unauthenticated route fails**

Run:

```powershell
npm run test:run -- tests/appointments/customerCancellation.test.js
```

Expected: FAIL because the route trusts phone/date/time and has no customer session.

- [ ] **Step 4: Implement transaction-first cancellation**

Validate `ObjectId.isValid`, fetch the appointment only through:

```js
{
  phone: authenticatedPhone,
  "appointments._id": appointmentObjectId,
}
```

Project first/last name and the matching appointment, derive date/time/title, then in one transaction `$pull` `usersData.appointments` by `_id`, notes by derived date/time, and day `appointments` by the same `_id`. Require matched/modified results that prove ownership and shared-record removal.

Use `isTransactionUnsupportedError` for the exact fallback above. Send the existing admin cancellation WhatsApp template after commit/fallback success, preserving current variables.

- [ ] **Step 5: Change the client request and keys**

Use stable key `String(appointment._id)` and send:

```js
await axios.delete("/api/appointments/cancelaptByuser", {
  data: { appointmentId: String(appointment._id) },
});
```

Filter local state by `_id`, not date/time. On `401`, redirect to `/login`; on `404`, refresh appointments so stale UI heals.

- [ ] **Step 6: Run focused tests, accumulated tests, and build**

Run:

```powershell
npm run test:run -- tests/appointments/customerCancellation.test.js
npm run test:run
npm run build
git diff --check
```

Expected: tests/build pass; customer ownership is enforced at the endpoint.

Commit:

```powershell
git add src/lib/customerAppointments.js src/app/api/appointments/cancelaptByuser src/app/userAppointments/UserAppointmentsClient.js tests/appointments/customerCancellation.test.js
git commit -m "feat: authorize customer cancellation by appointment id"
```

---

### Task 15: Sanitize Public Availability and Enforce Admin APIs

**Files:**
- Create: `src/lib/appointmentViews.js`
- Modify: `src/app/api/appointments/route.js`
- Modify: `src/app/api/admin/bookforCustumer/route.js`
- Modify: `src/app/api/loginAdmin/route.js`
- Create: `tests/appointments/appointmentViews.test.js`
- Create: `tests/auth/adminAppointmentRoutes.test.js`
- Modify: `tests/auth/adminAuth.test.js`

**Interfaces:**
- Consumes: `requireAdmin`/`withAdminRoute`, existing JWT cookie, day document, and existing admin enrichment.
- Produces: `toPublicAvailability(day)` returning only `{ appointments: [{ time, duration }], blockedTimes, editedTimes }`; real admin auth for `admin=true` GET and DELETE; production-aware admin cookie.

- [ ] **Step 1: Write failing public sanitization tests**

Create `tests/appointments/appointmentViews.test.js`:

```js
const day = {
  appointments: [{
    _id: "private-id",
    time: "10:00",
    duration: 20,
    firstName: "Private",
    lastName: "Customer",
    phone: "+972521234567",
    note: "private",
  }],
  blockedTimes: ["11:00"],
  editedTimes: ["10:00", "10:30"],
};

expect(toPublicAvailability(day)).toEqual({
  appointments: [{ time: "10:00", duration: 20 }],
  blockedTimes: ["11:00"],
  editedTimes: ["10:00", "10:30"],
});
expect(JSON.stringify(toPublicAvailability(day))).not.toMatch(
  /private-id|Private|Customer|972521234567|note/,
);
```

Test malformed arrays become empty arrays and only finite positive duration/time strings survive.

- [ ] **Step 2: Write failing privileged-route tests**

In `tests/auth/adminAppointmentRoutes.test.js`, assert:

- public date GET returns the sanitized shape with no `_id`, phone, or names;
- `?admin=true` with no/invalid admin cookie returns `401`, non-admin returns `403`, authenticated admin gets existing enriched appointment data;
- unauthenticated/non-admin `DELETE /api/appointments` is rejected before collection/WhatsApp access;
- authenticated admin DELETE retains existing behavior;
- admin manual booking route uses shared role check and remains `requireOtp: false`;
- admin login cookie has `secure: true` in production and `false` in development, with HttpOnly/lax/path unchanged.

- [ ] **Step 3: Run focused tests and confirm PII/auth failures**

Run:

```powershell
npm run test:run -- tests/appointments/appointmentViews.test.js tests/auth/adminAppointmentRoutes.test.js
```

Expected: FAIL because public GET leaks PII, `admin=true` is trusted, DELETE is unauthenticated, and admin cookie is always insecure.

- [ ] **Step 4: Split public and privileged GET paths before querying**

Parse `admin=true`; if present call `requireAdmin(req)` before database access and use the existing private projection/enrichment. Otherwise project only blocked/edited times and appointment time/duration, pass through `toPublicAvailability`, and return the same object shape consumed by `TimeSlotPicker`.

No-date public/admin responses use `{ appointments: [], blockedTimes: [], editedTimes: [] }`; privileged no-date still requires admin auth.

- [ ] **Step 5: Protect DELETE/manual booking and harden cookie**

Call `requireAdmin(req)` at the start of appointment DELETE before body parsing/DB work. Keep the current admin payload/WhatsApp behavior and leave `src/app/admin/users/page.js` unchanged. Replace the manual-booking route's local cookie logic with shared `withAdminRoute`.

In admin login set:

```js
secure: process.env.NODE_ENV === "production"
```

Do not redesign admin JWT claims, cookie name, or proxy behavior.

- [ ] **Step 6: Run focused/accumulated tests and commit**

Run:

```powershell
npm run test:run -- tests/appointments/appointmentViews.test.js tests/auth/adminAppointmentRoutes.test.js tests/auth/adminAuth.test.js
npm run test:run
npm run build
git diff --check
```

Expected: tests/build pass; public availability remains compatible while exposing no customer PII.

Commit:

```powershell
git add src/lib/appointmentViews.js src/app/api/appointments/route.js src/app/api/admin/bookforCustumer/route.js src/app/api/loginAdmin/route.js tests
git commit -m "fix: enforce appointment API authorization"
```

---

### Task 16: Remove Legacy Bypasses and Run the Full Security Gate

**Files:**
- Delete: `src/app/api/otp/start/route.js`
- Delete: `src/app/api/otp/verify/route.js`
- Delete: `src/lib/otpSecurity.js`
- Create: `tests/security/legacyBypasses.test.js`

**Interfaces:**
- Consumes: all new challenge/client/grant/session APIs.
- Produces: one OTP architecture with no legacy route or unbounded write path.

- [ ] **Step 1: Write the failing legacy-bypass guard before deleting files**

Create `tests/security/legacyBypasses.test.js`:

```js
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const sourceMatches = (pattern) => {
  try {
    return execFileSync("rg", ["-n", pattern, "src"], { encoding: "utf8" });
  } catch (error) {
    return error.stdout || "";
  }
};

describe("legacy OTP bypass removal", () => {
  it("removes old OTP and public lookup routes", () => {
    expect(existsSync("src/app/api/otp/start/route.js")).toBe(false);
    expect(existsSync("src/app/api/otp/verify/route.js")).toBe(false);
    expect(existsSync("src/app/api/appointments/user/route.js")).toBe(false);
  });

  it("has no callers for old OTP APIs or phone-authorized appointment URLs", () => {
    expect(sourceMatches("/api/otp/(start|verify)")).toBe("");
    expect(sourceMatches("userAppointments\\?phone=")).toBe("");
    expect(sourceMatches("/api/userAppointments.*phone")).toBe("");
  });

  it("stops all writes to legacy append-only OTP collections", () => {
    expect(sourceMatches("otpSendOperations|otpProviderAttempts|otpVerifyFailures")).toBe("");
  });

  it("contains no default development OTP", () => {
    expect(sourceMatches("OTP_DEV_CODE.*123456|TWILIO_PLACEHOLDER_CODE")).toBe("");
  });
});
```

Add these guards for cancellation/admin authorization and secret logging. Firebase/Twilio error-code metadata remains allowed:

```js
it("keeps identity fields out of customer cancellation requests", () => {
  const source = readFileSync("src/app/userAppointments/UserAppointmentsClient.js", "utf8");
  const cancellationCall = source.match(/axios\.delete\([\s\S]*?cancelaptByuser[\s\S]*?\);/)?.[0] || "";
  expect(cancellationCall).toContain("appointmentId");
  expect(cancellationCall).not.toMatch(/\bphone\b|\bdate\b|\btime\b/);
});

it("keeps endpoint-level admin checks in privileged appointment branches", () => {
  const source = readFileSync("src/app/api/appointments/route.js", "utf8");
  expect(source).toMatch(/isAdmin[\s\S]{0,240}requireAdmin\(req\)/);
  expect(source).toMatch(
    /export async function DELETE[\s\S]{0,320}requireAdmin\(req\)[\s\S]{0,320}req\.json\(\)/,
  );
});

it("does not pass credentials or submitted codes into console calls", () => {
  expect(
    sourceMatches(
      "console\\.(log|info|warn|error).*" +
        "(idToken|verificationToken|sessionToken|payload\\.code|otpCode|authToken|privateKey)",
    ),
  ).toBe("");
});
```

- [ ] **Step 2: Run the guard and confirm legacy files fail it**

Run:

```powershell
npm run test:run -- tests/security/legacyBypasses.test.js
```

Expected: FAIL while old start/verify routes and `otpSecurity.js` still exist.

- [ ] **Step 3: Delete old routes/state module and repair imports**

Delete the three files only after `rg` confirms no legitimate caller/import remains. Do not drop old Mongo collections; the new flow simply has no source references that write them. Keep `src/lib/firebase.js`, `src/lib/firebaseAdmin.js`, `src/lib/phoneAuth.js`, `src/lib/twilio.js`, and refactored `src/lib/twilioOTP.js`.

- [ ] **Step 4: Run all automated security/regression tests**

Run:

```powershell
npm run test:run
```

Expected: all test files pass, including source/IP limits, partial failures, concurrent completion, pre-OTP PII denial, booking grants, sessions, ownership, public sanitization, and admin authorization.

- [ ] **Step 5: Run explicit insecure-pattern searches**

Run each command and require no insecure match in active source:

```powershell
rg -n '/api/otp/(start|verify)|sendOTP\(' src
rg -n '/api/appointments/user|userAppointments\?phone=|/api/userAppointments.*phone' src
rg -n 'otpSendOperations|otpProviderAttempts|otpVerifyFailures' src
rg -n 'OTP_DEV_CODE.*123456|TWILIO_PLACEHOLDER_CODE' src
rg -n 'innerHTML\s*=|removeChild\(|\.remove\(\)' src/lib/phoneAuth.js src/components/ui/AppointmentForm.jsx src/components/ui/LoginPage.jsx
rg -n 'admin=true' src/app/api/appointments/route.js
rg -n 'DELETE\s*\(' src/app/api/appointments/route.js
```

Expected: the first four searches and reCAPTCHA DOM-removal search return no matches. The last two may locate the secured branches; inspect them and confirm `requireAdmin(req)` occurs before privileged data/body handling.

- [ ] **Step 6: Clean build cache and run final commands**

Run:

```powershell
Remove-Item -Recurse -Force .next -ErrorAction SilentlyContinue
npm run test:run
npm run lint
npm run build
git diff --check
```

Expected: tests and build pass. `npm run lint` may reproduce the verified baseline `ConfigError: Unexpected key "images" found` from `eslint.config.mjs`; do not rewrite unrelated ESLint/Next configuration in this task. Record that exact pre-existing failure separately unless lint reaches source and reports implementation errors, which must be fixed.

- [ ] **Step 7: Verify production dependency/configuration facts without exposing values**

Run:

```powershell
npm ls firebase firebase-admin twilio mongodb jose axios vitest
git status --short
git diff --stat main...HEAD
git log -5 --oneline
```

Expected: one installed version of each package, no secrets printed, and only intended branch changes. Confirm Vercel must receive `CUSTOMER_SESSION_SECRET` and `OTP_SOURCE_HASH_SECRET`; `CUSTOMER_SESSION_TTL_SECONDS` is optional; `OTP_DEV_CODE` is local-only and must not exist in production.

- [ ] **Step 8: Perform manual browser/API smoke checks**

Use local development with an explicit non-production `OTP_DEV_CODE`, then production preview with Firebase/Twilio credentials:

1. Booking challenge requires cooldown and never returns the dev code.
2. Firebase sends first in production; valid Firebase OTP books with a one-time grant.
3. Wrong Firebase OTP stays in Firebase and makes no `/api/otp/fallback` network request.
4. Eligible mocked/observed Firebase SEND failure makes exactly one fallback request and Twilio send.
5. `auth/network-request-failed` shows pending/retry guidance and no Twilio request.
6. Login sets `customer_session` HttpOnly and redirects without `?phone=`.
7. Direct `/api/userAppointments?phone=another` cannot change identity.
8. Customer cancellation sends only appointment ID and rejects another customer's ID.
9. Public date GET contains only time/duration/blocked/edited fields.
10. `admin=true`, admin users/attendance/notes, and appointment DELETE reject missing/non-admin cookies.

In Firebase Console manually confirm Phone provider, `soulclinc.net`, preview domain if used, Israeli SMS policy, quotas, and reCAPTCHA requirements. These are external checks, not repository changes.

- [ ] **Step 9: Commit cleanup after all gates**

```powershell
git add -A
git commit -m "chore: remove legacy OTP bypasses"
git status --short
```

Expected: cleanup commit succeeds and final status is clean. Do not push.

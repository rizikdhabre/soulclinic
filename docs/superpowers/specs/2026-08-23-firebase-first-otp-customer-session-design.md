# Firebase-First OTP and Customer Session Design

## Scope

Replace the current Twilio-only OTP flow with a server-owned challenge flow in which Firebase Phone Authentication is primary, Twilio Verify is a tightly controlled fallback, booking completion issues a one-time booking grant, and login completion issues a separate HttpOnly customer session.

The implementation must preserve public appointment booking, existing/new customer name handling, appointment availability and race protections, admin manual booking, and WhatsApp notifications. It must close the current unauthenticated viewing, cancellation, public PII, and admin-cancellation bypasses.

## Security Invariants

1. Every OTP flow starts with a valid server-created challenge bound to a normalized phone and a stored purpose (`booking` or `login`).
2. Firebase is attempted first unless an explicitly configured non-production development provider is active.
3. Twilio can start only after an eligible Firebase send failure and one successful atomic fallback reservation.
4. Wrong, missing, malformed, or expired Firebase verification codes never trigger Twilio.
5. `auth/network-request-failed` is an ambiguous Firebase send result and never triggers immediate fallback.
6. OTP values, failed submitted values, Firebase ID tokens, session JWTs, challenge tokens, and booking verification tokens are never logged or persisted in plaintext.
7. Challenge completion derives phone and purpose only from the stored challenge.
8. Firebase completion requires a verified, fresh Firebase phone-auth ID token matching the challenge phone.
9. Twilio completion verifies the challenge phone and increments only a bounded server-side failure counter.
10. Booking grants remain phone-bound, hashed, expiring, and one-time use.
11. Customer viewing and cancellation require a separate customer session and derive identity exclusively from it.
12. Admin authentication and customer authentication use different secrets and cookie names.
13. Challenge creation and Twilio fallback are protected by bounded, expiring source-wide limits in addition to per-phone limits; no production limiter relies on process memory.
14. No unauthenticated pre-OTP endpoint discloses whether a phone is registered or returns customer names, notes, appointments, or other profile data.
15. Booking completion does not expose a completed challenge unless its matching one-time grant is durably usable, and concurrent completion can create at most one grant.

## API Surface

### `POST /api/otp/challenge`

Request: `{ phone, purpose }`, where purpose is exactly `booking` or `login`.

The route derives a trusted source identifier, claims the source-wide challenge slot, normalizes the phone, claims the per-phone logical-send slot, rotates the one challenge document for `phone + purpose`, and returns `{ challengeToken, provider, expiresAt, retryAfterSeconds }`. The plaintext challenge token is returned once; only its SHA-256 hash is stored.

Source-wide challenge creation permits at most ten accepted requests per ten-minute window and thirty per one-hour window. These limits span different phone numbers and are enforced atomically in MongoDB before challenge rotation. A rejection returns `429` with a bounded retry interval and does not consume a per-phone send slot.

When `NODE_ENV !== "production"` and `OTP_DEV_CODE` is explicitly configured, the challenge provider is `development`. Otherwise it is `firebase`. No development code is returned or logged.

### `POST /api/otp/fallback`

Request: `{ challengeToken, firebaseErrorCode }`.

The route hashes and locates the active challenge, claims the stricter source-wide fallback slot, verifies that its provider is Firebase, validates the supplied error against the server allowlist, atomically reserves the only fallback, and sends Twilio Verify to the stored challenge phone. It updates bounded summary fields on the same challenge.

`firebaseErrorCode` is an untrusted browser report. The allowlist limits which reported conditions are eligible, but the backend cannot prove that Firebase produced the report. It is therefore never the sole authorization for a Twilio send. The route also requires a server-created active challenge, the per-source fallback limits, the per-phone limits inherited from challenge creation, and the single atomic fallback reservation. A source may make at most three valid-challenge fallback attempts per ten-minute window and ten per one-hour window across all phones. A valid challenge attempt consumes source capacity even when its reported code is later rejected, preventing cheap allowlist probing. Invalid random challenge tokens are rejected before creating source-state records.

Eligible initial allowlist:

- `auth/internal-error`
- `auth/operation-not-allowed`
- `auth/app-not-authorized`
- `auth/quota-exceeded`

All phone, abuse, reCAPTCHA, app-credential, user-state, and verification-code errors are rejected. `auth/network-request-failed` receives an ambiguous-delivery response without Twilio.

### `POST /api/otp/complete`

Firebase request: `{ challengeToken, provider: "firebase", idToken }`.

Twilio request: `{ challengeToken, provider: "twilio", code }`.

Development request: `{ challengeToken, provider: "development", code }`, accepted only outside production when `OTP_DEV_CODE` is explicitly configured.

The route never accepts phone or purpose. It verifies provider-specific evidence, atomically completes the active challenge once, and dispatches by the stored purpose:

- `booking`: issue a hashed, phone-bound, ten-minute one-time booking grant and return its plaintext token once. Only after verification, the response may also include the stored first and last name or indicate that profile details are missing so the booking UI can collect them.
- `login`: sign a customer session JWT, set the HttpOnly cookie, and return success without a booking grant.

The existing `/api/otp/start` and `/api/otp/verify` routes are removed after all callers migrate.

## Challenge State Machine

One `otpChallenges` document exists per `phone + purpose`:

```text
pending/firebase
  -> completing                        non-transaction booking reservation
  -> completed                         Firebase ID token accepted
  -> twilio_sending                    eligible fallback reserved
  -> failed                            permanent Twilio send failure

twilio_sending
  -> twilio_sent                       Twilio accepted send
  -> failed or delivery_unknown        classified send failure

twilio_sent
  -> completing                        non-transaction booking reservation
  -> completed                         Twilio verification approved

pending/development
  -> completing                        non-transaction booking reservation
  -> completed                         explicit development code accepted
```

A new allowed logical start rotates the existing document with a new challenge hash, resets provider state, and invalidates the previous token. Completed, failed, and expired challenges cannot be completed. Provider transitions use conditional atomic updates so concurrent fallback or completion requests cannot both win. `completing` is a leased internal state used only by the documented non-transaction booking-completion protocol; it is never treated as successful by the client or grant consumer.

## Bounded MongoDB State

### `otpSecurityState`

One document per normalized phone:

```js
{
  phone,
  lastSendAt,
  sendWindowStartedAt,
  sendCount,
  verifyWindowStartedAt,
  verifyFailureCount,
  blockedUntil,
  updatedAt,
  expiresAt
}
```

Rules:

- 60 seconds between logical challenge starts.
- At most five logical starts per rolling/resettable one-hour window.
- At most five backend-observed Twilio/development failures per ten-minute window.
- A unique phone index and TTL on `expiresAt`, approximately two hours after activity.
- Atomic conditional updates prevent two concurrent starts from both passing.
- Incorrect values are never stored; only counters and timestamps change.

### `otpSourceSecurityState`

One document per HMAC-derived source identifier:

```js
{
  sourceHash,
  challengeShortWindowStartedAt,
  challengeShortCount,
  challengeHourStartedAt,
  challengeHourCount,
  fallbackShortWindowStartedAt,
  fallbackShortCount,
  fallbackHourStartedAt,
  fallbackHourCount,
  updatedAt,
  expiresAt
}
```

Rules:

- The identifier is `HMAC-SHA-256(OTP_SOURCE_HASH_SECRET, normalizedClientIp)`. Raw IP addresses are neither persisted nor logged.
- Challenge limits are ten per ten minutes and thirty per hour across all phone numbers.
- Fallback limits are stricter: three per ten minutes and ten per hour across all phone numbers.
- A unique `sourceHash` index, atomic conditional counter updates, and a TTL index approximately two hours after activity keep the collection bounded and effective across Vercel instances.
- Application-level source limiting remains mandatory even if Vercel Firewall/WAF rules are added. Platform rules are defense in depth, not a replacement, and the Mongo-backed limiter is covered by automated tests.

Trusted client source extraction is deployment-specific:

- On Vercel, and only when trusted server configuration reports `VERCEL=1`, the application reads the platform-injected `x-vercel-forwarded-for` value, requires one syntactically valid IPv4 or IPv6 address, normalizes it, and hashes it. Vercel documents that it overwrites forwarding data at its edge; `x-vercel-forwarded-for` avoids relying on an `x-forwarded-for` value that an additional proxy may replace. See [Vercel request headers](https://vercel.com/docs/headers/request-headers).
- A caller-provided `x-forwarded-for`, `forwarded`, `x-real-ip`, `x-vercel-id`, or similar header is never trusted merely because it exists. Tests prove these headers cannot select a new rate-limit bucket outside the Vercel runtime policy.
- Non-Vercel production fails closed with `OTP_SOURCE_UNAVAILABLE` until a host-specific trusted-ingress adapter is implemented and tested. It must receive the peer identity from infrastructure that strips client-supplied forwarding headers; enabling trust through a request header or an environment switch alone is not allowed.
- Local development uses one fixed development bucket. Tests inject a source extractor directly; production code never accepts a client-selected source identifier.

### `otpChallenges`

One document per `phone + purpose`, with unique indexes on that pair and challenge-token hash plus a TTL index on `expiresAt`. Each rotated challenge expires ten minutes after creation. The document stores status, provider, fallback reservation, safe provider summary fields, timestamps, and the hashed token. A non-transaction completion lease may temporarily add `completionId`, `completionLeaseExpiresAt`, `completionPreviousStatus`, and the booking grant token hash. It does not store OTP values, Firebase ID tokens, or plaintext bearer tokens.

### Atomic Booking Completion

Provider evidence is verified before opening a database transaction. The preferred MongoDB transaction then performs both writes as one unit:

1. Conditionally change the matching unexpired challenge from its provider-eligible status to `completed`.
2. Insert one prepared booking-grant record containing the challenge ID, normalized phone, token hash, expiry, and `completionId`.

The grant collection has unique indexes on `challengeId` and token hash. The plaintext grant is returned only after commit. If either write or the commit fails, neither document becomes visible as completed. The conditional challenge update ensures only one concurrent request can win.

Deployments without transaction support use this conditional, idempotent protocol:

1. Compare-and-swap the eligible challenge to `completing`, assigning a random `completionId`, the grant token hash, the previous provider status, and a short lease.
2. Idempotently upsert a `prepared` grant keyed by the unique challenge ID and matching `completionId`. A prepared grant cannot be consumed unless its linked challenge is `completed` with the same `completionId`.
3. After confirming that prepared record, compare-and-swap the challenge from `completing` to `completed`. At that instant the already-durable matching grant becomes usable; there is no completed state without a usable grant.
4. If a write fails before step 3, conditionally delete the prepared record and restore the challenge to its previous provider status. If the process exits first, the next completion attempt detects the expired lease, performs the same cleanup, and can reserve a new completion. TTL remains a final cleanup backstop.

A unique challenge ID prevents duplicate grants. A prepared record attached to an uncompleted challenge is never accepted by booking and is removed by lease recovery, so it is not an orphan usable grant. Repeated or concurrent completion after the winning transition returns an already-completed result and cannot mint another token. Fault-injection tests cover failure after each non-transaction step, lease recovery, and simultaneous completion requests.

### Legacy Collections

The implementation stops writing `otpSendOperations`, `otpProviderAttempts`, and `otpVerifyFailures`. They are not dropped and may expire through their existing TTL indexes. Existing `otpVerificationGrants` remains the booking-grant store.

## Firebase Client Flow

`src/lib/phoneAuth.js` exposes focused browser functions for sending Firebase OTP, clearing a verifier, and classifying send errors. Verifiers are scoped by a caller-provided unique container ID rather than one global verifier. Cleanup calls Firebase's `clear()` only and never mutates container HTML.

A shared client OTP controller/hook is used by `AppointmentForm` and `LoginPage`:

1. Create challenge.
2. For provider `firebase`, initialize invisible reCAPTCHA and call `signInWithPhoneNumber`.
3. On success, retain the in-memory `ConfirmationResult` for that mounted flow only.
4. On eligible send failure, call the fallback endpoint once.
5. On ambiguous or ineligible failure, show a safe error and remain outside Twilio.
6. Firebase code entry calls `confirmationResult.confirm(code)`. Verification errors stay in Firebase.
7. Extract a transient ID token and immediately submit it to `/api/otp/complete`.
8. For booking, use the verified completion response to apply stored customer names or show the missing-name fields; no customer lookup occurs before OTP success.
9. Clear verifier state on resend, fallback transition, unmount, and completed flow.

No provider credential or customer session is placed in local storage, session storage, or a URL.

## Firebase Server Verification

The existing Firebase Admin app remains singleton and continues exporting Storage. It additionally exports Admin Auth from the same app.

Firebase completion verifies the ID token and requires:

- `phone_number` exists and normalizes to the challenge phone.
- `firebase.sign_in_provider === "phone"`.
- `auth_time` is not older than challenge creation, allowing a two-minute clock-skew tolerance.
- `auth_time` is not materially in the future.

The token is discarded after verification and never written to MongoDB or logs.

## Twilio Fallback

Twilio send preserves at most three provider calls for clearly retryable pre-delivery/5xx failures. Ambiguous timeout/socket outcomes are not blindly retried. Only aggregate fields such as `providerAttemptCount`, `lastProviderErrorCode`, and `lastProviderStatus` are stored on the challenge.

Twilio verification derives `to` from the challenge. Non-approved status increments the bounded phone state. Provider verification errors return classified errors and never trigger a new send.

## Customer Session

Customer sessions use `jose`, `CUSTOMER_SESSION_SECRET`, and `CUSTOMER_SESSION_TTL_SECONDS` (default 3600 seconds). Claims include `type: "customer"`, normalized `phone`, `iat`, and `exp`.

Cookie name: `customer_session`.

Cookie properties:

```js
{
  httpOnly: true,
  secure: process.env.NODE_ENV === "production",
  sameSite: "lax",
  path: "/",
  maxAge: configuredTtl
}
```

Shared helpers sign, verify, require, set, and clear the customer session. Customer sessions are stateless and never stored in MongoDB. A customer logout endpoint clears only this cookie.

## Appointment Authorization

Public booking continues through `POST /api/appointments` with `requireOtp: true`. Booking challenge completion creates the current grant type; grant consumption remains hashed, phone-bound, expiring, and one-time.

The unauthenticated `/api/appointments/user?phone=...` lookup is removed along with all public frontend callers. Challenge creation returns no customer existence or profile-completeness signal. For booking purpose only, successful OTP completion may read `usersData` by the verified challenge phone and return the minimum post-verification profile result needed by the form: whether a complete stored name exists and, when it does, that first and last name. New or incomplete customers enter names after OTP completion and submit them with the same booking grant. No first name, last name, notes, appointments, existence flag, or other customer PII is available before successful phone verification.

The current repository audit also found customer PII behind API paths named `admin` but without endpoint-level authorization. A shared role-checked admin helper is added and applied at minimum to `/api/admin/users`, `/api/admin/attendance`, and `/api/admin/admin-notes`, as well as the privileged appointment GET and DELETE operations. The admin manual-booking form moves its phone lookup to the authenticated `/api/admin/users?phone=...` behavior; unauthenticated requests receive `401`, non-admin sessions receive `403`, and only an authenticated admin can receive names or profile data. Page middleware remains a UX guard and is not the API security boundary.

`GET /api/userAppointments` accepts no identity input. It requires the customer cookie, derives the phone from verified claims, and returns only that user's appointments. A supplied `phone` query cannot override identity.

Customer cancellation accepts only `{ appointmentId }`. The server requires a customer session, finds that ID inside the authenticated user's `usersData`, derives date/time, and removes the same `_id` from both MongoDB representations. Transaction mode is preferred; the fallback is idempotent and attempts rollback if the second update fails.

Public `GET /api/appointments?date=...` returns only availability fields: appointment `time` and `duration`, plus blocked and edited times. It returns no customer identity or appointment ID. `admin=true` requires a verified admin JWT before returning privileged data.

Admin `DELETE /api/appointments` verifies the admin cookie and `role === "admin"` at the endpoint. Admin login changes only the cookie `secure` flag to production-aware behavior.

## Testing Strategy

Vitest is the only initial test dependency. Server logic is extracted behind dependency boundaries so tests use fake collections, deterministic clocks/randomness, and mocked Firebase/Twilio providers without network calls.

Test groups:

- phone normalization and challenge input validation
- bounded send/verify state and challenge rotation
- source extraction trust rules, HMAC identifiers, TTL state, cross-phone challenge limits, and stricter fallback limits
- Firebase send-error allowlist and ambiguous delivery behavior
- Firebase Admin token identity/freshness checks
- Twilio fallback reservation, bounded retries, verification, and counters
- purpose-specific booking grant versus login session completion
- transactional booking completion rollback and concurrent single-winner behavior
- non-transaction completion fault injection, compensation, expired-lease recovery, and duplicate-grant prevention
- booking grant binding, expiry, reuse, and missing-grant rejection
- customer JWT creation/verification/cookie properties
- pre-OTP route/caller removal and proof that arbitrary phone lookup cannot retrieve customer PII
- post-verification booking profile response minimization
- unauthenticated and non-admin rejection for every audited admin PII route, plus authenticated admin lookup regression
- authenticated My Appointments identity derivation
- customer cancellation ownership and shared `_id` removal
- public appointment response sanitization and authenticated admin behavior
- old write-path and old endpoint removal checks

Each stage follows red-green-refactor: add focused failing tests, confirm failure, implement, rerun focused tests, then run the accumulated suite.

## Verification and Deployment

Final verification commands:

```text
npm run test:run
npm run lint
npm run build
```

The baseline build passes when the ignored local environment is available. Baseline lint currently fails before source inspection because `eslint.config.mjs` contains Next image configuration rather than an ESLint flat config. That pre-existing failure will be reported separately unless the final implementation requires a narrowly scoped correction to run the mandated lint verification.

Required new server environment variables:

- `CUSTOMER_SESSION_SECRET`
- `CUSTOMER_SESSION_TTL_SECONDS` (optional; defaults to 3600)
- `OTP_SOURCE_HASH_SECRET`

`OTP_DEV_CODE` remains optional but has no default and is never accepted in production.

Manual Firebase Console checks remain external: Phone provider enabled, authorized production/Vercel domains, Israeli SMS region policy, quota, and reCAPTCHA requirements.

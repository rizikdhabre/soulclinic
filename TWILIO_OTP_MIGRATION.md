# Twilio-only OTP migration

## Design and constraints

Implement the user's approved migration without changing ignore rules, cloud data,
appointment scheduling rules, or customer identity/session semantics.

- Prepare a phone/purpose-bound challenge, then invoke `/api/otp/send` directly.
  A persisted send reservation permits exactly one provider invocation. Repeating
  the same send returns saved results, never another SMS.
- Verify using the saved provider verification SID, not a client-supplied phone.
  Only an explicit, matching `approved` response authorizes completion.
- Persist approvals before session/grant work. Server-authenticated, encrypted,
  short-lived recovery receipts carry observed send/approval results across a
  transient persistence failure. They are bound to the exact challenge and
  operation and kept only in client memory, never logged.
- Unknown provider outcomes cannot establish verification. If both a provider
  response and its recovery evidence are lost, fail closed; never infer approval
  from a 404 or resend automatically.
- Use durable MongoDB compare-and-set state, expiring reservations and counters.
  Preserve phone cooldown/verification bounds; replace secondary-provider limits
  with explicit primary send limits and a global hourly/daily ceiling.
- Produce deterministic, challenge-specific session/grant completion results.
  Booking completion uses a transaction where supported; otherwise prepare an
  idempotent grant before conditionally publishing completion. Grant consumption
  requires its linked completed challenge, so partially prepared grants fail closed.
- Retain completed challenges longer than their grants. Use a versioned challenge
  collection so new indexes do not require deleting old challenges or indexes.
- Replace image storage SDK calls with native Google Cloud Storage against the
  existing bucket. Keep existing object paths and public URLs. Per the user's
  explicit follow-up, keep the existing storage environment-variable names; no
  deployment credential rename is required. These names do not load an auth SDK.
- No runtime fixed OTP codes in any environment. Tests inject provider boundaries
  only and must never send real SMS or connect to customer databases.

## Implementation gates

- [x] Inspect dependencies and isolate worktree; original checkout untouched.
- [x] Restore relevant regression tests without modifying ignore rules.
- [x] Test and implement durable primary send/approval/completion recovery.
- [x] Test and implement finite primary source and global limits.
- [x] Update Axios client and Arabic forms; remove provider-switching UI code.
- [x] Migrate all image storage calls and remove obsolete SDKs/configuration.
- [x] Run focused and accumulated suites, local Mongo transaction/standalone
      integration tests where available, production build and focused lint.
- [x] Independent security review and credential/configuration readiness check.
- [ ] Commit, fast-forward push to main, verify remote SHA (reported at release).

## Required regression cases

One send per challenge across concurrent requests, saved-send replay, failed send
result persistence and signed-receipt recovery, invalid/expired/tampered receipts,
no success for unexpected provider responses, approval persisted before profile
lookup, recover without a second provider check after profile/signing/grant errors,
same completion returned after lost HTTP response, concurrent verification fencing,
wrong code and phone/purpose/SID mismatch rejection, expired challenges, one-use
booking grants, transaction failure/unknown-commit recovery, standalone partial
completion, source/phone/global ceilings and TTL, Arabic errors/cooldowns and
double-click protection, all storage upload/delete imports, no removed-provider
runtime code or dependencies.

## Operational configuration

All environments now use real Twilio Verify. There is no development code.
The server requires TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN,
TWILIO_VERIFY_SERVICE_SID, MONGO_URI, CUSTOMER_SESSION_SECRET (32+ characters),
and OTP_SOURCE_HASH_SECRET. Existing CUSTOMER_SESSION_TTL_SECONDS remains
optional. None of these credentials is public or returned to the browser.

Image storage deliberately retains FIREBASE_PROJECT_ID, FIREBASE_CLIENT_EMAIL,
FIREBASE_PRIVATE_KEY and FIREBASE_STORAGE_BUCKET, as explicitly requested after
the initial migration request. Only the native Google Cloud Storage SDK reads
these variables. Existing objects, URLs and bucket permissions are unchanged;
no storage migration or cloud deletion is performed.

Primary sending policy (defaults):

| Boundary | Limit |
| --- | --- |
| Phone challenge/new send | 60-second cooldown; 5 per hour |
| Phone verification checks | 5 per 10 minutes |
| Source challenges | 10 per 10 minutes; 30 per hour |
| Source SMS sends | 5 per 10 minutes; 20 per hour |
| Application SMS sends | 50 per hour; 200 per day |

Source and application overrides are finite and capped in constants.js. Budget
reservations precede the paid provider call and are not refunded on uncertainty.
Source identity is HMAC-derived from Vercel's platform-set
x-vercel-forwarded-for header, never an arbitrary forwarded header. Production
fails closed outside the trusted Vercel environment. Local development uses a
shared hashed source, with the same paid-provider and spending policy.

Existing phone/source security collections retain their limits. The new
otpChallengesV2 collection has unique bearer hashes and a two-hour TTL, with
ten-minute logical verification expiry. Existing otpVerificationGrants indexes
and one-time consumption remain. Indexes are created lazily and recover after
initialization failures. MongoDB credentials must permit index creation.
No old collections, indexes, users, appointments or cloud objects are deleted.
In-flight challenges from the old provider flow need a fresh verification after
rollout; already-issued customer sessions remain valid with the same secret.

Saved send outcomes can be replayed without another SMS. Confirmed approvals
are persisted before profile reads, signing or grant issuance. Encrypted
recovery receipts allow a retry after transient writes fail. Same-challenge
recovery is not blocked by the separate cooldown for requesting a new SMS.
An unknown provider response is never approval. If neither a durable record nor
an observed-result receipt survives, recovery fails closed; the application
does not guess from a provider 404 or automatically send/check again.

## Verification record

- Baseline restored regression suite: 668 passed before migration.
- Final accumulated suite: 958 passed, zero failures or skipped tests.
- Includes real ephemeral MongoDB standalone and one-node replica-set tests;
  this checks transaction/standalone semantics, not multi-node failover.
- Production build: passed with a loopback-only, non-customer database URI.
- Changed source and tests: ESLint passed with zero errors/warnings.
- Full-project lint still reports six pre-existing React errors in unrelated
  admin layout, appointments modal, Hijri table and theme-hook code, plus
  warnings. The invalid ESLint images configuration was replaced while removing
  its obsolete provider hostname; unrelated source was not rewritten.
- Playwright/Chrome checks at 1440px and 390px passed for login and booking:
  one challenge, same-challenge receipt recovery despite a 3360-second cooldown,
  distinct Arabic invalid-code/temporary-service errors, no reCAPTCHA, no
  horizontal overflow. HTTP responses were mocked; no real SMS or appointment
  write was made. Server integration tests separately exercise real MongoDB.
- npm audit --omit=dev reports 11 dependency findings (1 critical, 5 high,
  5 moderate), including the existing Next.js version. No forced audit fix or
  unrelated framework upgrade was performed.
- Installed providers: twilio 5.12.0; @google-cloud/storage 8.1.0. Removed auth
  SDK packages and their transitive modules are absent from the lockfile and
  generated browser bundles.

## Changed areas

- package.json, package-lock.json and eslint.config.mjs.
- src/lib/twilio.js and src/lib/twilioOTP.js: bounded, non-retrying Verify client
  and SID-bound checks with conservative unknown-outcome classification.
- src/lib/otp: challenge/store, primary send, completion, encrypted receipts,
  grants, primary rate limits, API client, diagnostics and retry metadata.
- src/app/api/otp/challenge, send and complete: bounded inputs, safe errors,
  no-store responses, recovery receipts and secure session cookies.
- src/hooks/usePhoneOtp.js; AppointmentForm.jsx and LoginPage.jsx: direct
  Twilio flow, same-challenge recovery and Arabic errors/cooldowns.
- src/lib/cloudStorage.js and nine admin image-storage routes under perfumes,
  treatments, upload-hero-image and upload-service-image: native storage SDK.
- Removed the old auth initialization, phoneAuth helper, provider evidence,
  reCAPTCHA/error helpers and secondary-provider service/endpoint.
- Restored and updated regression tests, plus primary recovery, provider adapter,
  storage and real MongoDB integration tests. Existing ignore rules are unchanged;
  selected test source files are explicitly added to Git.

Git commit/push status is reported separately after verification. No deployment
success is inferred from a build or Git push. A real consenting-number SMS smoke
test on the deployed application remains an operational check.

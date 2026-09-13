# Firebase-First OTP V2

## Approved Production Rollout (2026-09-13)

This section supersedes the historical Preview-only stop conditions below. After
manually receiving an initial Firebase code and a resend, the user confirmed an
appointment and cancelled it from their profile on the repaired Preview. Vercel
recorded `booking_grant_issued` with provider `firebase` at 09:07:16 UTC, correlation
`fde4428a-2b34-4cf5-a989-0e7bc6aa09ad`. The later resend rejection was
`auth/too-many-requests`, not the previous Admin initialization failure; it correctly
did not initiate Twilio fallback. This verifies that scenario, not every possible
carrier, browser, or all five originally proposed booking scenarios.

The user then approved restoring cooldowns, merging/pushing main, deploying Production,
and deleting the feature branch/worktree. The temporary branch-specific Preview bypass
has been removed completely. Every environment now enforces the normal 60-second phone
cooldown, five phone starts/hour, shared-source admission and Twilio-send limits,
verification limits, and finite global paid-SMS budgets. No limits were raised and no
stored limit records were cleared. Same-attempt fallback still does not consume another
phone-start admission.

Fresh pre-merge verification after restoration:

- Regression RED: 4 failed / 6 passed before removing the bypass.
- Focused GREEN: 116/116 tests, 4 files, 1.71 seconds, exit 0.
- Full unit/integration suite: 1390/1390 tests, 37 files, 21.76 seconds, exit 0.
- Full Playwright suite: 106/106 desktop/mobile cases, 2.2 minutes, exit 0.
- Production build: exit 0; 24.1-second compilation, TypeScript phase, all 56 pages.
- Traced serverless artifact: 666 files, 2 relocated links; Admin app/auth imports pass.
- Focused ESLint and `git diff --check`: exit 0.
- npm audit: 21 reported packages (2 low, 7 moderate, 11 high, 1 critical), unchanged
  from the prior report; no advisory for firebase-admin, jwks-rsa or jose. Unrelated
  dependency upgrades were not included in this rollout.
- Automated providers were mocked and MongoDB tests isolated; no real SMS or
  appointments were created by these checks.
- The original `.env.local` and both worktrees' `.gitignore` files remain byte-for-byte
  unchanged. Storage implementation and storage environment-variable names are unchanged.

With explicit rollout authorization, `OTP_PROVIDER_MODE=firebase_first` was added to
Vercel's Production environment. No credential or storage variable was changed. A new
main deployment is required to apply it; saving the variable alone is not deployment
success. Verify the deployment's main SHA, Production target, Ready status and domain
before cleanup. Preserve old main `214cfec9cc68ce76f006c0c48dc69b8880a9c1b9` under
`rollback/pre-firebase-first-2026-09-13`. For a provider-only rollback, set Production
`OTP_PROVIDER_MODE=twilio_only` and deploy again; in-flight challenges retain their
stored policy. For an immediate code rollback, promote the previous known-good Vercel
Production deployment. Do not reset or delete application data.

## Scope and Rollout

Implemented on `codex/firebase-first-otp-v2`, based on the inspected, clean current main
`214cfec9cc68ce76f006c0c48dc69b8880a9c1b9`. No old Firebase implementation was restored.
The original checkout, `.env.local`, native Google Cloud Storage integration, storage
environment-variable names, scheduling, customer identity, and application-session
semantics are preserved. No production settings, cloud data, real appointments, or real
SMS were changed by automated verification.

`OTP_PROVIDER_MODE=twilio_only` is the default; `firebase_first` is opt-in. An invalid
configured mode fails closed. Mode, normalized phone, purpose, provider, expiry and
correlation ID are stored on each challenge. Changing the environment cannot change
the provider policy of an existing challenge. The browser cannot select the mode.

## Architecture

The shared login/booking client requests a server-owned challenge. In Firebase mode it
obtains a one-use send reservation, lazily loads the modular Firebase SDK, initializes
Auth with `inMemoryPersistence`, renders Firebase's `RecaptchaVerifier`, and calls
`signInWithPhoneNumber`. Only the first reservation response authorizes that SDK call.
Both forms own stable, distinct reCAPTCHA roots; the adapter owns a child, tracks its
verifier, and defers cleanup until a live send settles. No manually created reCAPTCHA
keys, private SDK members, IndexedDB persistence, or runtime fixed codes are used.

Firebase `ConfirmationResult.confirm(code)` produces a user credential and ID token.
The token is submitted to the existing `/api/otp/complete` boundary. Firebase Admin
`verifyIdToken(token, true)` verifies signature, issuer/project and revocation; additional
checks bind normalized phone, phone sign-in provider, UID, `auth_time`, issue/expiry time,
and stored challenge. Browser send acceptance never proves identity. Admin certificate,
network and unknown infrastructure failures are temporary service errors, not wrong OTPs.

Both providers then enter the existing durable approval and deterministic application
completion path. A Firebase UID does not create a separate SoulClinic identity: the same
normalized phone produces the same existing customer identity. Booking still requires
the existing one-use booking grant. Firebase proof cannot complete a Twilio challenge.
Application logout remains authoritative; best-effort Firebase `signOut` also clears
in-memory Auth and protects against a late browser sign-in completing after logout.

## Provider State Machine

```text
twilio_only: prepared(twilio) -> existing Twilio send/verify/approval/completion flow

firebase_first:
  prepared(firebase)
    -> firebase_sending [one random Firebase send reservation]
    -> firebase_sent [browser SDK acceptance acknowledgement; NOT approval]
    -> verifying [exclusive server evidence-check reservation]
    -> approved [server-verified phone evidence, persisted]
    -> completed [deterministic session or booking grant]

  firebase_sending + eligible settled technical send report
    -> prepared(twilio) [atomic, one-use provider transition]
    -> existing Twilio send/verify/approval/completion flow
```

Fallback cannot win once Firebase completion has started, even if an acceptance
acknowledgement was lost. Simultaneous fallback/completion cannot choose two providers.
Twilio transition replay must match the original Firebase reservation and failure report.
Only one Twilio dispatch is allowed; fallback consumes the same logical phone attempt.

## Exact Fallback Matrix

The SDK-free `firebaseSendPolicy.js` is the single client/server policy. Code names were
checked against installed Firebase 12.19.0 / `@firebase/auth` 1.13.6 `AuthErrorCodes`.
`auth/unknown` is an explicit backend-code passthrough, not an invented default.

| Evidence/stage | Automatic Twilio? | Reason |
| --- | --- | --- |
| `auth/internal-error`, `auth/network-request-failed`, explicit `auth/unknown`; settled `signInWithPhoneNumber` rejection; `send` + `firebase_sdk` | Yes, bounded and ambiguous | Technical SDK send rejection; Firebase may already have accepted an SMS |
| Public reCAPTCHA verifier `auth/network-request-failed` or `auth/timeout` at init/render/token | Yes | Adapter maps positive pre-send evidence to `recaptcha/network-request-failed` or `recaptcha/timeout`, with `recaptcha_sdk` provenance |
| `auth/captcha-check-failed`, `auth/invalid-app-credential`, `auth/missing-app-credential` | No | These broad errors cannot distinguish technical breakage from security rejection |
| `auth/recaptcha-not-enabled`, missing/invalid reCAPTCHA token/action/version/client type/request type | No | Configuration, malformed-request, or security evidence is not proof of a technical send outage |
| `auth/too-many-requests`, quota/billing exhaustion, application phone/source/global limit | No | Never bypass provider or application abuse/spending controls |
| Invalid/missing phone, unauthorized domain, invalid API key/app ID, disabled Phone Auth, disabled user, rejected credential | No | Invalid input, configuration, or security rejection |
| Wrong/expired OTP, confirm failure, token retrieval failure | No | Verification-stage recovery, not send-stage fallback |
| Code-less JavaScript exception, unsupported future code, post-send exception | No | Unknown provenance/outcome fails closed |
| Live/hanging operation or local watchdog | No | Still-live Firebase operation must not run alongside Twilio |
| Database, profile, session signing, grant/booking failure | No | Recover application state; do not send another OTP |
| SDK informational Enterprise-config-to-v2 message | No | Not an application send failure |

The browser report is untrusted. Neither allowlisting nor provenance fields cryptographically
prove Firebase failed. The server also enforces challenge bearer/phone/purpose/source binding,
expiry, current state, atomic transition, and paid-send budgets. An attacker holding an admitted
challenge can fabricate an eligible report; finite limits bound this residual spending risk.
Cross-provider duplicate SMS cannot be absolutely prevented after an ambiguous settled send
rejection. No promise race starts Twilio while the original Firebase operation is live.

## Recovery and Resend

- Existing Twilio saved-send replay, dispatch fencing, encrypted send/approval receipts,
  persisted approvals, fail-closed unknown outcomes, and deterministic sessions/grants remain.
- Firebase acceptance acknowledgement can be replayed without an SDK resend. A browser with
  a valid confirmation can submit verified evidence even if that acknowledgement was lost.
- Successful Firebase confirmation is cached in memory. Token reads are capped at three;
  credential/proof retention expires five minutes after successful confirmation. Late results
  are ignored. Application completion retries use cached proof and never reconfirm the OTP.
- Server approval precedes profile/session/grant work. An encrypted, challenge/provider/attempt-
  bound receipt recovers observed approval if persistence fails, without another Admin check.
- Non-approval retry receipts recover settled failed evidence checks and uncertain reservation
  writes. A reservation receipt covers both its committed reservation and its unchanged prior
  state, but never resets a newer verifier. It still requires fresh, valid Firebase evidence.
- Durable approval wins over an obsolete retry receipt after a lost successful HTTP response.
  No unknown provider result or non-approval receipt can issue a session/grant.
- Recovery replays the same attempt. Explicit resend creates a new server challenge only after
  the authoritative deadline; it follows the configured policy. Recovery of a transitioned
  challenge stays Twilio. A genuinely new challenge may try Firebase again.
- Pending operations are surfaced without a parallel fallback. An unobservable provider result
  plus lost process/browser memory cannot be reconstructed. It fails closed until safe expiry
  and a fresh attempt. Browser refresh also loses Firebase confirmation/proof by design.
- Changing normalized phone abandons old state; equivalent formatting does not. Source
  restrictions survive phone edits. Generation checks ignore old asynchronous responses.

## Limits

Existing defaults and bounded overrides are preserved, not raised for tests:

| Control | Default |
| --- | --- |
| Phone challenge cooldown | 60 seconds |
| Phone challenge starts | 5/hour |
| Phone server verification reservations | 5/10 minutes |
| Source challenge admission | 10/10 minutes; 30/hour |
| Twilio source paid-send budget | 5/10 minutes; 20/hour |
| Application Twilio budget | 50/hour; 200/day |
| Challenge lifetime | 10 minutes |
| Booking grant lifetime | 10 minutes from approval |
| Security/challenge retention | 2 hours; completion/grant linkage retained appropriately |

Firebase fallback does not claim phone-start cooldown again. It does claim Twilio source and
global budgets before the paid call. Shared Vercel source identity is HMAC-derived, not a
customer identity; changing phone cannot clear it. CAS retry jitter was added to prevent
parallel requests retrying in lockstep; the eight-attempt cap and all numeric limits remain.
Verification budgets can count technical checks conservatively; Arabic copy says verification
attempts/temporary failure, never falsely asserts the customer entered too many wrong codes.

## Configuration Readiness

Read-only inspection through the connected Firebase account and authenticated CLI confirmed:
project `soulclinc-production`, existing web app `soulclinc-web`, Phone enabled, and SMS region
allowlist `IL`. Auth domain is `soulclinc-production.firebaseapp.com`. Enterprise phone
enforcement was unspecified; none was enabled. No project, app, API key, service account,
private key or reCAPTCHA key was created. Blaze and API-key restrictions were supplied by the
user, not independently reconfigured by this implementation.

Original local variables were checked for presence/alignment without displaying values.
Vercel's UI confirms all four `NEXT_PUBLIC_FIREBASE_*` and all four existing storage/server
variables exist for All Environments. Their values were not revealed. Twilio credentials,
customer-session secret and source-HMAC secret remain required. Only a branch-scoped
`OTP_PROVIDER_MODE=firebase_first` should be added for this Preview.

`FIREBASE_PRIVATE_KEY` is currently classified as Config in Vercel, which displays a warning.
Changing/rotating production credentials was not authorized and was not performed. Separately
consider classifying this existing secret appropriately after an approved operational review.

The new exact Preview hostname is not covered by old Preview hostnames. Authorization must
be checked after deployment, and adding a missing hostname requires explicit user approval.

## Dependencies and Changed Files

- Added runtime dependencies: `firebase` 12.19.0 and `firebase-admin` 14.4.0, locked in Git.
  Existing Next.js 16.1.4, React 19.2.3, Twilio and native GCS implementations are retained.
- New adapters/policy: `src/lib/otp/firebaseClient.js`, `firebaseSendPolicy.js`,
  `firebaseAdminAuth.js`, `firebaseEvidence.js`.
- New server orchestration: `src/lib/otp/firebaseSend.js`, `firebaseCompletion.js`,
  `firebaseHttp.js`; `src/app/api/otp/firebase-send/route.js`, `fallback/route.js`.
- Extended existing challenge/complete routes, challenge service/store, completion service,
  booking-grant provider binding, recovery receipts, diagnostics, and CAS contention timing.
- Extended shared `src/lib/otp/client.js`, `src/hooks/usePhoneOtp.js`, login/appointment forms,
  and customer logout cleanup. Appointment scheduling and storage modules have no changes.
- Added focused Firebase policy/client/Admin/server/route/controller/Mongo tests and updated
  old provider-boundary contracts. Added `playwright.otp.config.cjs` and the test-only
  `tests/e2e/firebaseOtpV2/` harness. Test sources must be force-added where normally ignored;
  generated reports/screenshots stay untracked. No `.gitignore` edit is needed.

## Verification Record

Actual baseline before production edits: **958/958 tests**, 26 files, 34.69 seconds.
Final runs below include the last reviewed receipt/recovery fixes.

- Full suite: **1368/1368**, 35 files, 27.03 seconds (2026-09-11 18:56 UTC).
- Focused OTP suite: **1246/1246**, 30 files, 38.09 seconds.
- Playwright rerun: **98/98 passed**, desktop 1440x1000 and mobile 390x844, zero retries.
  Real production React forms/hook/client/adapter, mocked Firebase SDK imports and OTP HTTP;
  isolated browser contexts, no provider traffic or appointment POST. This is component/browser
  integration, not the complete Next server/real-provider flow. Full page ancestors, mobile OS
  suspension, actual SMS carrier delivery and cloud Admin credentials remain smoke-test scope.
- Ephemeral Mongo standalone and replica-set suite: **34/34 passed**. Includes atomic
  fallback/completion races, grant consumption, profile/session/grant recovery and HTTP loss.
- Four Mongo load cases repeated three times: **12/12 passed**, no state-busy 503s.
  With the same shared source, Firebase accepted all first 10 identities; the next 10 sequential
  starts correctly returned source 429. Fallback accepted 5 paid sends, blocked the other 5
  at the paid-send source budget, then blocked all next 10 at source admission. No limits changed.
- Final build passed (31.5-second compilation; 56 static pages) with dummy process-only public config and unreachable local database URL;
  Next TypeScript phase passed. No separate type-check command exists in this JavaScript repo.
- Final focused ESLint passed without warnings/errors. Staged whitespace check passed.
- All independent review gates passed: Admin boundary, client lifecycle/recovery, server
  provider/recovery races, and cross-module security/scope. Server reviewer additionally
  passed 651 focused tests and 29 in-memory safety-probe groups.
- Original main stayed clean. Original `.env.local` and `.gitignore` SHA-256 hashes and
  the new worktree's initial `.gitignore` hash remained unchanged. The fresh checkout uses
  Git's existing CRLF conversion; its tracked `.gitignore` blob is identical to main.
- Staged-source scan against eight actual local secret values found zero matches. Browser
  build scan found no Admin SDK or server credential/secret variable markers. Firebase Auth
  is lazy/browser-only and native GCS source has an empty diff against the baseline.
- `npm audit`: 21 total (2 low, 7 moderate, 11 high, 1 critical). Production-only: 11
  (5 moderate, 5 high, 1 critical). A fresh original-main production audit returned the same
  11 advisory package names/severities. Existing Next critical advisory and other baseline
  issues need a separate approved dependency task; no automatic/forced upgrades were made.

## Diagnostics and Monitoring

Structured events use the existing correlation ID across admission, Firebase SDK/Auth,
reCAPTCHA token, send start/accept/reject/unknown, fallback decision/reservation, provider
approval, and application completion. Whitelisted classification/reason, elapsed time,
restriction scope, deadline, server deployment SHA/environment are safe fields. Existing
Twilio send/check events remain. No phone, IP, code, bearer, grant, cookie, ID/refresh token,
reCAPTCHA token, credential, or raw provider error payload is logged.

Browser events currently go to the browser logger, not a new remote ingestion service.
Dashboards/alerts should correlate server events by attempt/provider/stage and separate send
acceptance, code approval, application completion and user abandonment. A send acceptance is
not evidence of carrier delivery. Avoid treating sent-versus-verified totals as a failure rate.

## Preview Procedure and Approvals

Implementation commit `627099936edd7f31f7cc9c3785ef97fa8e0dd449` was pushed only to
`origin/codex/firebase-first-otp-v2`. Vercel independently showed **Ready / Preview** for
deployment `D6WYLYeCsJxxHbqGLKqZzTKNKGvM`, a 53-second build, source commit `6270999`.

- Branch Preview: https://soulclinic-git-codex-firebase-fir-4de5c3-rizik-dhabres-projects.vercel.app/
- Initial immutable Preview: https://soulclinic-k6dkbul68-rizik-dhabres-projects.vercel.app/
- `OTP_PROVIDER_MODE=firebase_first` was then saved successfully for **Preview /
  codex/firebase-first-otp-v2 only**. Production and other environments were not selected.
  This reporting commit triggers a fresh branch Preview after that setting was saved.
- Read-only Firebase Authorized Domains reinspection confirms neither new hostname is
  authorized. **Stop before adding a hostname or requesting real SMS.** Authorize the
  stable branch hostname above, with user approval, before the actual login smoke test.
- The first Preview served the existing logo and hero images successfully. Full Next login
  and appointment pages rendered at 1440x1000 and 390x844 with one stable OTP container per
  form and no horizontal overflow (document widths 1425 and 375). Login had no reCAPTCHA
  frame before a send, consistent with lazy initialization. No phone was entered, no OTP
  request was made, and no appointment was submitted. Native GCS uploads remain covered
  by mocked tests; no cloud upload/delete was performed.
- Remote `main` was independently verified unchanged at
  `214cfec9cc68ce76f006c0c48dc69b8880a9c1b9`. The Vercel production card still referenced
  that same baseline. Actual Firebase SMS delivery/Admin credentials and controlled real
  Twilio fallback remain unverified until the approved smoke test.

1. Push only `codex/firebase-first-otp-v2`, never main. Create/observe its Vercel Preview.
2. Scope `OTP_PROVIDER_MODE=firebase_first` to that branch only and build a fresh Preview.
3. Confirm its source commit and Ready state independently; record exact HTTPS URL.
4. Compare that hostname with Firebase Authorized Domains. Stop for approval before adding it.
5. Obtain explicit approval for real SMS and the specific owned phone number. Do not use random
   real numbers, localhost for final phone testing, or real SMS load tests.
6. On login, test Firebase SMS receipt, OTP confirmation, SoulClinic session and logout.
7. Test one controlled eligible technical send failure and real Twilio fallback using a
   scoped test interception, not production configuration or a runtime bypass. Verify only
   the selected provider completes. Do not complete a real appointment.
8. Report observed delivery separately from mocks/fictional-number tests, plus safe correlation
   IDs, provider stages, and any remaining environment/credential problem.

## Rollback

Set `OTP_PROVIDER_MODE=twilio_only` on the affected nonproduction scope and redeploy that
scope. New challenges use the existing Twilio path directly without loading Firebase.
In-flight challenges retain their original frozen provider policy and can finish/recover.
Keep dependencies and adapters deployed until those challenges expire. Main/production
rollout, changes to production settings, and any production rollback require later approval.

## Resend Repair (2026-09-11)

The approved Preview smoke test confirmed actual Firebase SMS receipt from the booking
form on `soulclinic-g9n87vjde-rizik-dhabres-projects.vercel.app`. A separate eligible
pre-send reCAPTCHA technical failure completed a real Twilio login and application logout.
No appointment was created. Firebase code confirmation/Admin verification and the
post-fix real resend remain to be tested. The original resend's server event omitted
its underlying error, so the exact historical exception cannot be conclusively recovered.

The resend adapter reused the same inner HTML element after clearing an invisible
verifier. The installed SDK's `clear()` destroys the verifier without unregistering that
element from the underlying reCAPTCHA renderer. Cleanup now removes and retires only the
adapter-owned child after the send settles, allowing a fresh child for a later send.
The form root and ownership lock remain stable; no live send is cancelled or raced.
Provider policy, fallback eligibility, limits, sessions, grants and booking rules are unchanged.

The earlier SDK doubles did not model duplicate rendered-host rejection. Strengthening
them reproduced the generic `client/unclassified` / `recaptcha_render` failure before
the production fix: 5 client cases failed and all 4 login/booking desktop/mobile resend
cases failed. These are isolated reproductions, not a claim that the historical browser
exception was captured. The browser regression now verifies the new challenge's code
and proof, not just its request count, and asserts no fallback or rejected send.

Actual post-fix verification:

- Pre-edit baseline: 1368/1368 tests, 35 files, 32.40 seconds.
- Focused Firebase adapter: 70/70 tests.
- Focused Playwright resend: 4/4, 9.9 seconds.
- Full suite: 1371/1371, 35 files, 29.35 seconds.
- Full Playwright: 98/98, 178.209 seconds; no failures, skips or flaky cases.
- Focused ESLint: exit 0, no warnings/errors.
- Production build: exit 0; 24.5-second compilation, TypeScript phase and 56 pages passed.
  The first local build used the wrong database variable name and failed at page-data
  collection; the successful rerun supplied process-only `MONGO_URI` with an unreachable
  loopback URL and synthetic public Firebase configuration. No env files were read/copied.
  The existing stale Browserslist-data warning remains; dependencies were not changed.
- No real SMS or appointment writes during this repair's automated tests.

Repair files: `src/lib/otp/firebaseClient.js`, `tests/otp/firebaseClientV2.test.js`,
`tests/e2e/firebaseOtpV2/sdk.mock.js`, `tests/e2e/firebaseOtpV2/otp.spec.cjs`, and this report.
The tests are tracked despite the unchanged ignore rules. Push/redeployment is scoped to
`codex/firebase-first-otp-v2` only. A new immutable Preview hostname must be checked against
Authorized Domains before a real-provider retry; the old immutable URL keeps its old code.

## Temporary Preview Cooldown Exception (2026-09-12)

At the user's request, `rateLimitStore.js` skips phone request cooldown/hourly admission
and shared-source challenge/send throttling only when both server deployment values match:
`VERCEL_ENV=preview` and `VERCEL_GIT_COMMIT_REF=codex/firebase-first-otp-v2`.
It returns a zero-delay server deadline, so both OTP forms permit immediate explicit resend.
This applies to requests on that Preview, not just one phone number. Existing phone/source
security records are neither reset nor changed by the exception. Other branches, local
development, missing deployment metadata and Production retain their original limits.

Wrong-code limits, provider security/throttling, finite global Twilio SMS budgets, source
binding, challenge validity, one-dispatch concurrency controls, sessions and booking grants
are unchanged. No bypass verifies an OTP or approves an appointment. The separate Firebase
Admin completion `503` remains unresolved; this exception is not a fix for that error.
Remove this temporary exception after manual testing and before proposing a main merge.

Verification: the pre-edit focused baseline passed 161/161 tests. The new regression suite
failed 3 cases before the change (phone/source exemption and both forms' zero cooldown),
then the focused suite passed 170/170 across 6 files. Focused ESLint and the production
build passed (16.5-second compilation, TypeScript phase and all 56 pages). Automated
checks used isolated in-memory stores and mocked providers, with no real SMS/appointments.

## Completion Failure Investigation (2026-09-12, In Progress)

The c5a949d Preview logged two accepted Firebase sends followed by a booking
completion 503 (`OTP_VERIFY_TEMPORARY_FAILURE`) for correlation
`1e815aa0-fb60-4aca-b007-a8cb97f7006b`. No provider-approved or booking-grant event
was recorded. A later send rejection omitted its reported Firebase error code.
This evidence identifies the failing boundary, not the underlying Admin cause.

Added correlated, allowlisted Admin SDK-load/init/verify events before error
sanitization and a bounded client-reported send rejection reason. Public error
classification, verification, grants, provider selection and limits are unchanged.
No raw exception, phone, OTP, token, credentials or provider payload is logged.
Three regressions failed before this change. The focused suite now passes 260/260
tests across five files; focused lint and the production build pass (42-second
compilation, TypeScript phase, all 56 pages).

Prior investigation ran 24 desktop/mobile Playwright resend/completion checks with
mocked provider/API boundaries, all passing, plus a locally built Next server and
ephemeral MongoDB with the real Admin SDK: malformed tokens and invalid signatures
both returned 401, with no grants or appointments. These do not prove successful
verification on Vercel. Its Node runtime is 24.x and Firebase variable names are
present for all environments. No existing Firebase fictional numbers are configured.
The instrumented commit `a6dcebfed31dc151e0360cbf6aae5657ced5877c` was pushed only
to the feature branch. Vercel independently reported its Preview Ready:
`https://soulclinic-mmke8nco6-rizik-dhabres-projects.vercel.app/`.
The exact new hostname is not in the last inspected Firebase Authorized Domains;
approval has been requested before adding it and running one real verification.
No Firebase configuration has been changed during this investigation.

Additional verification during the investigation:

- Full unit/integration suite: 1387/1387, 36 files, 26.34 seconds, exit 0.
- Eight new Playwright cases reproduced the exact temporary-server-error UI after
  the second send, then exercised cached-proof recovery or an explicit third send.
  All 8 passed on desktop/mobile for login/booking (18.0 seconds). Recovery made
  no extra SMS request or code confirmation; explicit resend used challenge 3
  and discarded the old recovery receipt. Mocked completion then succeeded.
- Full Playwright suite including these cases: 106/106, exit 0. Providers and API
  boundaries were mocked; booking submissions remained in memory, not MongoDB.
  Desktop/mobile error screenshots were visually inspected for wrapping/overflow.
- Focused lint for both modified browser-test files: exit 0.
- A read-only local Admin probe used existing local server credentials and looked
  up only the previously authorized test phone. Initialization and the lookup
  succeeded, the phone matched and the account was not disabled. It sent no SMS
  and emitted no secrets or customer fields. This does not establish that Vercel
  has the same credential values or can verify a valid token end to end.
- Main remains `214cfec9cc68ce76f006c0c48dc69b8880a9c1b9`; original and feature
  `.gitignore` hashes and the original `.env.local` hash are unchanged.

Authorized manual verification on the diagnostic Preview is still required to
identify and fix the actual failure. Passing mocks are not evidence that the live
Firebase completion 503 is fixed; the full goal is not yet complete.

## Admin Runtime Compatibility Repair (2026-09-13)

The user authorized five real booking/resend/cancellation scenarios. Testing stopped
at scenario 1's first completion failure. On the mmke8nco6 Preview, Firebase accepted
the initial send and the in-place resend, both received by the user. Completion at
08:45:30 UTC returned 503 for correlation `dd335696-370d-4d67-b992-870a785ab044`.
The correlated events show `firebase_admin_sdk_load` failed before `firebase_admin_init`.
No provider approval, booking grant or appointment was created by that attempt.
The remaining scenarios and profile cancellation are not yet verified.

The installed chain is Firebase Admin 14.4.0 -> jwks-rsa 4.1.0 -> jose 6.1.3.
jwks-rsa's CommonJS `src/utils.js` calls `require('jose')`, but jose 6 is ESM-only.
Importing real `firebase-admin/auth` with Node's `--no-experimental-require-module`
reproduces `ERR_REQUIRE_ESM`; the app module alone loads. AWS documents that flag
as a Lambda runtime default, including Node 24. The same incompatibility is reported
upstream for Firebase Admin and jwks-rsa. This is a demonstrated runtime defect
matching the live SDK-load boundary, not a captured raw exception from Vercel:
the live event was `admin/unclassified` after the external loader wrapped the error.
Successful real completion on the new Preview remains necessary to close the diagnosis.

The repair is a narrow npm override: only `firebase-admin -> jwks-rsa -> jose` uses
the dual CommonJS/ESM version 5.10.0. The application's direct jose remains 6.1.3,
Firebase Admin remains 14.4.0, and Firebase client remains 12.19.0. No SDK internals
are patched, no experimental runtime flag is enabled, and no OTP/session/grant,
storage, provider-selection or rate-limit code changes. Revisit this compatibility
override when the upstream CommonJS loading fix is released; it is intentionally
scoped, not a recommendation to downgrade the application's token library.

Changed files for this repair: `package.json`, `package-lock.json`, this report,
`tests/otp/firebaseAdminRuntimeV2.test.js`, and `tests/otp/checkFirebaseAdminTrace.cjs`.
The latter copies only Next's completion-route trace into an isolated temporary
directory and relocates external-package links, so full checkout dependencies cannot
hide missing deployment files. Run it after building with
`node tests/otp/checkFirebaseAdminTrace.cjs`. Both new tests/scripts are explicitly
tracked despite the unchanged ignore rules.

Actual checks:

- Regression RED: both real-SDK tests failed with `ERR_REQUIRE_ESM` before the override.
- Focused GREEN: 149/149 tests across Admin runtime, Admin initialization and evidence.
  A malformed JWKS fixture shape was corrected during the green run; real signing-key
  conversion and acceptance/rejection of valid/invalid RSA signatures are asserted.
- Full unit/integration suite: 1389/1389, 37 files, 25.18 seconds, exit 0.
- Full Playwright suite: 106/106 desktop/mobile cases, 2.2 minutes, exit 0,
  with mocked SDK/API boundaries and no real SMS or appointment writes.
- Focused ESLint for both new test files: exit 0.
- Production build: exit 0, 14.8-second compilation, TypeScript phase and all 56 pages.
  The first invocation lacked MONGO_URI and failed page-data collection; the successful
  invocation used process-only unreachable loopback MongoDB and synthetic public
  Firebase settings. No env file was copied, read for the build or overwritten.
- Traced artifact: 666 files and 2 relocated links; app/auth imports both succeed
  with Lambda-style module restrictions, without a real account or SMS.
- Compiled Next endpoint with ephemeral MongoDB and real Admin under those flags:
  malformed proof and a deliberately invalid signature both return 401
  `OTP_VERIFICATION_INVALID`, not 503; zero grants and appointments. The signature
  probe fetched only Google's public certificates, not customer data.
- npm audit remains 21 reported packages (2 low, 7 moderate, 11 high, 1 critical),
  matching the previously recorded totals. No advisory is reported for jose,
  jwks-rsa or firebase-admin. Existing unrelated advisories were not auto-upgraded.
- Original `.env.local` and both original/feature `.gitignore` hashes are unchanged.

No further real SMS was sent while diagnosing this failure. Do not count the local
compatibility fix as completed real booking coverage. A new immutable Preview hostname
must be checked/authorized before restarting the user-supervised scenarios; never
reuse an expired code or claim the failed attempt created an appointment.

Supporting sources:
- [AWS Lambda Node.js runtime flags](https://docs.aws.amazon.com/lambda/latest/dg/lambda-nodejs.html)
- [Firebase Admin upstream interoperability issue](https://github.com/firebase/firebase-admin-node/issues/3181)
- [jwks-rsa CommonJS interoperability issue](https://github.com/auth0/node-jwks-rsa/issues/507)
- [Unreleased upstream lazy-import fix](https://github.com/auth0/node-jwks-rsa/pull/508)

## References

- [Firebase modular web phone authentication](https://firebase.google.com/docs/auth/web/phone-auth)
- [Firebase Admin ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Twilio Verify best practices](https://www.twilio.com/docs/verify/developer-best-practices)
- Installed SDK `AuthErrorCodes` is the exact version-specific error-name source; policy
  exclusions reflect SoulClinic's explicit security requirements, not a universal Firebase list.

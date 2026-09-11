# Firebase-First OTP V2

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

At the implementation commit, Preview creation is pending the isolated-branch push. The
first attempt to add its branch-scoped mode was rejected because the branch did not yet
exist on GitHub; no setting was applied. Deployment evidence will be appended after push.

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

## References

- [Firebase modular web phone authentication](https://firebase.google.com/docs/auth/web/phone-auth)
- [Firebase Admin ID-token verification](https://firebase.google.com/docs/auth/admin/verify-id-tokens)
- [Twilio Verify best practices](https://www.twilio.com/docs/verify/developer-best-practices)
- Installed SDK `AuthErrorCodes` is the exact version-specific error-name source; policy
  exclusions reflect SoulClinic's explicit security requirements, not a universal Firebase list.

# OTP Failure Diagnostics

## Scope

Diagnostics and send-screen fixes on `codex/otp-failure-diagnostics`, based on main
`76ad12b30ed9d542f67e3d519c17857b8a6d127e`. No changes to fallback eligibility,
SMS limits, cooldowns, server session/booking verification, or storage. Arabic UI is
preserved with corrected sending/recovery states. No environment files or `.gitignore`
files are changed. Preview rollout requires `OTP_PROVIDER_MODE=firebase_first` scoped
only to this new branch; Production settings and Firebase configuration remain untouched.

## Send Screen

- Admission and reservation alone never open code entry. The controller stays `sending`
  through SDK/reCAPTCHA/send handling, including automatic fallback, with Arabic progress.
- Successful sending opens `code`. Terminal failures return to the phone form (`idle`).
- Unresolved sending stays on the phone form (`send-recovery`). The status-recovery
  button replays the saved attempt/receipt, not a new challenge. Existing cooldown and
  in-flight fencing remain authoritative; there is no automatic retry loop.
- A local Firebase ConfirmationResult is provider acceptance. If acknowledgement
  persistence fails afterward, keep code entry usable and preserve proof-backed server
  completion without another SMS or another acknowledgement request. This exception
  does not apply to unknown sends, failed challenges, or Twilio-selected challenges.
- Explicit resend hides the old code entry while its new send runs. The recovery button
  is labeled separately from an explicit SMS resend, including acknowledgement recovery.
- Both reCAPTCHA root elements remain outside conditional form content. Booking's
  blocking loading overlay is removed; inline progress leaves reCAPTCHA unobstructed.
- The verify action is gated until accepted code-entry state. Wrong/expired code and
  completion errors keep their existing verification/recovery behavior.

## Evidence Retained

Each recorded failure retains the existing server-owned correlation ID and purpose,
plus bounded `errorCode`, `failureStage`, `failureProvenance`, `failureCategory`,
`fallbackDecision` and `fallbackReason`. Where available, `failureBoundary` distinguishes
loading the adapter/SDK, Auth initialization, reCAPTCHA render/token, sending, confirming
the code, and obtaining the ID token. `errorType` preserves only known exception names.

Categories distinguish phone input, invalid/expired codes, invalid verification state,
provider throttling, quota/configuration, app verification, security rejection, technical
send/setup/confirmation failures, client lifecycle, pending operations, and unclassified
errors. A category describes the reported error; it is not proof of its underlying cause.
In particular, `app_verification` does not prove abuse, and `quota_or_billing` does not
prove the billing account is disabled.

Ordinary Firebase send rejections are logged before the state write, so a write outage
does not erase the reported cause. Successful writes retain `firebaseSendFailure` on
the existing OTP challenge. The same field is stored atomically with a Twilio fallback
transition. It contains only diagnostic enums and a server observation timestamp.
Existing `fallbackFailure` authorization/replay semantics remain unchanged.

Browser-only confirmation/token failures, adapter-load exceptions and watchdog-pending
signals use `operation: diagnostic` on the existing `/api/otp/firebase-send` endpoint.
The endpoint requires the challenge bearer, reservation ID, source binding, unexpired
challenge, Firebase policy and current Firebase ownership. It never sends SMS, checks a
code, issues proof, modifies counters, or changes provider/state/expiry/retention.
Reports are atomically deduplicated and capped at six distinct samples per challenge;
CAS retries are capped at three. No new collection or index is needed.

These browser uploads are best effort, not awaited by OTP handling, not automatically
retried, and have a five-second HTTP timeout. A failed upload cannot replace the user's
original error. The timeout is for telemetry only, never for a Firebase send.
The same allowlisted failure context is also retained in the browser console before
upload, including the original native exception type and the lazy adapter-load boundary.
Pending reports are logged as `firebase_send_unknown`, decision `blocked`, not as
terminal send failures. Late Firebase results retain the existing protections.

## Privacy And Interpretation

- No OTPs, raw phones/IPs, reCAPTCHA/ID tokens, cookies, grants, stack traces, exception
  messages, URLs, or provider payloads enter these diagnostic fields or logs.
- Challenge bearers and reservation IDs travel only as authorization in the existing
  API request. They are not logged or copied into diagnostic records.
- Diagnostic hints cannot expand fallback eligibility. The server computes the category
  and fallback decision from the original bounded failure report, not a client decision.
- Browser evidence is explicitly `client_reported`, not trusted provider delivery proof.
- Code-less exceptions remain `client/unclassified`, never invented `auth/unknown`.
- The challenge's existing purge deadline still applies. Preserve necessary safe events
  from Vercel before its log retention expires; this change is not permanent monitoring.
- A dropped connection, closed tab, failed telemetry request, or expired challenge can
  still prevent reporting. SMS acceptance is not proof of physical handset delivery.
- Missing historical error details cannot be reconstructed by deploying this change.

## Manual Five-Phone Test

1. Deploy this branch's verified build to an approved testing environment first. The
   current production website will not gain these diagnostics until a rollout is approved.
2. For a Preview, verify its exact hostname is authorized in Firebase before any SMS test.
3. Use only phones whose owners consent. Record an approximate time and device/browser
   for each attempt. Do not repeatedly resend after a rate-limit response.
4. Check receipt separately from sending, then check verification and appointment saving
   separately. Any real appointment creation/cancellation remains a manual user action.
5. If an error occurs, preserve the approximate time and visible message; no OTP or token
   is needed to investigate. Correlate the Vercel request with `otpChallengesV2` internally.
6. Inspect `firebase_send_rejected`, `firebase_client_failure`, `firebase_send_unknown`,
   `fallback_decision` and existing Twilio/completion events under the same correlation ID.
   `fallbackDecision: blocked` plus the code/stage explains the policy stop; `eligible`
   alone does not prove that Twilio was dispatched or delivered.

## Initial Diagnostics Verification

Baseline: 1,389 passed and one existing Firebase Admin startup test timed out under
default worker concurrency. The unchanged suite rerun with `--maxWorkers=2` passed all
1,390 tests. New regressions were observed failing before implementation.

Final unit/integration verification: `npm run test:run -- --maxWorkers=2`, **1,491 tests
passed across 38 files**, including real ephemeral MongoDB standalone and replica-set
tests. Concurrent diagnostics versus completion/fallback preserve one final provider,
one grant and one external provider call where appropriate. New classifier tests are
explicitly included in Git despite the existing test-directory ignore rule.

Final Playwright run: `node tests/e2e/firebaseOtpV2/run.cjs`, **114 passed**, zero retries,
covering desktop and mobile login/booking components. Includes eight new diagnostic UI
cases, plus the existing resend, fallback, recovery, lifecycle and layout matrix.
This is a browser harness with the real production components and mocked providers/API
responses, not a live Safari-device or carrier-delivery test. All outbound provider and
appointment HTTP requests are blocked; no real appointment is created. Local evidence:
`tests/e2e/firebaseOtpV2/artifacts/report.json` and `artifacts/bundle-manifest.json`.

Focused ESLint on all six changed OTP source modules passed. Default Next.js 16.1.4
Turbopack production build passed, including the framework's type-check stage and all
56 static pages, with a synthetic process-local loopback `MONGO_URI`. No production
credentials or environment files were used. Earlier build attempts exposed only the
temporary shared-dependency junction and the absent Mongo URI; a separate locked
dependency install and the build-only URI resolved those environment issues. Package
and lock files are unchanged. The existing stale Browserslist-data warning remains.

Independent review's browser-log coverage and ignored-test findings were addressed;
follow-up review reported no new actionable issue. No SMS, real appointment, production
data write, push, merge or deployment was performed during this implementation.

## Send-Screen Verification And Preview Readiness

Current combined branch: `npm run test:run -- --maxWorkers=2` passed **1,500 tests in
38 files** (43.32s), including ephemeral MongoDB standalone and replica-set suites.
`node tests/e2e/firebaseOtpV2/run.cjs` passed **138 tests**, zero retries (2.8m), with
mocked providers and intercepted APIs. Desktop/mobile screenshots were checked; the
browser suite asserts stable roots, no overflow, pending/failed/resend/recovery states,
and proof-backed Firebase completion through an acknowledgement outage. These are
Chromium viewport tests, not proof of real iPhone Safari or carrier delivery.

The eight new controller regressions and six initial mobile browser regressions failed
before the fix. Review then identified acknowledgement recovery as a required exception;
its regression also failed before the correction. Older prepared-code expectations were
updated to the new states while retaining same-attempt resend API behavior. Final
read-only review reported no actionable issue.

Final focused lint passed on all nine changed production modules. The final Next.js
16.1.4 Turbopack build, type-check stage and all 56 static pages passed using only the
synthetic loopback Mongo URI described above. Dependencies did not change. Original
checkout `.env.local` and `.gitignore` hashes remain unchanged; original main is clean.

Read-only Firebase inspection confirms Phone Auth enabled, Israel allowed, and no
explicit Enterprise phone enforcement. The newly generated Preview hostname is not
covered by the currently authorized domains and requires user approval before adding it.
Vercel's Firebase variable names are present in All Environments. The existing Preview
provider-mode variable is scoped to the old feature branch, so the new branch needs its
own Preview-only setting before manual Firebase testing. No real SMS or appointment
was used during implementation. User approved pushing/deploying this branch to Preview
only; merging, pushing main, and Production deployment remain unapproved.

## Separate SDK Error Identifiers

Follow-up to Preview `e1f897f`: Firebase errors outside the OTP policy were being
collapsed to `client/unclassified`, including their diagnostic identity. Diagnostics
now retain `sdkErrorCode` separately, before policy normalization, using the complete
installed Firebase Auth public error catalog plus the existing `auth/unknown` backend
passthrough. The catalog is SDK-free production code, so Auth remains lazy-loaded.
Tests compare diagnostic coverage to the installed SDK's public `AuthErrorCodes`.

The existing three-field failure report remains unchanged. Diagnostic identity does
not affect fallback eligibility, user-facing messages, ownership, verification, limits,
or provider dispatch. A forged diagnostic `auth/internal-error` cannot make an
unclassified or ineligible failure fall back. Browser transport, API projection,
server persistence, and the log sink each preserve only approved diagnostic fields.

Native Firebase errors without a code record `sdkErrorCodeState: missing`. Values
outside the public catalog record `redacted`; arbitrary `auth/...` strings are not
trusted merely because they resemble error identifiers. No message, stack, custom
payload, phone, OTP, or token is retained. This deliberately means an unknown future
backend identifier cannot be reconstructed from telemetry until independently checked
and added to the diagnostic catalog. The previous incident's discarded code cannot be
recovered by this change. It improves future diagnosis, not historical evidence.

Source changes: `firebaseSdkErrorCodes.js` (new), `firebaseDiagnostics.js`, and
`diagnostics.js`. Existing fallback/send/completion services, UI components, dependencies,
environment files and `.gitignore` are unchanged. Regression coverage includes the
adapter, client transport, API projection, log sink, saved challenges, standalone and
replica-set MongoDB, and desktop/mobile login and booking forms. No real SMS or
appointments are used. Read-only review found no actionable issue.

Verification for this follow-up: the unchanged baseline passed 1,500 tests. The first
regression run failed 124 new assertions for the missing diagnostic fields; after the
fix the focused five-file run passed all 394 tests. The full suite then passed 1,627
tests in 38 files (29.34s). Focused lint and the Next.js production build/type-check
stage passed, including all 56 static pages, with a synthetic loopback Mongo URI.
The final Playwright harness passed all 146 desktop/mobile tests, zero retries (2.8m),
including eight new cases for diagnostic-only identifiers and payload redaction.
External providers/API writes were mocked; this does not prove real iPhone or SMS
delivery. Production was not changed, and the original checkout remains clean.

## Explicit Code 39 Fallback Exception (2026-09-16)

The owner explicitly approved Twilio fallback for the observed backend response
`503 / Error code: 39`, which the installed Firebase SDK normalizes to
`auth/error-code:-39`. This is a business-policy exception, not a claim that code 39
always means an outage rather than an anti-abuse, carrier, quota, or other restriction.

The shared policy allows only the exact identifier, at stage `send`, with provenance
`firebase_sdk`, after the SDK promise rejects. Setup, confirmation, token retrieval,
pending operations, lookalike codes and arbitrary HTTP 503s do not gain permission.
Other quota, throttle, security and configuration decisions remain unchanged.
Diagnostics retain the exact identifier, category `provider_code_39`, and reason
`approved_code_39_send_rejection`, without messages, provider payloads or tokens.

The existing fallback is reused without changing the sender or verification services:
the settled Firebase verifier is cleared while the form container stays mounted;
the client drops Firebase confirmation/proof from the attempt; the server atomically
transfers the same challenge to Twilio; only Twilio verification can then complete it.
No new challenge is admitted for fallback, so its own phone cooldown is not charged
again. Source-send and global paid-SMS budgets still apply. Parallel fallback calls,
lost responses and persistence recovery retain one provider dispatch per reservation.
The old Firebase proof is rejected after transition, including when a code accompanies it.
Completion replay uses the same session/grant, without another external code check.

The report from the browser is still not trusted evidence of a provider outage: the
server enforces challenge/source binding, expiry, provider state and spending limits.
The outcome remains marked ambiguous. SoulClinic cannot retract an SMS already accepted
by Firebase or guarantee that cross-provider duplicate delivery is impossible. It can
and does enforce that only Twilio proof completes a transferred SoulClinic challenge.

Source changes: `firebaseSendPolicy.js`, `firebaseSdkErrorCodes.js`,
`firebaseDiagnostics.js`, `diagnostics.js`. Six focused test files plus the existing
Playwright login/booking matrix cover this exception. No dependency, environment,
storage, scheduling, session semantics or `.gitignore` changes were needed.

Verification: unchanged baseline `npm run test:run` had 1,626 passes and one existing
Admin module-load test exceed its 5-second timeout; an isolated rerun also exceeded
that timeout. Before the production edit, 14 new regressions failed for the missing
code-39 behavior. After implementation, all 494 focused tests passed. Full suite:
`npm run test:run -- --maxWorkers=2 --testTimeout=15000 --silent` passed all 1,651 tests
in 38 files (26.36s), including ephemeral standalone and replica-set MongoDB suites.
The longer timeout is test-run-only; neither test configuration nor runtime deadlines
were changed. Focused ESLint and Next.js build/type checks passed (56 static pages),
using a synthetic loopback Mongo URI and no environment files or real providers.
Playwright passed all 150 desktop/mobile Chromium tests with zero failures, retries,
or skips (163.27s), including code-39 fallback for both login and booking. Firebase,
Twilio and application writes were mocked; no real SMS or appointments were created.
This validates browser behavior, not real iPhone compatibility or carrier delivery.

Rollout is this Preview branch only. Do not merge to main or change Production.
Manual testing needs the current Preview hostname authorized in Firebase; no domain
or Firebase configuration is changed by this patch. A previously failed challenge
is not reopened: refresh and begin a new attempt after the normal cooldown.

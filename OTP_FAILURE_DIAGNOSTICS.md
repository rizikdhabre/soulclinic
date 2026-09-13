# OTP Failure Diagnostics

## Scope

Diagnostics-only changes on `codex/otp-failure-diagnostics`, based on main
`76ad12b30ed9d542f67e3d519c17857b8a6d127e`. No changes to fallback eligibility,
provider mode, SMS limits, cooldowns, session/booking verification, or Arabic UI.
No cloud configuration, environment files or `.gitignore` files are changed.

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

## Verification

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

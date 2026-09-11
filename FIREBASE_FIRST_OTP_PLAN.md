# Firebase-First OTP V2 Implementation Plan

> For agentic workers: use test-driven implementation with independent task reviews and a final whole-branch security review. The user's full specification in this task is the governing design.

**Goal:** Add a controlled Firebase-primary mode to the current durable Twilio verification flow without altering application identity, storage, or scheduling.

**Architecture:** Freeze `twilio_only` (default) or `firebase_first` on each server challenge. Firebase browser operations require a server send reservation; only a bounded stage-aware rejection report can atomically hand the same challenge to the existing Twilio send service. Server-verified Firebase phone evidence feeds the same persisted approval and deterministic application-completion paths.

**Tech stack:** Next.js 16.1.4, React 19.2.3, modular Firebase browser Auth, Firebase Admin Auth, existing Twilio Verify, MongoDB, Vitest, Playwright.

## Global Constraints

- Worktree: `C:/Users/rizik/Desktop/realProjects/soulclinic-firebase-first-otp-v2`; branch: `codex/firebase-first-otp-v2`.
- Baseline inspected at `214cfec9cc68ce76f006c0c48dc69b8880a9c1b9`; fresh baseline: 958 tests, 26 files, all passed with two workers.
- Never modify any `.gitignore` or overwrite `.env.local`. No changes to main, production settings, cloud resources, storage names, customer semantics, or scheduling.
- No real SMS, real appointments, fixed-code runtime bypass, or secret logging. Tests use injected providers and isolated MongoDB only.
- Preserve Twilio receipts, saved-send replay, approval persistence, deterministic sessions/grants, atomic/fenced writes, source/phone/global limits, and retention.
- Production default remains Twilio-only until explicitly enabled. Preview can enable Firebase-first. Real-provider testing and any Firebase domain modification require approval.

## Task 1: Browser Firebase Adapter and Central Send Policy

- [x] Write failing tests for lazy initialization, retryable failed initialization, stable DOM ownership, Strict Mode cleanup, one active send, bounded hanging state, stage-aware classification, confirmation/token retry caching, and sign-out.
- [x] Create `src/lib/otp/firebaseSendPolicy.js`, `src/lib/otp/firebaseClient.js` and focused tests. Use installed SDK public APIs and verify exact code strings from that SDK.
- [x] Interface: `createFirebasePhoneClient({ containerId, ...testDependencies })` returns `send(phone, { correlationId, onStage, isCurrentAttempt })`, `confirm(confirmation, code)`, `dispose()`. Export `clearFirebaseBrowserSession()`.
- [x] Errors carry a bounded `firebaseFailure` report `{ code, stage, provenance }`. Shared `classifyFirebaseSendFailure(report)` returns `{ eligible, ambiguous, reason }`; arbitrary code-less exceptions fail closed.
- [x] Review and run focused tests. No client persistence beyond memory; never settle a hanging provider send by launching Twilio in parallel.

## Task 2: Firebase Admin Evidence Boundary (Complete)

- [x] Write failing tests for signed token verification, project/phone/provider/auth_time binding, revoked/expired tokens, and certificate/network infrastructure failures.
- [x] Add `src/lib/otp/firebaseAdminAuth.js`, `src/lib/otp/firebaseEvidence.js`. Interface: `verifyFirebaseEvidence(idToken, challenge, { env, now, verifyIdToken })` returns bounded `{ uid, authTime }` after all checks; throws safe `OtpError`.
- [x] Reuse existing server credential variable names only for Admin Auth; leave `cloudStorage.js` unchanged. Retry failed lazy initialization promises.
- [x] Independent review found no concrete defects. 145/145 focused tests; 302/302 including storage/Twilio adapter checks. Real signature integration remains a separate check; provider calls were mocked.

## Task 3: Server Provider Ownership and Completion

- [x] Write failing service/route tests for policy freeze, Firebase send reservation, fallback allow/deny matrix, source binding, transition races, replay, and preserved Twilio-only mode.
- [x] Generalize `challengeStore` with explicit provider predicates while retaining Twilio defaults for old callers/documents. Add immutable `providerPolicy` and random Firebase send reservation ID.
- [x] Add `/api/otp/firebase-send` reservation/accepted/failure/status operations and `/api/otp/fallback`; accepted browser reports only record send state, never identity proof.
- [x] Reserve fallback atomically from Firebase sending state to Twilio prepared state, matching the reservation ID. Replay only the same fallback report/reservation. Reuse `requestTwilioSend`, including its existing source/global paid-send reservation and receipts; never recheck the attempt's phone cooldown.
- [x] Generalize completion and booking challenge linkage to approved Firebase/Twilio providers. Persist Firebase evidence approval before profile/session/grant work and recover server-observed approval with provider-bound encrypted receipts.
- [x] Add actual standalone/replica-set Mongo tests for racing fallback/completion, recovery, and 10 simultaneous + 10 sequential identities under unchanged limits.

## Task 4: Shared Client Flow, Arabic UI, and Logout

- [x] Write failing flow/controller tests. Extend shared Axios client with `firebaseSend` and `fallback`; preserve existing Twilio route contracts.
- [x] Firebase path: reserve, one SDK send, persist accepted state, retain ConfirmationResult. Eligible send rejection triggers Arabic fallback status and the same-challenge fallback API. Recovery replays saved operations, never resends SDK calls.
- [x] Retain confirmed user/ID token temporarily for bounded application-completion retries, without calling confirm twice. Wrong/expired codes remain Firebase; confirmation network/token failures never use send fallback.
- [x] Add distinct stable login/booking reCAPTCHA elements outside conditional content, attach adapter lifetime to shared hook, clear stale state on normalized-number changes, and ignore stale responses.
- [x] Keep finite cooldowns and distinguish recovery from explicit resend. Preserve server provider ownership. Clear Firebase in-memory Auth on customer logout without delaying/preventing application logout.

## Task 5: Integrated Verification and Preview Readiness

- [x] Add Playwright mocked-provider login/booking coverage at desktop/mobile, fallback, resend, hanging/late results, and no accidental appointment POST.
- [x] Run focused OTP, complete suite, ephemeral Mongo, browser tests, build, available type checks, focused lint, and dependency audit. Verify storage suites and Twilio-only rollback mode.
- [x] Full diff/security review; verify ignored tests are force-added, unchanged ignore/environment hashes, no secrets in tracked source or browser bundles.
- [x] Write `FIREBASE_FIRST_OTP_IMPLEMENTATION.md` with exact decisions, evidence, results, limits and outstanding approvals.
- [x] Commit only the isolated branch, create branch Preview, inspect exact hostname and Firebase Authorized Domains read-only. Stop before modifying domains or sending real SMS; report exact deployment readiness without assuming it.

## Execution Record

- Baseline: 958/958 passed, 26 files, 34.69 seconds, no code modifications before baseline.
- Ruling: default mode is `twilio_only` to keep rollout opt-in; Preview explicitly enables `firebase_first`.
- Ruling: complete explicit network/unknown Firebase send rejections may qualify, but a live/hanging request never launches parallel Twilio. Cross-provider duplicate delivery cannot be guaranteed absent for ambiguous rejected sends.
- Ruling: no migration of old Firebase implementation; implement new provider adapters around the current Twilio completion model.

- Final independent gates: Admin, browser/client, server recovery, and cross-module security reviews passed. Final result counts and Preview status are recorded in FIREBASE_FIRST_OTP_IMPLEMENTATION.md.

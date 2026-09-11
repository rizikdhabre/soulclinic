# Task5 Browser Verification Results

Final execution: 2026-09-11, started at 18:46:32.664 UTC (parent rerun after adapter review fixes).

```powershell
node tests/e2e/firebaseOtpV2/run.cjs
```

| Project | Viewport | Passed | Failed | Skipped |
| --- | --- | ---: | ---: | ---: |
| desktop Chromium | 1440 x 1000 | 49 | 0 | 0 |
| mobile Chromium | 390 x 844 | 49 | 0 | 0 |
| Total | | 98 | 0 | 0 |

Playwright duration: **165.908 seconds**. Retries: 0. Flaky tests: 0.
Reporter-level errors: 0. The final launcher exited with code 0.

Runtime: cached Playwright **1.62.1**, installed matching Chromium revision **1234**,
cached esbuild **0.27.0**, existing project React/PostCSS/Tailwind dependencies.
No dependency installation or package edits were needed. No bundled dependency loader
tool was exposed; `require.resolve` plus the existing npm cache supplied the runtime.

Focused ESLint on all nine config/code files passed with exit code 0, no output.
The final bundle's **12 production-module SHA-256 hashes** still matched the source files
after execution. See `artifacts/bundle-manifest.json` for those hashes.

## Local Evidence

- `artifacts/report.json`: authoritative test results, project counts and timing.
- `artifacts/bundle-manifest.json`: runtime versions, imported production modules and hashes.
- `artifacts/results/`: **20 full-page PNG screenshots** covering login/booking code,
  success, fallback, pending and layout states, in both viewports.
- Representative login and booking desktop/mobile screenshots were visually inspected;
  both viewport projects also assert horizontal containment and stable reCAPTCHA identity.

The isolated server used `127.0.0.1:30849` for the final run. The launcher stopped it after
the tests. No test process is intentionally left running.

## Execution History

1. Initial four-test attempt failed before UI execution because a cached prerelease
   Playwright expected an unavailable browser. The resolver now selects a runtime with
   an existing Chromium; no download was performed.
2. Four desktop smoke cases then passed: Firebase login/booking success and fallback.
3. First full matrix: 88 passed, 4 failed out of 92. The failures were two test defects
   repeated across viewports: a resend locator missed login's loading label, and a hover
   assertion targeted an intentionally pointer-disabled empty-code button. Only test
   locators/setup were corrected; no production code was edited to make tests pass.
4. Added proof lifetime and static-server safety coverage. Targeted checks: 14/14 passed.
5. Final expanded matrix: **98/98 passed**, as recorded above.
6. Parent rerun after confirmation-retention/diagnostics review fixes: **98/98 passed**,
   165.908 seconds. Representative mobile fallback and desktop code-entry screenshots
   were also inspected by the parent. Later server-only receipt fixes do not alter the
   component bundle tested here.

## Boundaries And Parent Handoff

This is a **real-component React browser integration harness**, not a full Next.js server
or real-provider end-to-end test. It runs the current Firebase adapter and shared client
flow unchanged, with SDK imports replaced only during the test build. Twilio/OTP HTTP
responses are per-test mocks, and booking submission is an in-memory callback.

No Firebase/Twilio service was contacted. No SMS, appointment, customer record, database,
cloud setting, production runtime bypass, package/environment edit, commit or push was
performed by Task5. Database isolation is achieved by having **no backend/database** in
this harness. Backend authorization, persistence/atomicity and Next hydration remain the
parent's separate verification scope. See `README.md` for detailed limitations.

Galileo's completed string-returning `confirm` / `clearConfirmation` contract was used
directly. The temporary mismatch observed during concurrent edits was resolved by the
frontend owner before the passing smoke run; Task5 made no production changes.

Task5 source ownership is only `tests/e2e/firebaseOtpV2/**` plus
`playwright.otp.config.cjs`. The existing ignore rules hide the tests directory. If the
parent later stages this work, force-add the sidecar source/docs explicitly, **not**
`artifacts/`. No `.gitignore` change is needed or made.

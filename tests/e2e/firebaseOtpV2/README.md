# Firebase OTP V2 Browser Sidecar

From the worktree root:

```powershell
node tests/e2e/firebaseOtpV2/run.cjs
node tests/e2e/firebaseOtpV2/run.cjs --project=mobile
node tests/e2e/firebaseOtpV2/run.cjs --grep 'cached proof'
```

No `npm install`, package changes, or production/environment configuration is required.
The launcher discovers existing `playwright` and `esbuild` through `require.resolve`,
then the local npm execution cache. It skips cached Playwright runtimes without an
installed Chromium. An existing alternate runtime can be selected using
`OTP_TEST_RUNTIME_ROOT` (a directory containing `node_modules`). There is no download
fallback. On a clean machine without these tools, the parent must provide a runtime or
approve the minimal development dependencies `@playwright/test` and `esbuild`, plus an
installed matching Chromium. Do not run overlapping installs in this worktree.

## Scope And Limitations

This is Playwright browser integration testing through a **test-only React harness**,
not a full Next.js end-to-end server test. It imports the current production
`LoginPage`, `AppointmentForm`, `AppointmentsClient`, the calendar/time picker, `usePhoneOtp`, OTP client flow, Firebase adapter,
failure policy, phone normalization, booking flow, React 19, and component styles.
React StrictMode is enabled. The test bundle intercepts `firebase/app`, `firebase/auth`,
and `next/navigation` before bundling. No production test flag or fixed-code bypass exists.
The only accepted synthetic code belongs to the test SDK mock and test HTTP handlers.

The actual Firebase adapter executes its initialization, verifier ownership, SDK-send,
confirmation/token caching, cleanup, and error-classification logic. Axios uses actual
browser HTTP requests intercepted by Playwright; API response state is isolated per test.
Fallback/Twilio responses are entirely synthetic. This does not verify server authorization,
Mongo atomicity, Firebase Admin evidence checks, actual provider delivery, or Next hydration.
Those require the parent's isolated backend tests. No database is involved here at all.

The harness uses the application's Tailwind configuration and global CSS, excluding only
the external Google Fonts import. Isolated form routes supply a 448px responsive wrapper
and synthetic booking date/time. `/appointments` mounts the real booking page, calendar,
time picker and form with synthetic treatment parameters. It does not mount the global
navigation or Next page shell. Overflow evidence applies to the mounted components.
Form-only booking submissions are recorded in memory. Full-page tests explicitly opt in
to intercepted appointment reads/writes, including simulated conflicts; requests never
reach an application server. Successful UI rendering does not prove appointment persistence.
Login navigation is recorded, not a real cookie/session login. Shop redirects go to an
intercepted static test document, never to the external site's network.

Foreground restoration is modeled with Playwright's clock plus `visibilitychange`; it is
not a mobile operating-system suspension test. Two pending-phone input tests use forced
DOM input to exercise stale lifecycle events. The sending card is inline, not an overlay
covering reCAPTCHA. Double-click stress dispatches
two native button clicks in the same browser task to expose pre-render lock races.

## Safety Boundaries

- The launcher strips inherited environment variables except a narrow OS/runtime allowlist.
  It never reads `.env`, `.env.local`, server credentials, or any database configuration.
- The random-port HTTP server binds only `127.0.0.1` and serves in-memory static assets.
  Every non-GET request is rejected. No Next server, API route, SDK service, or database starts.
- Server outbound sockets/TLS/fetch throw. The bundler rejects server-only/provider imports
  and verifies no Firebase, Twilio, Mongo, or application API module entered the bundle.
- Firebase public configuration is literal synthetic data in this test bundle only.
- Browser routing allows only this harness origin, known static assets, five explicitly
  mocked OTP endpoints, opt-in intercepted appointment API requests and the exact intercepted
  shop navigation. Everything else aborts and fails test teardown. CSP forbids external frames, scripts and connections;
  service workers are blocked. Never pass an existing production/preview URL to this suite.
- Every test starts a fresh browser context and in-memory API/SDK state. No persistent
  provider session, real SMS, customer record, booking, or cloud operation is created.

## Coverage And Evidence

Both 1440x1000 desktop and 390x844 mobile Chromium run the same login/booking matrix:
Firebase success; technical/reCAPTCHA fallback; wrong/expired codes; quota fail-closed;
completion receipts and cached proof; token-fetch retry; bounded completion attempts;
accepted-send and fallback recovery; changed/equivalent phones; stale challenge results;
absolute resend deadlines; foreground refresh; double-click races; hanging/late SDK calls;
unmount during send/verification; distinct stable reCAPTCHA containers; form overflow;
Twilio-only rollback; and booking incomplete-profile details.

`bookingExperience.spec.cjs` additionally covers progressive calendar/time/phone reveal,
smooth scrolling, stable reCAPTCHA roots, sending/fallback status cards, focus on accepted
send and resend, booking success animation/redirect, no redirect on failure or incomplete
profile, unmount cleanup, conflict/grant recovery, reduced motion, 320px layout and animated
calendar overflow. Chromium mobile emulation does not prove iOS software-keyboard behavior;
manual iPhone testing is still needed for that browser-specific interaction.

The authoritative output is `artifacts/report.json`. Full-page screenshots for code,
success, fallback, pending, and layout states are under `artifacts/results/`; failures also
retain Playwright traces and error screenshots. `artifacts/bundle-manifest.json` records
runtime versions and SHA-256 hashes of the exact production module text given to esbuild.
Artifacts are local and may include only synthetic test phones/tokens. Do not add generated
artifacts to a commit. This task does not commit or alter `.gitignore`.

Playwright clock and request routing follow the official references:
[Clock](https://playwright.dev/docs/clock), [Network](https://playwright.dev/docs/network).
See `CONTRACTS.md` for frontend coordination notes and `RESULTS.md` for recorded execution.

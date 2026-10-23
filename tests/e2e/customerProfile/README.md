# Customer profile browser checks

Run from the project root:

```powershell
node tests/e2e/customerProfile/run.cjs
```

The harness bundles the real `UsersTable`, `CustomerProfileClient`, `TreatmentPlanBuilder`, `FeedbackDialog`, and public `FeedbackClient` with the application's Tailwind/CSS. It reuses the existing OTP harness runtime discovery for cached Playwright and esbuild; it installs nothing and does not read application environment files.

All API responses are synthetic and intercepted in the browser. The static loopback server rejects API calls and forbids outbound networking. There is no Next server, database, Firebase, Twilio, or real message delivery. Only the Next link wrapper is replaced by a plain anchor.

The desktop (1440px), tablet (820px), and mobile (390px) cases cover customer links and preserved name editing, latest-first history and read-only attendance, plain-text feedback and dialog keyboard focus/scroll/close behavior, service snapshots, local duration overlap, server conflict identification, stable request IDs after uncertain outcomes, saved bookings surviving refresh/notification failures, Israel-local future choices, definite service unavailability, and public feedback submission/unavailable-link states.

Screenshots for the customer profile and long feedback dialog are saved in each history test's directory under `artifacts/results`. Failed tests additionally retain screenshots and traces. These browser checks validate client behavior against the documented API contracts; the separate Vitest/integration suites validate authorization, transactions, token handling, and delivery claims.

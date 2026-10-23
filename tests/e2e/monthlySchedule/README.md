# Monthly schedule browser checks

Run from the project root:

```text
node tests/e2e/monthlySchedule/run.cjs
```

The runner starts a temporary loopback server, bundles the real planner, manual booking and daily calendar components, and runs cached Playwright on desktop, tablet and phone viewports. Runtime discovery and environment isolation are shared with `../firebaseOtpV2/runtime.cjs`; it does not install packages or launch Next.js.

API responses are mocked in the browser. The server denies outgoing network and server-only provider/database imports, and the browser uses a restrictive content security policy. No production environment, database or messaging provider is used. These tests cover the UI contract; real database concurrency is covered separately by `tests/monthlySchedule/service.test.js`.

- `planner.spec.cjs`: persisted month state, weekday groups, edited/blocked starts, closure, preview/exclusions, booking conflicts, stable viewport, stale changes, duplicate clicks, uncertain saves/authentication loss, validation and mobile overflow.
- `bookingRefresh.spec.cjs`: selected-day availability refresh and selected-time reset after a confirmed schedule change event.
- `calendarRefresh.spec.cjs`: lower calendar selects an affected date and shows saved times/blocks; old date responses cannot overwrite the refreshed day. Combined planner/calendar checks preserve the viewport on success and booking conflicts, including delayed calendar responses.
- Generated screenshots/traces stay in ignored `artifacts/`; do not stage that directory.

Feature behavior and setup are explained in [MONTHLY_SCHEDULE_PLANNER.md](../../../MONTHLY_SCHEDULE_PLANNER.md).

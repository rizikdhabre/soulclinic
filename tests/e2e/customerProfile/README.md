# Customer profile browser checks

Run from the project root:

```powershell
node tests/e2e/customerProfile/run.cjs
```

The harness bundles the real `UsersTable`, `CustomerProfileClient`, `TreatmentPlanBuilder`, `TreatmentPlanComments`, `FeedbackDialog`, and public `FeedbackClient` with the application's Tailwind/CSS. It reuses the existing OTP harness runtime discovery for cached Playwright and esbuild; it installs nothing and does not read application environment files.

All API responses are synthetic and intercepted in the browser. The static loopback server rejects API calls and forbids outbound networking. There is no Next server, database, Firebase, Twilio, or real message delivery. Only the Next link wrapper is replaced by a plain anchor.

The desktop (1440px), tablet (820px), and mobile (390px) cases cover:

- Customer links and preserved name editing, plus profile call/WhatsApp anchor destinations for local and E164 phone numbers. The tests inspect destinations without opening either contact link.
- One latest-first list of all appointments, including upcoming, attended, missed, canceled, and unverified entries, with read-only statuses and no duplicate upcoming section.
- Client-side appointment pages of 5 (default), 10, or 15 rows, matching desktop/mobile slices, previous/next bounds, page-size reset, and page clamping after the list shrinks.
- Independent accessible collapse controls for appointments and saved programs, preserving their page state while collapsed.
- Separate booking-note and treatment-feedback columns on desktop and explicitly labeled mobile cards. Both long-text dialogs preserve plain text, contain scrolling, trap and restore focus, and close through Escape, the backdrop, or the close button.
- Saved programs with per-session treatment/date/time/price/current status, cancellation counts, and distinct upcoming, in-progress, completed, canceled, ended-with-missed-treatment, and unverified states.
- Cursor-based program pagination from three to six to seven cards, with no eager page fetch, a disabled loading button, duplicate-click prevention, failure/retry preserving the cursor, overlapping-page deduplication, and reset to the newest three after saving while ignoring an older in-flight page response.
- Deletion available only for fully canceled programs, explicit Arabic confirmation with Cancel/close/Escape/backdrop, one DELETE despite rapid confirmation clicks, 409 and generic error recovery, immediate removal of confirmed-deleted program/appointment rows, successful deletion surviving a refresh failure, cursor invalidation until refresh, and ignored pre-deletion page responses.
- A failed DELETE preserves an already-running successful-save refresh, so the new program appears without repeating the booking request.
- Private program comments support multiple entries, icon edit/delete/save/cancel actions, revision-based conflict refresh, preserved drafts after errors, a stable UUID when retrying uncertain additions, duplicate-click prevention, and protection against stale profile projections. Long untrusted text stays literal and wraps on desktop and mobile.
- Comment sessions survive temporary removal of older cards when a profile refresh returns only the newest three programs, including pending request outcomes, draft edits, and uncertain add identities. Existing uncertain additions remain retryable at the comment cap; reused UUID conflicts require a manual refresh before a deliberate new addition.
- The independently collapsible builder retains both draft fields and a successful receipt without resubmitting a booking. The mobile customer-list link leaves space for the floating sidebar control.
- Provider acceptance displayed as a message request with delivery unconfirmed, both after saving and in saved programs.
- Service snapshots, local duration overlap, server conflict identification, stable request IDs after uncertain outcomes, saved bookings surviving refresh/notification failures, Israel-local future choices, definite service unavailability, and public feedback submission/unavailable-link states.

The synthetic profile response contains every appointment plus the newest three plans and `plansPagination`. Subsequent GET requests to the treatment-plans endpoint return pages of at most three with an opaque cursor; POST requests retain the booking contract. Comment responses contain the complete confirmed comment list plus a monotonic `commentsVersion`; each comment carries its own `revision` for PATCH/DELETE.

Screenshots for the customer profile, appointment pagination, saved programs, completed program pagination, delete confirmation, long booking-note dialog, and long treatment-feedback dialog are saved in their corresponding test directories under `artifacts/results`. Failed tests additionally retain screenshots and traces. These browser checks validate client behavior against synthetic examples of the API contracts; the separate Vitest/integration suites validate authorization, deletion eligibility, current-versus-snapshot reconciliation, pagination order/ownership, transactions, token handling, and delivery claims.

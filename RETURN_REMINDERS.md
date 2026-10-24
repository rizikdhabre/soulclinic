# Default and custom return reminders

Return reminders preserve the project's JavaScript/JSX, Next.js, React, Tailwind, MongoDB and Twilio stack. Template approval, environment values, cron-job.org settings and the Twilio webhook are manual setup steps for the owner. The sending job still requires `RETURN_REMINDERS_ENABLED=true` and complete configuration.

Customer profiles, treatment plans, appointment feedback, and their templates are already explained in [TREATMENT_PLANS_AND_FEEDBACK.md](TREATMENT_PLANS_AND_FEEDBACK.md). The baseline architecture and language/framework preservation rule are in [project overview.md](project%20overview.md).

## When a return reminder is due

All of these conditions must hold:

1. The effective return-reminder preference is enabled. Existing and future customers with no stored preference are enabled by default, as requested by the owner after confirming customer agreement. The one-time renewed-consent policy below also includes recognized earlier opt-outs; subsequent opt-outs remain disabled.
2. There is a valid past appointment marked `attended: true`.
3. The active schedule's inactivity interval has passed since the latest attended appointment, using `Asia/Jerusalem` date and time. The default is **three calendar months**. A custom schedule uses the chosen number of days or calendar months. Month-end anniversaries clamp to the last day of the target month: November 30 plus three months is February 28 (29 in a leap year).
4. There is no current or future appointment. This includes individual bookings and all treatment-plan appointments. The job checks both customer histories and the day schedule, including records associated with the same normalized phone.
5. The repeat interval has passed since the previous attempt: **30 elapsed days** by default, or the same chosen custom interval. Custom days and months retain clinic wall time across daylight-saving changes; repeated autumn times use the later occurrence and nonexistent spring times move forward across the gap. There is no maximum reminder count; reminders continue while the customer remains eligible and subscribed.

Malformed attended-treatment dates/times or uncertain future scheduling data cause the customer to be skipped rather than authorizing a reminder from incomplete history.

A future booking pauses sending. Attending a treatment restarts the active schedule's inactivity interval because the latest attended appointment changes. Canceling a future booking removes the pause but does not reset attendance or the repeat cooldown. A no-show does not reset the attendance clock. Customers who have never attended are excluded. **A custom schedule replaces the default; the customer never receives both streams.**

Only this new return-reminder feature reads the preference. Existing booking confirmations, booked-appointment reminders and weekly feedback remain governed by their existing logic.

## Permission and unsubscribe

`ReturnReminderPreference.jsx` is shown on `/admin/users/[userId]`. Its separate admin API is `/api/admin/users/[userId]/return-reminders`:

- `GET` returns the effective `{enabled, schedule, scheduleRevision}` after admin authentication and customer lookup. The UI describes the enabled state without claiming a new individual consent record was written.
- `PATCH` accepts `{enabled: boolean}`. Enabling additionally requires `{consentConfirmed: true}` to record that the customer agreed. The server obtains the phone from the customer record, never from request input.
- New opt-outs take effect immediately. Re-enabling a subsequent opt-out requires a fresh explicit admin action and does not clear send history or the cooldown.

## Schedule controls and private admin comments

The same profile section shows mutually exclusive clickable **جدول مخصص** and **الجدول الافتراضي** labels. Loading a customer selects the saved mode; a missing setting selects default. Custom mode has one positive integer input and a **يوم / شهر** dropdown (API units `days` / `months`, maximum 3,650 days or 120 months). Saving a custom rule replaces the active default rule. Clicking the default label saves `{mode:"default"}` immediately, with no second save click. A failed save is shown as an error rather than a successful switch.

Schedule-only `PATCH` accepts `{schedule, scheduleRevision}`. A custom schedule is `{mode:"custom",value,unit}`. The revision prevents an older admin screen from overwriting a newer choice; conflicts return 409. Consent and schedule writes are deliberately separate requests. Restoring default restores its timing rules, not an empty send history, and never enables an opted-out phone. Completed previous attempts are evaluated using the current schedule, so a shorter interval can become due on the next daily run and a longer interval postpones sending. An unresolved previous send retains its existing reservation; a schedule change cannot release an uncertain provider request early.

The details row uses the separately authenticated, read-only `/api/admin/users/[userId]/return-reminders/status` endpoint. It displays the latest attended session, latest reminder attempt (not proof of delivery), and the next estimated 19:00 processing opportunity under the saved rule. Upcoming appointments, unsubscribes, no attendance or uncertain data replace the estimate with an appropriate status. All normalized-phone profiles and calendar bookings are considered. The estimate is refreshed after schedule/consent saves; loading or failure of this read does not prevent editing settings/comments. Eligibility is checked again by the actual daily job.

Under the controls, **تعليقات الإدارة** supports multiple private comments, **إضافة تعليق**, and accessible pencil/trash controls for editing/deleting. Schedule changes and stopping reminders preserve comments. Comments share the normalized phone's configuration, so duplicate profiles for the same number share the schedule and notes. Changing a customer's phone does not copy notes to the new number. Comments are never put in WhatsApp messages, customer endpoints or unsubscribe responses.

Admin-only endpoints under `/api/admin/users/[userId]/return-reminders/comments` support `GET`/`POST`; `/comments/[commentId]` supports `PATCH`/`DELETE`. They resolve phone from the customer, use private/no-store responses, and retain UUID add idempotency, per-comment revisions and deletion tombstones. Limits match the existing plan comments: 100 active comments and 10,000 characters per comment. No consent or send-state fields are written by comment operations.

Permission is shared by normalized phone, so duplicate customer records and local/international phone formatting share the same choice. A missing preference is effectively enabled for both existing and newly created customers. Reading it or sending a reminder does not insert a preference or fabricate individual consent/source timestamps; customer creation and booking flows need no additional writes.

The owner reconfirmed agreement for earlier opt-outs at **2026-10-23T15:27:08.000Z**. This is a one-time effective-policy change, not a bulk database migration:

- An existing `enabled: false` record is treated as enabled only when its source is `admin`, `unsubscribe_link`, or `whatsapp`, it has no `policyRevision` field, and its available `updatedAt`/`disabledAt` values are valid dates whose latest is at or before that cutoff.
- Missing/malformed audit data, unknown sources/revisions, malformed `enabled` values, and opt-outs newer than the cutoff remain disabled.
- Every new explicit choice stores `policyRevision: "owner-reconfirmed-2026-10-23"`. A new admin disable, unsubscribe POST, or WhatsApp STOP therefore stays disabled, even if its supplied clock is earlier than the cutoff. Re-enabling it still requires the explicit admin consent confirmation.
- Existing preference history, send claims/cooldowns, and processed inbound message IDs are preserved. Replaying an already-processed old STOP does not undo renewed agreement; a new STOP works normally. No live preference migration is part of this code change.

The shared effective-policy function is used by the admin/public preference reads, inbound replay status, and both sender permission checks. The stored historical value alone is not the effective setting for a recognized pre-cutoff opt-out.

Each reminder includes an **إيقاف التذكيرات** URL button opening the opaque private URL `/reminders/unsubscribe/[token]`. WhatsApp displays the button below the entire message instead of displaying the long URL. It opens an Arabic confirmation page with no name, phone, or treatment details. Merely opening the page or previewing the link makes no change. The confirmation button POSTs to `/api/reminders/unsubscribe/[token]` and saves the opt-out. Repeated confirmation is safe. Invalid links receive a generic response. Tokens are random 32-byte values; only SHA-256 hashes are stored. Old unsubscribe links remain valid rather than expiring and preventing someone from opting out.

Replying `إيقاف` or `ايقاف` (including diacritics), `STOP`, or `UNSUBSCRIBE` to the configured WhatsApp number disables the same preference. The existing `/api/whatsapp/inbound` handler verifies Twilio's signature, sender channel and recipient before changing data. It returns an Arabic confirmation after storage succeeds. Ordinary valid messages keep the existing clinic contact response. `START` does not silently restore permission.

The inbound handler validates against `TWILIO_INBOUND_WEBHOOK_URL`, the **exact public URL configured in Twilio**, including any query string. It does not trust forwarded host headers to choose a signing URL. All form fields participate in SDK signature validation. See [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

If Twilio Advanced Opt-Out sends `OptOutType=STOP`, the app saves the opt-out but leaves the TwiML reply empty because Twilio has already replied. Provider-level opt-out may independently block other message categories; the app cannot override that provider behavior. The owner's renewed-consent policy does not remove a Twilio provider-level block. See [Twilio Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

## Dispatch and duplicate prevention

The dedicated `GET /api/appointments/cron/return-reminders` endpoint handles both default and custom schedules. Configure its external cron **once per day at 19:00 in `Asia/Jerusalem`**. The existing `/api/appointments/cron/reminder` endpoint keeps appointment reminders and feedback only; it no longer calls or scans return reminders. Keep its existing 10-minute schedule.

There is no per-customer timer or new queue service. The daily endpoint always requires a configured `CRON_SECRET` and the matching `x-cron-secret` header. `?dryRun=1` performs eligibility checks without messages, claims, indexes, job progress or preference changes. The `testTime` query never advances this job's actual clock. The endpoint remains manually callable by an authorized operator; the external scheduler, not an HTTP time gate, sets the daily send time. A customer who becomes due after 19:00 is normally considered the following evening.

Keep cron-job.org's timeout at **30 seconds**. Both live and dry-run requests register the existing worker through Next.js `after()` and immediately return HTTP **202**, with `{accepted:true,executionId,returnReminders:{status:"accepted",dryRun}}`. There is no customer scan or provider send to await before returning. This acknowledges the trigger, not completion or delivery. Next.js/Vercel supports processing after the response, up to the function's configured duration; this is not a durable queue or automatic retry service. See [Next.js after](https://nextjs.org/docs/app/api-reference/functions/after).

To inspect an execution, copy its `executionId` from the cron response and search the deployed project's **Vercel runtime logs**. The `return-reminders` log starts with `event:"started"`, followed by `event:"finished"` and aggregate status/counts, or `event:"failed"` with the generic code `RETURN_REMINDERS_FAILED`. No customer details, tokens or raw provider errors are included. A failure to register background work returns HTTP500 before acceptance; an error after acceptance appears only in Vercel logs. If there is no final event, check for a Vercel timeout or interrupted invocation. A successful scheduler request alone does not establish that the background job finished.

The service uses a durable atomic claim keyed by normalized phone. Simultaneous requests and repeated runs cannot independently claim that phone during the cooldown. Claims compare the previously observed state atomically. It checks live attendance, scheduling, rule revision and permission again before dispatch. Claim and status writes use majority write concern and work without MongoDB transactions. Attempt history snapshots the rule/revision used. A delayed result remains attached to its attempt; current-rule eligibility is calculated from its completed timestamp instead of blindly retaining an obsolete 30-day deadline.

Candidate discovery streams customer records, normalizes and deduplicates their phone numbers, and checks effective permission. It does not depend on a pre-existing preference row. The daily job drains multiple batches (50 provider dispatches or 500 scanned records per batch), so 50 is not a daily limit. A durable five-minute job lease avoids simultaneous full scans. The endpoint requests a 300-second runtime and stops starting more work after a 240-second budget; the deployment must support that duration. Progress is checkpointed after each batch. Interrupted work is retried from the saved cursor, while phone claims prevent duplicate sends. Resuming a partial tail also checks earlier customers that may now be due.

`status:"partial", continuationPending:true` in the final runtime log means work remains; it is not a completed daily scan. An authorized repeat call continues it, or the next day's scheduled call resumes it. Large queues or slow providers may therefore need a manual continuation. A request already in flight can run beyond the soft time budget; a platform timeout may lose that batch's cursor but not its durable phone claims. Dry runs use no persisted cursor and log partial if they reach the budget.

An accepted Twilio SID means Twilio accepted the message, not that it reached the customer's handset. An explicit provider rejection is recorded as failed; network errors and ambiguous results are recorded as unknown. A durable claim survives either outcome and status-write errors. The system does not blindly retry an uncertain send. This deliberately favors avoiding repeated messages over retrying every failed attempt.

MongoDB and Twilio do not share a transaction. A booking or opt-out after the final eligibility read cannot retract a provider request already in flight. Existing booking writers are not redesigned by this feature. A crash after claiming can leave a missed reminder for that cooldown period; it must not produce an immediate duplicate.

## Collections

| Collection | Purpose |
| --- | --- |
| `returnReminderPreferences` | `_id` is the normalized phone; `enabled`, source, audit timestamps and new-choice `policyRevision` store explicit choices. Missing records use the default policy; recognized legacy records use the one-time renewal rule above. Processed inbound message IDs prevent a retried old STOP from undoing renewed consent or a later deliberate re-enable. |
| `returnReminderSettings` | Phone-keyed schedule/revision with separate audit fields, private admin comments, comment revisions and deletion tombstones. Missing schedule means default. It never controls consent. |
| `returnReminderState` | Phone-keyed atomic claim identity and `nextAttemptAt` reservation. Completed-attempt repeat eligibility uses current settings and the history anchor; unresolved attempts keep this reservation. |
| `returnReminderHistory` | One record per claimed attempt, with customer/phone identity, attendance and rule snapshots, hashed unsubscribe token, dispatch timestamps/status and accepted provider SID when available. |
| `returnReminderJobs` | Daily scan lease/owner and resumable cursor; no customer comments or raw unsubscribe tokens. |

There are no TTL indexes that would discard preference, cooldown, history, or old unsubscribe links. Raw tokens, provider errors and contact details must not be exposed in the new cron summaries. Private endpoints use no-store/no-referrer/noindex protections.

## Manual setup after code review

No environment files were read or changed for this implementation. These are the settings the owner will configure separately:

| Variable | Purpose |
| --- | --- |
| `RETURN_REMINDERS_ENABLED` | Exactly `true` enables the new job; omitted/false keeps it disabled. |
| `TWILIO_TEMPLATE_SOUL_RETURN` | Approved Content SID for the five-variable Call to action template below, e.g. `soul_return_reminder_custom_ar`. Replace the old four-variable Text template SID when deploying this mapping; its placeholders are incompatible. Do not embed credentials or a live SID in source code. |
| `RETURN_REMINDERS_PUBLIC_BASE_URL` | Explicit public HTTPS app origin, normally `https://soulclinc.net`, used for booking and private unsubscribe links. |
| `TWILIO_INBOUND_WEBHOOK_URL` | Exact public URL registered for inbound WhatsApp POSTs, normally `https://soulclinc.net/api/whatsapp/inbound`. |
| `CRON_SECRET` | Existing secret supplied as the cron's `x-cron-secret` header. |
| Existing Twilio account, auth token and WhatsApp sender variables | Reused by the sender and webhook validation. |

Keep `RETURN_REMINDERS_ENABLED` off until template, public links, webhook, customer permission and cron configuration have been reviewed and tested. The inbound route now needs its exact URL and existing auth/sender configuration to validate requests; configure these when deploying its change.

The five template variables are wired in code as follows:

| Variable | Value |
| --- | --- |
| `{{1}}` | Customer's name, normalized to a single line. |
| `{{2}}` | Saved inactivity interval in Arabic: default `3 شهور`; custom e.g. `شهرين` or `25 يوم`. |
| `{{3}}` | Latest attended appointment date, `YYYY-MM-DD`. |
| `{{4}}` | `${RETURN_REMINDERS_PUBLIC_BASE_URL}/dashboard`. |
| `{{5}}` | Opaque private unsubscribe token only, used as the button URL suffix. Never the complete URL. |

The owner explicitly chose the **configured interval**, not the actual elapsed age of the latest treatment. Default reminders therefore continue to display `3 شهور` on later monthly repeats. Singular/dual forms are `يوم واحد`/`يومين` and `شهر واحد`/`شهرين`; values3–10 use `أيام`/`شهور`, larger values use `يوم`/`شهر`. This display does not change eligibility, cooldowns or claims.

No new environment-variable names are needed. After deployment, add the separate daily cron URL `https://soulclinc.net/api/appointments/cron/return-reminders`, method GET, timezone `Asia/Jerusalem`, 19:00, timeout **30 seconds**, with the existing secret header. Leave the old appointment/feedback cron in place. Test the new endpoint with `?dryRun=1` first and inspect its final Vercel runtime log using the returned `executionId`. Remove the dry-run query for the actual daily job. This local implementation does not create or modify cron-job.org jobs.

Create an Arabic **Call to action** template, e.g. `soul_return_reminder_custom_ar`, and submit it in the **Marketing** category because it invites a new booking. Use this body for both schedules, preserving the owner's wording and emojis:

```text
مرحبا {{1}} 👋

مرّت {{2}} على آخر جلسة إلك بـ "SoulClinic" ({{3}}) ⌛️

التشنجات والتعب والاوجاع الي حاسس فيها من الشغل والروتين بدها جلسة قوية عشان تجدد طاقتك ! ⚡🔋

لا تأجّل دورك 💆‍♂️🍃
واختار الموعد اللي بريحك منهون⬇️:
{{4}}

لإيقاف رسائل التذكير✉️:

نتمنى لُك الصحة والعافية ✨🤲🏼
```

Add one URL button titled **إيقاف التذكيرات**, using **dynamic URL** `https://soulclinc.net/reminders/unsubscribe/{{5}}`. The template contains the fixed origin/path; the app supplies only the token. The fixed host must be the deployed unsubscribe application and match the intended `RETURN_REMINDERS_PUBLIC_BASE_URL`; changing that env value alone cannot change a URL embedded in an approved template. Do not insert `{{5}}` into the message body. Keep WhatsApp STOP handling enabled even though this copy advertises the button. See [Twilio Call to action](https://www.twilio.com/docs/content/twilio-call-to-action) and [template categories](https://www.twilio.com/docs/whatsapp/key-concepts).

Replace the SID with this newly approved template as part of deployment, before enabling sends. The earlier four-variable Text templates cannot be reused with this five-variable mapping. Existing issued links still work; no unsubscribe route or token format changed.

Approval status and live delivery are not established by the local tests. We will verify these with the owner during manual setup, using a designated test number and test appointments rather than contacting customers.

## Source and verification

Core eligibility/sending: `src/lib/returnReminders.js`, calendar arithmetic: `returnReminderSchedule.js`, daily batching: `returnReminderDailyJob.js`, read-only profile estimates: `returnReminderStatus.js`. Admin schedule/comments: `returnReminderSettings.js`, `returnReminderComments.js`, and their profile components/routes. Shared preferences and bearer authorization remain in `returnReminderPreferences.js`. Public page: `src/app/reminders/unsubscribe/[token]/`. HTTP handlers include the admin routes, existing inbound WhatsApp route and dedicated daily cron.

Backend tests are in `tests/returnReminders/` and use isolated loopback MongoDB and injected message senders. Browser tests are in `tests/e2e/returnReminders/`, with mocked APIs and external network access denied. They verify user interaction rather than real provider delivery.

Initial implementation verification on 2026-10-23, before the subsequent default-enabled/renewed-consent policy change:

| Check | Result |
| --- | --- |
| `npm run test:run -- --maxWorkers=1` | **53 files, 1,915 tests passed**, including actual generated-reminder links and signed WhatsApp opt-outs suppressing the next cycle. |
| Return reminder browser checks | **24 cases passed** across desktop, tablet and mobile: the initial 18-case run plus six additional loading/customer-navigation cases. Public and admin screenshots inspected. |
| Existing customer-profile browser regression | **30 cases passed**, including treatment plans, history and feedback. |
| ESLint on all 10 application files touched by this addition | Passed. |
| Independent review | No confirmed blocking correctness/security findings. |
| Isolated production build | `next build --webpack` passed with exit **0**, in a temporary copy using a sanitized environment, dummy credentials, unreachable loopback MongoDB and one worker. No repository build configuration changed. |
| `git diff --check` | Passed. |

The first full backend run had the existing `tests/otp/firebaseAdminRuntimeV2.test.js` Auth-loading case exceed its five-second timeout. The complete serialized retry passed all 1,915 tests without changing that test or Firebase code. The old profile browser fixture also needed the new preference API response; after updating that fixture, all 30 regression cases passed. A tool-session restart interrupted some initial validation runs, so their required checks were restarted and completed with exit status verification.

For the subsequent default-enabled/renewed-consent update, `npx vitest run tests/returnReminders --maxWorkers=1` passed **6 files and 130 tests**. These cover the renewal cutoff, untouched old audit records, new revision-marked opt-outs, old STOP replay, generated unsubscribe links, default-enabled existing/new customers, normalized duplicate phones, final-read opt-out races, and the 50-dispatch limit without starving later eligible customers. Independent review added a malformed-phone-object regression, which passed after guarding candidate types. The updated browser harness passed **24 cases** across desktop, tablet and mobile. Scoped ESLint and `git diff --check` passed.

The build reported the existing outdated Browserslist data warning. PowerShell initially treated redirected warning output as an error record despite completed compilation and route generation; a direct child-process rerun in the same isolated copy confirmed Next's actual exit code was 0. No dependency update was made.

The initial implementation verification did not use a live database or real WhatsApp delivery, or change environment/cron/provider configuration. The later default-enabled and renewed-consent work is also local: it changes effective policy without executing production database writes or sending messages.

### Custom schedule update verification — 2026-10-24

- The full serialized backend suite passed **68 files / 2,233 tests** before the final status and review corrections. Focused tests then covered those corrections, including **27 status tests** and sender deadline checks.
- The final reminder-suite run passed **246 tests**; one signed WhatsApp unsubscribe integration test exceeded its five-second timeout while the production build was running. Its isolated rerun passed **both workflow tests**, without changing timeouts or application behavior.
- The browser checks passed across desktop, tablet and mobile: **69 cases** in the status-enabled suite, followed by **18 focused status cases**, three navigation cases and six booking/status-refresh cases. The customer-profile desktop regression passed **46 cases**, with one intentional mobile-only skip. These are overlapping verification runs, not a count of unique tests. Screenshots were inspected for RTL layout and overflow.
- ESLint on changed application/test files and `git diff --check` passed. The final isolated production build passed with exit **0**, using dummy configuration, unreachable loopback MongoDB and no environment files. Only explanatory source comments changed after that build snapshot.
- Independent sender and settings/UI reviews closed all confirmed findings. Daily batching, rule changes, upcoming appointments, duplicate claims, private comment CRUD and both unsubscribe methods were covered with isolated databases, injected senders or mocked browser APIs.

This update remains local on `main`, with nothing staged, committed or pushed. No production database, real WhatsApp sends, environment settings or external cron jobs were changed. The owner still needs to configure the separate daily cron and the approved flexible template described above before using the custom schedules in production.

### Scheduler timeout correction — 2026-10-24

The owner's cron-job.org account caps requests at 30 seconds. The daily endpoint was changed to acknowledge requests before running the existing worker, using `after()` as described above. Regression tests first reproduced the blocked HTTP response, then passed with the deferred worker. All **253 return-reminder tests** passed, scoped ESLint and diff checks passed, and an isolated production build exited **0**. A real local Next production-server check returned HTTP202 and observed the callback finish for both normal and dry-run requests (64ms and 92ms including callback observation), with reminders disabled and only dummy credentials/unreachable loopback database configuration. This verifies local lifecycle behavior, not live Vercel delivery. Independent focused review found no confirmed issues. No scheduler settings, environment files, commits or pushes were changed.

### Configured interval and unsubscribe button — 2026-10-24

The owner chose the configured default/custom interval and an **إيقاف التذكيرات** URL button. The sender now emits the five-variable contract documented above. Regression tests first failed against the earlier four-variable mapping, then **all 264 return-reminder tests passed**, including configured Arabic labels, repeated default reminders, token-only button construction, token hashing/privacy, link-preview safety and both opt-out methods. Scoped ESLint and diff checks passed; independent review found no confirmed issues. This update changes only sender formatting, its tests and this guide; no new dependencies, route changes, live messages, template submissions, environment edits, commits or pushes were made. The last isolated production build above preceded this small sender-formatting update.

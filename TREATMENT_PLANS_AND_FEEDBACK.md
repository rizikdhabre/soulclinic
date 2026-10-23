# Customer profiles, treatment plans and private feedback

Originally implemented on `codex/customer-treatment-plans-feedback`, then merged into `main` by the owner. The appointment-details follow-up is local on `main`. The feature uses the existing JavaScript/JSX, Next.js, React, Tailwind, MongoDB and Twilio stack; no language, framework or dependency migration is part of this feature. Deployment, Twilio approval and production configuration remain the owner's decision.

For the rest of the application's architecture, existing single-booking/cancellation/blocking rules, dashboard and user-table meanings, read [project overview.md](project%20overview.md). This document describes only the new feature.

## Customer profile

Both desktop and mobile customer-name links on `/admin/users` open `/admin/users/[userId]`. Existing name-edit controls still edit names. The profile shows the customer's name and phone, **جميع المواعيد**, a treatment-plan builder titled **برنامج علاجي**, and saved programs with their session details and current status. The existing `loading.jsx` component remains the profile loader.

The profile header also has **اتصال** (`tel:`) and **واتساب** contact links, matching the existing appointment-list controls. WhatsApp uses the shared `getWhatsAppLink` phone helper. These links open the phone/chat app; rendering the profile does not send a message.

On phones, the **قائمة الزبائن** back link is inset farther from the right edge so its arrow has room beside the floating admin control. The **برنامج علاجي** builder also has its own accessible open/close arrow, initially open. Collapsing hides the content while preserving entered appointments and any saved receipt.

All available appointments appear together, newest first: current customer history plus canceled sessions recoverable from this customer's saved program snapshots, deduplicated by appointment ID. Current history supplies the latest date/time, treatment, price and attendance after edits. Time comparisons use `Asia/Jerusalem`. States are **قادم**, **حضر**, **لم يحضر**, **ملغى**, or **بحاجة للتحقق**. Future appointments are never labeled missed. Attendance remains read-only; existing controls elsewhere mark attendance.

The appointment section defaults to **5 per page**, with **5 / 10 / 15** options and previous/next arrow buttons. Desktop rows and mobile cards use the same page. Changing page size returns to page one; deleting data clamps an invalid page to the new last page. The total count remains the count of all appointments. Both appointment and saved-program sections have independent, accessible expand/collapse controls; collapsing preserves the current paging state.

The separate **ملاحظة الحجز** and **تقييم العلاج** columns show the original booking note and later treatment feedback. Both have previews and full-text dialogs on desktop and mobile. X, Escape or clicking the backdrop closes the dialog. It preserves line breaks, wraps long words, traps focus and returns focus to the opener. Both kinds of text are rendered as text, never HTML.

Booking notes come only from `usersData.notes[]`, matched by the current live standalone appointment's date/time. Program booking does not collect notes, so known program sessions never inherit legacy notes at a reused slot. Legacy notes have no appointment ID and existing rescheduling does not move them, so a note left at an old time cannot reliably be matched; the profile does not guess using original program times. Staff `adminNotes` are never included. Older standalone cancellations were deleted from history and cannot be reconstructed; canceled program sessions remain recoverable from their snapshots.

`GET /api/admin/users/[userId]` requires the existing admin JWT and returns a private/no-store response. It exposes only customer identity, appointment details, customer notes/feedback and limited program/notification status. It does not expose tokens, token hashes, provider identifiers or staff notes. Feedback is joined using both customer ID and appointment ID, for live history and recoverable program sessions. Calendar reads are scoped to appointment IDs in this customer's saved programs and project only dates, IDs and times.

Each saved program lists its sessions chronologically, showing treatment, current date/time, price and status, plus counts of attended, missed, upcoming, canceled and uncertain sessions. Its overall status is `upcoming` (**قادم**), `in_progress` (**جارٍ**) when past and future sessions coexist, `completed` (**مكتمل**) when every noncanceled session was attended, `canceled` (**ملغى**) when every session was canceled, or `ended` (**انتهى دون اكتمال العلاج**) when no future sessions remain but attendance is incomplete. Cancellation counts stay visible even when the remaining sessions are completed. Empty, malformed or inconsistent records produce `unknown` (**بحاجة للتحقق**).

Saved programs start with the latest **three**, ordered by creation date descending and ID descending for equal dates. **عرض المزيد** requests the next three and disappears when no older programs remain. Loading prevents duplicate requests; a failed request preserves the visible programs and can be retried. Saving a new program refreshes the list back to the newest three and invalidates an older in-flight page request.

The initial profile response includes `plansPagination: {hasMore, nextCursor}`. `GET /api/admin/users/[userId]/treatment-plans?cursor=...` requires the same admin authentication, returns `{plans, plansPagination}`, and uses `private, no-store`. Its cursor is the last returned program ID, resolved under the requested customer before querying older creation-date/ID pairs. The database query takes at most four records (three results plus a lookahead); inserting a newer program does not shift older pages. The initial profile still reads all owned snapshots to recover canceled rows in **جميع المواعيد**, so the complete appointment list is not truncated by program pagination. This pagination does not change the existing booking `POST` route.

A saved session is considered canceled only when its ID is absent from both live history and the calendar. Calendar-only records, conflicting times and future history without a calendar entry are uncertain, rather than falsely shown as canceled or complete. These are read-only projections; original program receipts and existing booking/cancellation writers are unchanged.

### Deleting a fully canceled program

A trash button appears only for a nonempty program whose sessions are all canceled. It opens an Arabic confirmation dialog. Closing/canceling does not write data. `DELETE /api/admin/users/[userId]/treatment-plans/[planId]` requires admin authentication and checks the program's owner and both live representations again. Any surviving appointment ID or `treatmentPlanId` reference (including inconsistent ownership), or malformed/empty snapshot, prevents deletion with 409.

One MongoDB transaction permanently deletes the `treatmentPlans` document and its customer's `appointmentFeedback` records for those appointment IDs. No ordinary appointment is canceled by this action. Unrelated bookings at reused dates/times are preserved. The recovered canceled rows disappear from the profile because their snapshot no longer exists. The client removes the confirmed-deleted program and its rows, then refreshes; a refresh failure keeps the confirmed deletion and offers refresh retry. Feedback jobs claiming a plan session also write the parent program in their claim transaction, so a concurrent deletion cannot leave newly recreated feedback records behind.

The `deletedTreatmentPlanRequests` collection retains only the original request UUID (`_id`), customer/program IDs, original creation timestamp and deletion timestamp. It contains no customer name, phone, schedule, appointment details, feedback, payload hash or provider information. This minimal marker prevents an old save request from recreating the deleted reservations, makes repeated deletion safe, and lets an older pagination cursor continue after another administrator deletes its anchor. Original save retries receive `TREATMENT_PLAN_DELETED` (410). Shared return-reminder history/state is independent and remains available for monthly deduplication and old unsubscribe links.

Deletion requires transaction support just like plan creation. Feedback/marker failures roll back the whole deletion; unsupported standalone MongoDB receives `TRANSACTIONS_REQUIRED` without data removal. Main files: `src/lib/treatmentPlanDeletion.js`, the `[planId]/route.js` DELETE handler, and the deleted-request checks in `src/lib/treatmentPlans.js`.

Main files:

- `src/app/admin/users/[userId]/page.js`
- `src/components/admin/CustomerProfileClient.jsx`, `TreatmentPlanBuilder.jsx`, `FeedbackDialog.jsx`
- `src/lib/adminCustomerProfile.js`, `clinicTime.js`
- `src/app/api/admin/users/[userId]/route.js`

### Private admin comments on saved programs

Every saved program has an **إضافة تعليق** control for multiple internal comments. Editing and deleting use pen/trash icon buttons with Arabic accessible labels and tooltips. Comments support line breaks and long plain text on desktop and phones; they are separate from booking notes and treatment feedback and are never included in customer messages.

Comments are embedded in `treatmentPlans.adminComments`, with a UUID, text, integer revision, and creation/update timestamps per comment. The parent `commentsVersion` starts at zero and increases after each mutation. Legacy programs without these fields display an empty comment list. Text is limited to 10,000 characters per comment, with up to 100 comments per program.

Admin-only routes under `/api/admin/users/[userId]/treatment-plans/[planId]/comments` expose GET and POST; nested `[commentId]` exposes PATCH and DELETE. Reads return `{comments, commentsVersion}`; successful writes additionally return `success: true`. Each operation checks both the customer and program IDs and uses private/no-store responses. POST accepts a stable UUID and text, while PATCH/DELETE require the displayed comment revision. A stale edit/delete returns 409 rather than overwriting a newer comment. The client preserves drafts on failure and can refresh comments after a conflict; older profile responses cannot overwrite a newer confirmed comment version. Per-program comment sessions live in the open profile, so a latest-three refresh can hide an older card without losing its draft, pending result or uncertain-add UUID. Sessions are discarded on confirmed program deletion or leaving that customer's profile; drafts are not persisted across page reloads/navigation.

Deleted comment UUIDs are retained in the same program's internal `deletedCommentIds` array without their text. An old add retry cannot restore a deleted comment or reset its revision; reuse returns `COMMENT_ID_REUSED` (409). These UUID markers are omitted from comment/profile responses.

Comments share the parent program's lifetime: deleting a fully canceled program deletes every embedded comment and deleted-comment UUID in the same transaction. A concurrent comment write cannot recreate a deleted parent because comment operations never upsert. The separate program-deletion retry marker contains no comments or comment UUIDs. Main files: `src/lib/treatmentPlanComments.js`, its admin routes, and `src/components/admin/TreatmentPlanComments.jsx`.

## Booking a treatment plan

An administrator selects a service, date and available time for each row, adds more rows, then saves once. A plan supports 1–10 appointments. Each appointment is an ordinary appointment afterward: existing calendars, attendance, reminders, rescheduling and cancellation continue to use their existing records and IDs.

`POST /api/admin/users/[userId]/treatment-plans` requires admin authentication. Its body is:

```json
{
  "requestId": "a-new-UUID-for-this-save",
  "appointments": [{
    "treatmentId": "catalog-treatment-object-id",
    "serviceIndex": 0,
    "expectedService": { "title": "جلسة علاج", "duration": 30, "price": 150, "cupsCount": null },
    "date": "2026-10-25",
    "time": "14:00"
  }]
}
```

The server loads the customer and catalog itself. The submitted service snapshot is a stale-selection check, not a trusted price/duration. A changed/reordered service fails with `SERVICE_CHANGED` or `INVALID_SERVICE`; the administrator must refresh and select it again. Dates must be real, strictly formatted and in the future in Israel local time. Existing work-hour, edited-time, exact-start block and duration-overlap rules are reused. Overlap between rows is also rejected. The full one-line schedule must fit the application's 700-character limit; it is never silently truncated. Customer names are limited to 80 characters for this operation.

All rows are saved in one MongoDB transaction. It creates a `treatmentPlans` document, adds every day appointment, and adds every customer-history appointment with matching IDs and `treatmentPlanId`. A conflict on any row rolls back the entire plan. The two embedded appointment representations are explained in the overview.

**MongoDB transactions are required for batch booking.** A replica set/transaction-capable deployment is necessary. Standalone MongoDB receives `TRANSACTIONS_REQUIRED` and no appointments are saved. Required unique day-date and plan-request indexes are verified before a new plan; index failure also blocks the operation. Existing one-appointment booking behavior is unchanged.

Each save has a stable UUID. Retrying that exact UUID and payload returns the original result, even after a network timeout. Reusing it for another payload/customer is rejected. The frontend preserves the pending payload for uncertain responses and retries it rather than constructing another booking. A successful booking receipt is kept even if refreshing the displayed history fails.

`treatmentPlans` stores the original booking snapshot, customer/phone snapshot, request hash, notification state and appointment IDs. Subsequent existing cancellation/rescheduling operations change the ordinary appointment records; they do not rewrite the original plan snapshot or resend a revised plan. The profile joins these records as described above to display current program details and recover canceled sessions. Explicit admin deletion of a fully canceled program is the exception to snapshot retention, as described above.

The server sends one consolidated WhatsApp template after commit. It does not send one creation message per row. Notification failure cannot undo the bookings or turn a saved plan into a booking failure. A durable claim prevents blind duplicate sends on retries. Status meanings:

| Status | Meaning |
| --- | --- |
| `not_configured` | Appointments saved; required template/provider configuration was absent, so no message was sent. |
| `pending` | Committed plan awaiting its dispatch claim. |
| `sent` | Twilio accepted the API request and returned a message SID; this is not proof of handset delivery. |
| `failed` | The provider explicitly rejected the request. |
| `unknown` | A claim/send outcome could not be confirmed; never automatically resend it. |

The `sent` UI text is **تم طلب إرسال رسالة المواعيد؛ لم يتأكد تسليمها بعد.** There is no delivery-status callback in this feature; program status and message delivery are separate.

Main files: `src/lib/treatmentPlans.js` and `src/app/api/admin/users/[userId]/treatment-plans/route.js`.

## Private feedback workflow

The existing external reminder cron can run the feedback job too. There is also a dedicated `GET /api/appointments/cron/feedback` endpoint. Both require `x-cron-secret` when feedback is enabled; the dedicated endpoint always requires a configured `CRON_SECRET`.

Only appointments marked **attended** are eligible. A request becomes due seven calendar days after the appointment's start time in Israel local time. A 30-day catch-up window handles temporarily interrupted jobs or attendance marked late. This also means enabling the job can select existing attended appointments from the last 7–30 days, not only new treatment-plan appointments. Each appointment can receive one request; repeated and overlapping cron runs use the same durable unique appointment claim. Sends are bounded per run. Unknown or explicitly failed provider outcomes are retained and are not retried automatically.

The message contains an unguessable private link, `/feedback/[token]`, to an Arabic form. No customer login is needed. The link shows only that appointment's treatment/date/time, not the customer's name, phone, other appointments or existing feedback. The customer submits up to 10,000 characters once; concurrent/repeated submissions cannot overwrite the saved response. The form supports phone and desktop screens.

Tokens use 32 random bytes. Only their SHA-256 hashes are stored. Links expire 30 days after the request was created. The feedback record is retained after expiry for admin history and send deduplication; there is intentionally no expiry TTL that would delete it. A deleted appointment, revoked attendance or future appointment makes its link unavailable. Invalid, expired and revoked links receive the same public 404. Response headers and page metadata discourage caching, indexing and referrer disclosure.

`appointmentFeedback` stores one record per appointment (`_id` equals appointment ID), its customer ID, hash/expiry, dispatch state and optional `{text, submittedAt}`. `GET /api/feedback/[token]` validates the bearer and current ownership, then returns `{appointment: {title,date,time}, submitted}`. `POST` accepts `{text}` and conditionally writes the first response. It does not implement a WhatsApp inbox or store incoming WhatsApp conversations.

Feedback for ordinary standalone appointments remains compatible with standalone MongoDB. For a plan session, its initial feedback claim requires the same transaction support as program creation/deletion: it updates the owned parent program's internal `feedbackClaimVersion` and inserts the claim atomically. A missing, deleted or mismatched parent prevents the claim. Concurrent deletion conflicts/retries against this parent write and removes any committed claim. Checking live attendance and submitting feedback still occur separately; ordinary cancellation can retain a previously claimed feedback record, which the profile displays only while its appointment is recoverable from live history or an owned snapshot. Submissions update an existing record without upsert, so they cannot recreate a deleted record. Existing cancellation/attendance writers are unchanged.

Main files:

- `src/lib/appointmentFeedback.js`
- `src/app/api/feedback/[token]/route.js`
- `src/app/feedback/[token]/page.js` and its `FeedbackClient.jsx`
- `src/app/api/appointments/cron/feedback/route.js`
- Feedback hook in `src/app/api/appointments/cron/reminder/route.js`

## Arabic Twilio templates to submit

Create two Arabic WhatsApp templates in Twilio Content Template Builder. Submit them for WhatsApp approval, then copy their **Content SIDs** into the variables below. The following texts and examples match the implemented numbered variables. Provider approval and live delivery have not been performed locally.

### Treatment-plan confirmation

Suggested name: `soul_treatment_plan_ar`

```text
مرحبًا {{1}}، تم حجز برنامجك العلاجي في عيادة سول.
هذه تفاصيل مواعيدك: {{2}}
يرجى الاحتفاظ بهذه الرسالة والالتزام بالمواعيد المحددة. للاستفسار أو طلب تغيير موعد، تواصل مع العيادة. نتمنى لك الصحة والعافية.
```

| Variable | Meaning | Sample for approval |
| --- | --- | --- |
| `{{1}}` | Customer's full name | أحمد محمد |
| `{{2}}` | Complete schedule, one line with `\|` separators | 2026-10-25 14:00 - جلسة علاج أولى \| 2026-11-01 15:30 - جلسة علاج ثانية |

Configuration: `TWILIO_TEMPLATE_SOUL_TREATMENT_PLAN=HX...`

### Feedback request one week after attendance

Suggested name: `soul_treatment_feedback_ar`

```text
مرحبًا {{1}}، نود الاطمئنان عليك بعد موعد {{2}} بتاريخ {{3}} في عيادة سول.
كيف كانت تجربتك بعد الجلسة؟ يمكنك كتابة ملاحظاتك عبر رابطك الخاص: {{4}}
مشاركتك اختيارية وتساعدنا على تحسين الخدمة. شكرًا لوقتك وثقتك بنا.
```

| Variable | Meaning | Sample for approval |
| --- | --- | --- |
| `{{1}}` | Customer's name | أحمد محمد |
| `{{2}}` | Treatment name | جلسة علاج |
| `{{3}}` | Attended appointment's date | 2026-10-18 |
| `{{4}}` | Full private feedback URL | `https://soulclinc.net/feedback/EXAMPLE_PRIVATE_TOKEN` |

Configuration: `TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK=HX...`

Static template text can have line breaks. Values injected into approved WhatsApp template variables must not contain newlines; names, treatment names and the schedule are normalized to one line. The 700-character schedule bound is an application limit, not a statement of a universal Twilio limit. See [Twilio variables documentation](https://www.twilio.com/docs/content/using-variables-with-content-api) and [Content Template Builder](https://www.twilio.com/docs/content/create-templates-with-the-content-template-builder).

## Configuration after owner approval

Existing Twilio account/auth/sender configuration is reused. New variable names:

| Variable | Purpose |
| --- | --- |
| `TWILIO_TEMPLATE_SOUL_TREATMENT_PLAN` | Approved plan Content SID. |
| `TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK` | Approved feedback Content SID. |
| `FEEDBACK_PUBLIC_BASE_URL` | Explicit public HTTPS application URL, normally `https://soulclinc.net`. Never derived from an incoming Host header. |
| `FEEDBACK_REQUESTS_ENABLED` | Must be exactly `true` to send feedback requests. Omitted/false is disabled. |
| `CRON_SECRET` | Existing cron secret, required for feedback. Send as `x-cron-secret`. |

No actual values, credentials or production settings were changed by this implementation. With the feature disabled, the existing reminder's feedback hook does no feedback database/provider work. There is no new timer service: the external scheduler must invoke the existing reminder endpoint or the dedicated feedback endpoint. It can run frequently; the appointment claim prevents duplicate feedback messages.

The dedicated endpoint supports `?dryRun=1`: it returns counts without storing claims/tokens or contacting Twilio. The existing reminder supports its original dry-run behavior too. Feedback never uses the reminder route's `testTime` parameter to trigger actual sends early. Enable/configure only after the templates are approved and the feature is reviewed.

## Local verification

Focused backend coverage is under `tests/profiles/`, `tests/treatmentPlans/` and `tests/feedback/`. Tests use injected/mocked senders and isolated local MongoDB instances, including replica-set transaction tests and standalone behavior. Browser coverage under `tests/e2e/customerProfile/` uses production components with mocked HTTP APIs and denied external requests. It verifies interaction and layout, not real authentication, Twilio delivery or production MongoDB configuration.

Run backend tests with `npm run test:run -- --maxWorkers=1`; consult [the browser harness README](tests/e2e/customerProfile/README.md) for its command and available-runtime requirements. Browser artifacts remain ignored; ignore rules were not changed. Appointment-detail regression tests cover current-time joins, canceled-session recovery, program status/counts, independent booking notes/feedback, uncertain records, ownership and restricted projections. Browser cases cover the combined appointment list, distinct long-text dialogs, full program details and delivery-unconfirmed wording on desktop, tablet and mobile.

Original feature verification on 2026-10-23 (before the owner's merge/deployment and this appointment-details follow-up):

| Check | Result |
| --- | --- |
| `npm run test:run -- --maxWorkers=1` | 47 files, **1,802 tests passed**. |
| `node tests/e2e/customerProfile/run.cjs` | **30 browser cases passed**, across desktop, tablet and mobile. Profile, long-feedback dialog and public-form screenshots inspected. |
| ESLint on all 16 changed application source files | Passed. |
| `next build --webpack` | Passed in a temporary copy with no `.env` files, a sanitized environment, dummy provider values, unreachable loopback Mongo URI and one build worker. The repo's build configuration/dependencies were unchanged. |
| Independent backend and frontend review | Completed; catalog-refresh substitution finding fixed and its regression passed. |
| `git diff --check` | Passed. |

During that original verification, the first full suite under concurrent load had one existing Firebase Admin import test exceed its five-second timeout; the complete single-worker run passed without changing that test or Firebase code. Build output also reported existing outdated Browserslist data; no dependency update was made. That verification used no production database, real messaging, template approval, deployment, push or merge.

Appointment-details, contact-link and program-pagination follow-up verification on 2026-10-23:

- Full single-worker backend suite: **54 files, 1,947 tests passed**, including actual isolated MongoDB pagination (3/3/1 pages, tied dates, inserts between requests, cursor ownership and current session statuses).
- Isolated profile browser suite: **63 cases passed** on desktop, tablet and mobile. Contact links, initial three programs, load-more cursor requests, last-page hiding, retries, duplicate-click prevention, deduplication and refresh races are covered alongside the existing profile/booking/feedback tests.
- Scoped ESLint and `git diff --check` passed. Profile, program details, pagination and booking-note dialog screenshots were inspected.
- Independent backend/UI review completed; the earlier orphan-note finding was fixed and pagination review found no further issues. No new production build or live provider test was performed for this follow-up. These changes remain local and uncommitted on `main`; no push, deployment, environment changes or live messages were performed.

Appointment-page controls, canceled-program deletion and renewed-reminder preference follow-up verification on 2026-10-23:

- Full single-worker backend suite: **56 files, 1,987 tests passed**. Deletion tests use an isolated replica set and cover active/inconsistent records, ownership, rollback, repeated/concurrent deletion, stale booking retries, deleted pagination anchors, and both controlled feedback-claim/deletion interleavings. Ordinary standalone feedback is also covered.
- Profile browser suite: **93 cases passed** across desktop, tablet and mobile before the final save-refresh/deletion-failure race correction; **all 42 affected browser cases passed** after that correction, including new 409/500 pending-save-refresh regressions and existing stale-page guards.
- Renewed-consent behavior passed **130 focused backend tests** and **24 reminder browser cases**; its policy and new-unsubscribe handling are documented in [RETURN_REMINDERS.md](RETURN_REMINDERS.md).
- Scoped source/test ESLint and `git diff --check` passed. Desktop pagination and mobile deletion-confirmation screenshots were inspected. Independent backend and UI review completed; feedback-claim/deletion and failed-delete/save-refresh races were fixed and re-reviewed.
- Changes remain local and uncommitted on `main`. No environment edits, production database migration, live messages, push or deployment were performed. A new production build was not run for this follow-up.

Private program comments, mobile back-link spacing and builder-collapse verification on 2026-10-23:

- Full backend suite: **58 files, 2,025 tests passed** before the final deleted-comment retry guard. After that guard, **92 targeted tests passed**, and the updated **17 deletion tests passed**, including removal of embedded comments/UUID markers and a concurrent comment write during program deletion.
- The final focused profile browser matrix passed **40 cases**, with two intentional skips because the mobile-only spacing case does not apply to desktop/tablet. It covers multiple comments, icon CRUD, errors, revision conflicts, deleted-ID retry handling, uncertain add identities, older-card draft retention, stale refreshes, long plain text and builder-collapse state retention.
- The final full profile browser suite passed **139 cases**, with the same two intentional spacing-case skips, across desktop, tablet and mobile. Final screenshots are under `tests/e2e/customerProfile/artifacts/results`.
- Scoped ESLint and diff checks passed. Mobile back-link spacing and desktop/mobile long-comment screenshots were inspected. Independent backend/UI reviews found and verified fixes for deleted-comment resurrection, lost older-card drafts, at-cap uncertain retries and stale refresh revisions; no actionable findings remain.
- Tests use isolated local databases and mocked browser/provider boundaries. No production database, environment, messaging, commit, push or deployment actions were performed; changes remain local on `main`.

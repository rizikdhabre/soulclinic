# Customer profiles, treatment plans and private feedback

Local feature branch: `codex/customer-treatment-plans-feedback`. Implemented in the existing JavaScript/JSX, Next.js, React, Tailwind, MongoDB and Twilio stack. No language, framework or dependency migration is part of this feature. Deployment, Twilio approval and production configuration remain the owner's decision.

For the rest of the application's architecture, existing single-booking/cancellation/blocking rules, dashboard and user-table meanings, read [project overview.md](project%20overview.md). This document describes only the new feature.

## Customer profile

Both desktop and mobile customer-name links on `/admin/users` open `/admin/users/[userId]`. Existing name-edit controls still edit names. The profile shows the customer's name and phone, previous appointments, upcoming appointments, and a treatment-plan builder titled **برنامج علاجي**.

Past appointments are determined by their start date/time in `Asia/Jerusalem`, not the administrator's computer timezone. Valid history is sorted newest first. Attendance is read-only: **حضر** when `attended === true`, otherwise **لم يحضر** for past appointments. Upcoming appointments are shown separately and are not labeled as missed. Existing attendance controls elsewhere remain responsible for marking attendance.

The feedback column shows a preview. Clicking feedback opens the complete text in a responsive dialog; X, Escape or clicking the backdrop closes it. The dialog preserves line breaks, wraps long words, traps focus and returns focus to the opener. Feedback is rendered as text, never HTML.

`GET /api/admin/users/[userId]` requires the existing admin JWT and returns a private/no-store response. It exposes only customer identity, appointment history and limited plan status. It does not expose tokens, token hashes, provider identifiers or staff notes. Feedback is joined using both customer ID and appointment ID, only for appointments still in that customer's history.

Main files:

- `src/app/admin/users/[userId]/page.js`
- `src/components/admin/CustomerProfileClient.jsx`, `TreatmentPlanBuilder.jsx`, `FeedbackDialog.jsx`
- `src/lib/adminCustomerProfile.js`, `clinicTime.js`
- `src/app/api/admin/users/[userId]/route.js`

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

`treatmentPlans` stores the immutable original booking snapshot, customer/phone snapshot, request hash, notification state and appointment IDs. Subsequent existing cancellation/rescheduling operations change the ordinary appointment records; they do not rewrite the original plan snapshot or resend a revised plan. The live customer history remains the current appointment view.

The server sends one consolidated WhatsApp template after commit. It does not send one creation message per row. Notification failure cannot undo the bookings or turn a saved plan into a booking failure. A durable claim prevents blind duplicate sends on retries. Status meanings:

| Status | Meaning |
| --- | --- |
| `not_configured` | Appointments saved; required template/provider configuration was absent, so no message was sent. |
| `pending` | Committed plan awaiting its dispatch claim. |
| `sent` | Twilio accepted the API request and returned a message SID; this is not proof of handset delivery. |
| `failed` | The provider explicitly rejected the request. |
| `unknown` | A claim/send outcome could not be confirmed; never automatically resend it. |

Main files: `src/lib/treatmentPlans.js` and `src/app/api/admin/users/[userId]/treatment-plans/route.js`.

## Private feedback workflow

The existing external reminder cron can run the feedback job too. There is also a dedicated `GET /api/appointments/cron/feedback` endpoint. Both require `x-cron-secret` when feedback is enabled; the dedicated endpoint always requires a configured `CRON_SECRET`.

Only appointments marked **attended** are eligible. A request becomes due seven calendar days after the appointment's start time in Israel local time. A 30-day catch-up window handles temporarily interrupted jobs or attendance marked late. This also means enabling the job can select existing attended appointments from the last 7–30 days, not only new treatment-plan appointments. Each appointment can receive one request; repeated and overlapping cron runs use the same durable unique appointment claim. Sends are bounded per run. Unknown or explicitly failed provider outcomes are retained and are not retried automatically.

The message contains an unguessable private link, `/feedback/[token]`, to an Arabic form. No customer login is needed. The link shows only that appointment's treatment/date/time, not the customer's name, phone, other appointments or existing feedback. The customer submits up to 10,000 characters once; concurrent/repeated submissions cannot overwrite the saved response. The form supports phone and desktop screens.

Tokens use 32 random bytes. Only their SHA-256 hashes are stored. Links expire 30 days after the request was created. The feedback record is retained after expiry for admin history and send deduplication; there is intentionally no expiry TTL that would delete it. A deleted appointment, revoked attendance or future appointment makes its link unavailable. Invalid, expired and revoked links receive the same public 404. Response headers and page metadata discourage caching, indexing and referrer disclosure.

`appointmentFeedback` stores one record per appointment (`_id` equals appointment ID), its customer ID, hash/expiry, dispatch state and optional `{text, submittedAt}`. `GET /api/feedback/[token]` validates the bearer and current ownership, then returns `{appointment: {title,date,time}, submitted}`. `POST` accepts `{text}` and conditionally writes the first response. It does not implement a WhatsApp inbox or store incoming WhatsApp conversations.

Feedback remains compatible with standalone MongoDB. Checking appointment ownership and saving its feedback occur in separate operations: a concurrent cancellation between those operations can leave an orphan feedback record. Such a record is excluded from the admin profile because the appointment no longer exists. This feature does not change existing cancellation/attendance writers.

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

Run backend tests with `npm run test:run -- --maxWorkers=1`; consult [the browser harness README](tests/e2e/customerProfile/README.md) for its command and available-runtime requirements. New source/test/document paths have Git intent-to-add entries so they appear in the local diff despite the existing test ignore rule. There is no staged content or commit. Browser artifacts remain ignored; ignore rules were not changed.

Verified locally on 2026-10-23:

| Check | Result |
| --- | --- |
| `npm run test:run -- --maxWorkers=1` | 47 files, **1,802 tests passed**. |
| `node tests/e2e/customerProfile/run.cjs` | **30 browser cases passed**, across desktop, tablet and mobile. Profile, long-feedback dialog and public-form screenshots inspected. |
| ESLint on all 16 changed application source files | Passed. |
| `next build --webpack` | Passed in a temporary copy with no `.env` files, a sanitized environment, dummy provider values, unreachable loopback Mongo URI and one build worker. The repo's build configuration/dependencies were unchanged. |
| Independent backend and frontend review | Completed; catalog-refresh substitution finding fixed and its regression passed. |
| `git diff --check` | Passed. |

The first full suite under concurrent load had one existing Firebase Admin import test exceed its five-second timeout; the complete single-worker run passed without changing that test or Firebase code. Build output also reported existing outdated Browserslist data; no dependency update was made. No production database, real messaging, template approval, deployment, push or merge was performed. Changes remain local and uncommitted for the owner's review.

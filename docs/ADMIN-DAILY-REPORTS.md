# Daily admin WhatsApp reports

The dedicated endpoint sends the existing admin recipient two Arabic WhatsApp reports: tomorrow's appointments and new customer feedback. The external daily cron must be created separately after deploying this code. It has not been created by this implementation. The existing appointment/feedback and return-reminder cron jobs remain unchanged.

## Environment variables

Set these names in Vercel's **Production** environment and deploy again so the deployment receives them. Use the same names in `.env.local` for local development; do not commit that file.

| Variable | Purpose |
| --- | --- |
| `TWILIO_TEMPLATE_TOMORROW_APPOINTMENTS` | Content SID (`HX...`) of the admin tomorrow-appointments template. |
| `TWILIO_TEMPLATE_FEEDBACK` | Content SID (`HX...`) of the admin new-feedback template. |
| `TWILIO_WHATSAPP_TO` | Existing admin WhatsApp recipient. |
| `TWILIO_WHATSAPP_FROM` | Existing approved WhatsApp sender. |
| `TWILIO_ACCOUNT_SID` | Existing Twilio account SID. |
| `TWILIO_AUTH_TOKEN` | Existing Twilio authentication token. |
| `CRON_SECRET` | Existing cron authentication secret. |

The two new template names are separate from the customer-facing `TWILIO_TEMPLATE_SOUL_TREATMENT_FEEDBACK` template. Do not replace the customer template with the admin report template. No additional enable flag is required. Live sends require usable, approved templates and the existing MongoDB configuration.

Each report fills exactly one ContentVariable, `{{1}}`, with the complete numbered list. Internal whitespace is normalized to spaces; entries are separated by ` ║ `.

Appointments template body:

```text
📅 مواعيد الغد — SoulClinic

{{1}}

انتهى الجدول.
```

Feedback template body:

```text
📝 تقييمات الزبائن — SoulClinic

{{1}}

التقييمات الجديدة منذ التقرير السابق.
```

## External cron configuration

Create this job together with the site owner after deployment:

- URL: `https://soulclinc.net/api/appointments/cron/admin-reports`
- Method: `GET`
- Schedule: every day at **21:00**.
- Time zone: **Asia/Jerusalem** (handles daylight-saving changes).
- Header: `x-cron-secret`, with the exact value of the deployment's `CRON_SECRET`.
- Scheduler timeout: **30 seconds**.
- Saving responses in job history is useful for the execution ID.

Before 21:00 in the clinic's time zone, a real invocation does not send reports. The route does not accept clock, date or force overrides. Configure the external cron to run at 21:00; deploying code does not create that scheduled trigger.

## Read-only check and completion

Call the same authenticated URL with `?dryRun=1` to preview eligibility at any time. Dry runs perform no database writes, index creation or messages. The preview uses the real clinic date and that date's fixed 21:00 feedback cutoff.

The endpoint quickly returns HTTP **202**, for example:

```json
{
  "accepted": true,
  "executionId": "a-unique-execution-id",
  "adminReports": { "status": "accepted", "dryRun": true }
}
```

This means the background task was accepted, **not that reports finished or messages were delivered**. Next's `after` callback runs the worker within the route's 300-second maximum duration. In Vercel function logs, find `admin-reports` and the same `executionId`: the `finished` event records the clinic date, tomorrow's date, per-report status, entry count and full rendered character count. A `failed` event contains a generic error code. Logs and HTTP responses do not include report contents, customer names, phone numbers or provider errors.

After a live report is accepted by Twilio, confirm actual delivery in Twilio Messaging logs. `sent` in report history means Twilio accepted the API request, not that WhatsApp delivered it.

## What is included

- Tomorrow means the next **clinic calendar date**, including daylight-saving, month and year transitions. Appointments are the currently booked calendar entries, ordered by start time, with customer name, phone, treatment and time.
- Feedback contains the customer's name, treatment, improvement rating where available, and full comment. Old comments without a rating remain readable.
- Feedback is included through the fixed **21:00 cutoff, exclusive**. A submission at or after 21:00 is included in the next report.
- The first real run establishes a baseline of **21:00 on the previous clinic calendar day**. Older historical feedback is excluded from initial activation. Subsequent runs pick up all unreported feedback since that baseline, including late writes and feedback from missed report days.
- Empty reports explicitly state that there are no appointments or new feedback.

## Duplicates, failure and size limits

Durable database claims protect each clinic-date/report pair. Feedback IDs are reserved transactionally so simultaneous runs and reports on later dates cannot include feedback that has already been accepted or has an uncertain send outcome. Report history stores a payload hash and metadata rather than a copy of customer comments or the full message text.

Each report is at most one WhatsApp message. Its **complete rendered body**, including the template's fixed text, must fit within 1,600 characters. The worker does not split or silently truncate reports. A `too_long` report is not sent; its feedback is not marked reported. Customer feedback has a separate 50-word limit, but legacy comments and several entries together can still make a report too long. Investigate a `too_long` result rather than assuming it was delivered.

Accepted sends are not retried automatically. Ambiguous provider or post-send persistence failures retain their claims/reservations and are not automatically retried either, because the message may already have been sent. An interrupted task may retain a `claimed` state; this also blocks automatic retry. Confirm uncertain outcomes in Twilio before any manual recovery. Definite HTTP4xx rejections, except408, release feedback reservations and allow another invocation to retry on the same clinic day. Feedback from a definite failure can also be included in a later day's report.

| Result | Meaning |
| --- | --- |
| `not_due` | It is before 21:00 in Asia/Jerusalem; nothing was sent. |
| `not_configured` | Required configuration is missing; no database work or sends occur. |
| `ready` | A dry-run report fits; no message or claim was created. |
| `sent` | Twilio accepted the send request. Delivery remains to be checked in Twilio. |
| `already_sent` | The date/type report was accepted previously; it was not sent again. |
| `too_long` | The complete report exceeds the length limit; it was not sent or consumed. |
| `failed` | A definite rejection occurred; a later invocation may retry. |
| `unknown` / `claimed` | Sending is uncertain or a prior claim remains; automatic retry is blocked. |
| `busy` | A competing report reserved overlapping feedback; this invocation did not send that report. |
| `error` | Preparing or processing this report failed; the other report is still handled independently. |
| `completed` | Overall outcome is ready in a dry run, or both reports were accepted previously or by this run. |
| `partial` | Overall outcome includes a report that did not complete normally. |

Inspect the final background result even when cron history shows HTTP202.

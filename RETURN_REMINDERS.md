# Monthly return reminders

Return reminders preserve the project's JavaScript/JSX, Next.js, React, Tailwind, MongoDB and Twilio stack. Template approval, environment values, cron-job.org settings and the Twilio webhook are manual setup steps for the owner. The sending job still requires `RETURN_REMINDERS_ENABLED=true` and complete configuration.

Customer profiles, treatment plans, appointment feedback, and their templates are already explained in [TREATMENT_PLANS_AND_FEEDBACK.md](TREATMENT_PLANS_AND_FEEDBACK.md). The baseline architecture and language/framework preservation rule are in [project overview.md](project%20overview.md).

## When a return reminder is due

All of these conditions must hold:

1. The effective return-reminder preference is enabled. Existing and future customers with no stored preference are enabled by default, as requested by the owner after confirming customer agreement. The one-time renewed-consent policy below also includes recognized earlier opt-outs; subsequent opt-outs remain disabled.
2. There is a valid past appointment marked `attended: true`.
3. Three **calendar months** have passed since the latest attended appointment, using `Asia/Jerusalem` date and time. Month-end anniversaries clamp to the last day of the target month: November 30 plus three months is February 28 (29 in a leap year).
4. There is no current or future appointment. This includes individual bookings and all treatment-plan appointments. The job checks both customer histories and the day schedule, including records associated with the same normalized phone.
5. At least **30 elapsed days** have passed since the previous attempt. There is no maximum reminder count; reminders continue while the customer remains eligible and subscribed.

Malformed attended-treatment dates/times or uncertain future scheduling data cause the customer to be skipped rather than authorizing a reminder from incomplete history.

A future booking pauses sending. Attending a treatment restarts the three-month waiting period because the latest attended appointment changes. Canceling a future booking removes the pause but does not reset attendance or the 30-day cooldown. A no-show does not reset the attendance clock. Customers who have never attended are excluded.

Only this new return-reminder feature reads the preference. Existing booking confirmations, booked-appointment reminders and weekly feedback remain governed by their existing logic.

## Permission and unsubscribe

`ReturnReminderPreference.jsx` is shown on `/admin/users/[userId]`. Its separate admin API is `/api/admin/users/[userId]/return-reminders`:

- `GET` returns the effective `{enabled}` after admin authentication and customer lookup. The UI describes the enabled state without claiming a new individual consent record was written.
- `PATCH` accepts `{enabled: boolean}`. Enabling additionally requires `{consentConfirmed: true}` to record that the customer agreed. The server obtains the phone from the customer record, never from request input.
- New opt-outs take effect immediately. Re-enabling a subsequent opt-out requires a fresh explicit admin action and does not clear send history or the cooldown.

Permission is shared by normalized phone, so duplicate customer records and local/international phone formatting share the same choice. A missing preference is effectively enabled for both existing and newly created customers. Reading it or sending a reminder does not insert a preference or fabricate individual consent/source timestamps; customer creation and booking flows need no additional writes.

The owner reconfirmed agreement for earlier opt-outs at **2026-10-23T15:27:08.000Z**. This is a one-time effective-policy change, not a bulk database migration:

- An existing `enabled: false` record is treated as enabled only when its source is `admin`, `unsubscribe_link`, or `whatsapp`, it has no `policyRevision` field, and its available `updatedAt`/`disabledAt` values are valid dates whose latest is at or before that cutoff.
- Missing/malformed audit data, unknown sources/revisions, malformed `enabled` values, and opt-outs newer than the cutoff remain disabled.
- Every new explicit choice stores `policyRevision: "owner-reconfirmed-2026-10-23"`. A new admin disable, unsubscribe POST, or WhatsApp STOP therefore stays disabled, even if its supplied clock is earlier than the cutoff. Re-enabling it still requires the explicit admin consent confirmation.
- Existing preference history, send claims/cooldowns, and processed inbound message IDs are preserved. Replaying an already-processed old STOP does not undo renewed agreement; a new STOP works normally. No live preference migration is part of this code change.

The shared effective-policy function is used by the admin/public preference reads, inbound replay status, and both sender permission checks. The stored historical value alone is not the effective setting for a recognized pre-cutoff opt-out.

Each reminder includes an opaque private URL, `/reminders/unsubscribe/[token]`. It opens an Arabic confirmation page with no name, phone, or treatment details. Merely opening the page or previewing the link makes no change. The confirmation button POSTs to `/api/reminders/unsubscribe/[token]` and saves the opt-out. Repeated confirmation is safe. Invalid links receive a generic response. Tokens are random 32-byte values; only SHA-256 hashes are stored. Old unsubscribe links remain valid rather than expiring and preventing someone from opting out.

Replying `إيقاف` or `ايقاف` (including diacritics), `STOP`, or `UNSUBSCRIBE` to the configured WhatsApp number disables the same preference. The existing `/api/whatsapp/inbound` handler verifies Twilio's signature, sender channel and recipient before changing data. It returns an Arabic confirmation after storage succeeds. Ordinary valid messages keep the existing clinic contact response. `START` does not silently restore permission.

The inbound handler validates against `TWILIO_INBOUND_WEBHOOK_URL`, the **exact public URL configured in Twilio**, including any query string. It does not trust forwarded host headers to choose a signing URL. All form fields participate in SDK signature validation. See [Twilio webhook security](https://www.twilio.com/docs/usage/webhooks/webhooks-security).

If Twilio Advanced Opt-Out sends `OptOutType=STOP`, the app saves the opt-out but leaves the TwiML reply empty because Twilio has already replied. Provider-level opt-out may independently block other message categories; the app cannot override that provider behavior. The owner's renewed-consent policy does not remove a Twilio provider-level block. See [Twilio Advanced Opt-Out](https://www.twilio.com/docs/messaging/tutorials/advanced-opt-out).

## Dispatch and duplicate prevention

The existing `GET /api/appointments/cron/reminder` endpoint calls the new job when `RETURN_REMINDERS_ENABLED=true`, even if there are no appointment reminders due that day. The response includes a separate `returnReminders` summary. Failure of the weekly feedback job does not prevent the monthly job, and a monthly-job failure does not replace successful weekly feedback results.

There is no additional timer or queue service. The current external cron can continue polling this endpoint. When return reminders are enabled, `CRON_SECRET` must be configured and the caller must supply the correct `x-cron-secret` header. `?dryRun=1` performs eligibility checks without messages, claims, indexes, or preference changes. The legacy `testTime` query never advances the new job's actual clock.

The new service uses a durable atomic claim keyed by normalized phone. Simultaneous cron requests and repeated runs cannot independently claim that phone during the cooldown. It checks live attendance, scheduling and permission again after claiming and immediately before dispatch. Claim and status writes use majority write concern and work without MongoDB transactions.

Candidate discovery streams customer records, normalizes and deduplicates their phone numbers, and checks effective permission. It does not depend on a pre-existing preference row. Each run allows at most 50 actual provider dispatches; cooled, opted-out, malformed, and otherwise ineligible earlier customers do not prevent later eligible customers from being considered.

An accepted Twilio SID means Twilio accepted the message, not that it reached the customer's handset. An explicit provider rejection is recorded as failed; network errors and ambiguous results are recorded as unknown. A durable claim survives either outcome and status-write errors. The system does not blindly retry an uncertain send. This deliberately favors avoiding repeated messages over retrying every failed attempt.

MongoDB and Twilio do not share a transaction. A booking or opt-out after the final eligibility read cannot retract a provider request already in flight. Existing booking writers are not redesigned by this feature. A crash after claiming can leave a missed reminder for that cooldown period; it must not produce an immediate duplicate.

## Collections

| Collection | Purpose |
| --- | --- |
| `returnReminderPreferences` | `_id` is the normalized phone; `enabled`, source, audit timestamps and new-choice `policyRevision` store explicit choices. Missing records use the default policy; recognized legacy records use the one-time renewal rule above. Processed inbound message IDs prevent a retried old STOP from undoing renewed consent or a later deliberate re-enable. |
| `returnReminderState` | `_id` is the normalized phone; atomic claim identity and `nextAttemptAt` control dispatch and cooldown. |
| `returnReminderHistory` | One record per claimed attempt, with customer/phone identity, attendance snapshot, hashed unsubscribe token, dispatch timestamps/status and accepted provider SID when available. |

There are no TTL indexes that would discard preference, cooldown, history, or old unsubscribe links. Raw tokens, provider errors and contact details must not be exposed in the new cron summaries. Private endpoints use no-store/no-referrer/noindex protections.

## Manual setup after code review

No environment files were read or changed for this implementation. These are the settings the owner will configure separately:

| Variable | Purpose |
| --- | --- |
| `RETURN_REMINDERS_ENABLED` | Exactly `true` enables the new job; omitted/false keeps it disabled. |
| `TWILIO_TEMPLATE_SOUL_RETURN` | The reviewed/approved Content SID for `soul_return_reminder_ar`. Do not embed credentials or a live SID in source code. |
| `RETURN_REMINDERS_PUBLIC_BASE_URL` | Explicit public HTTPS app origin, normally `https://soulclinc.net`, used for booking and private unsubscribe links. |
| `TWILIO_INBOUND_WEBHOOK_URL` | Exact public URL registered for inbound WhatsApp POSTs, normally `https://soulclinc.net/api/whatsapp/inbound`. |
| `CRON_SECRET` | Existing secret supplied as the cron's `x-cron-secret` header. |
| Existing Twilio account, auth token and WhatsApp sender variables | Reused by the sender and webhook validation. |

Keep `RETURN_REMINDERS_ENABLED` off until template, public links, webhook, customer permission and cron configuration have been reviewed and tested. The inbound route now needs its exact URL and existing auth/sender configuration to validate requests; configure these when deploying its change.

The four template variables are wired in code as follows:

| Variable | Value |
| --- | --- |
| `{{1}}` | Customer's name, normalized to a single line. |
| `{{2}}` | Latest attended appointment date, `YYYY-MM-DD`. |
| `{{3}}` | `${RETURN_REMINDERS_PUBLIC_BASE_URL}/dashboard`. |
| `{{4}}` | `${RETURN_REMINDERS_PUBLIC_BASE_URL}/reminders/unsubscribe/${privateToken}`. |

The selected Arabic template text is:

```text
مرحبًا {{1}}، مرّت ثلاثة أشهر أو أكثر على آخر جلسة لك في عيادة سول بتاريخ {{2}}.
إذا رغبت بحجز موعد جديد، يمكنك الاطلاع على العلاجات واختيار الموعد المناسب عبر الرابط: {{3}}
لإيقاف تذكيرات العودة للعيادة، أرسل كلمة إيقاف أو استخدم الرابط التالي: {{4}}
نتمنى لك دوام الصحة والعافية.
```

Approval status and live delivery are not established by the local tests. We will verify these with the owner during manual setup, using a designated test number and test appointments rather than contacting customers.

## Source and verification

Core eligibility/sending: `src/lib/returnReminders.js`. Shared preferences and bearer authorization: `src/lib/returnReminderPreferences.js`. Public page: `src/app/reminders/unsubscribe/[token]/`. HTTP handlers: `src/app/api/reminders/unsubscribe/[token]/`, the admin preference route, existing inbound WhatsApp route and existing reminder cron.

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

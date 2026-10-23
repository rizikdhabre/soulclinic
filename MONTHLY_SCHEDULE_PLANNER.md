# Monthly schedule planner

This feature adds **تنظيم أوقات الشهر** to `/admin/profile`, directly below **حظر أوقات لشهر كامل**. The original monthly blocker component and API are unchanged. Its baseline behavior is already explained in [project overview.md](project%20overview.md), section 9.

## Admin workflow

The arrow beside **تنظيم أوقات الشهر** collapses or expands all content below the heading, retaining the current month, draft and preview. The panel starts expanded. There is no separate saved-month list or group-delete button; saved state still loads into the editor.

1. Choose a month. Its saved schedules load from the database, including changes made through the daily calendar or the original blocker.
2. Select weekdays for a group, such as Monday and Wednesday.
3. Choose **تعديل أوقات البدء** to edit the existing time rows and lock individual starts, or **إغلاق اليوم بالكامل** to block every offered start on those weekdays. Blocked rows stay visible with a red background and a filled lock button. There are no add-time or delete-time controls.
4. Add another group for weekdays needing different settings. Each weekday belongs to at most one group; **اختيار الأيام المتبقية** selects unassigned weekdays. Groups with no selected weekdays are ignored during preview/apply, so an unused extra group does not block saving. At least one weekday must be selected overall.
5. The selected dates always replace their earlier schedule settings. There is no preservation dropdown. The group editor identifies the saved reference date it uses and warns when selected dates have different schedules; the preview provides date-level details.
6. Preview the matching dates, existing bookings, skipped dates and proposed times. Exclude individual dates if needed, then preview again.
7. Apply the preview. Editing the form invalidates the previous preview. A booking conflict prevents the entire save and shows the conflicting date/time below the controls.

For example, close every Monday in November, then add a Wednesday group with edited start times and selected blocked starts. Unselected weekdays and other months keep their existing settings.

## Meaning of times and existing bookings

- Times are **appointment start times**, within the existing 10:00–19:30 bounds. The existing treatment-duration/end-of-day checks still determine which starts can be booked.
- Blocking a start prevents an appointment from starting at that exact time. It does not create an interval that forbids other appointments from running across that time.
- Full-day closure is rejected if an affected date has any appointments. Existing appointments are never canceled or moved by this tool.
- Editing a group replaces the allowed start list and blocked-start list on dates that are actually applied, including earlier customizations. Previously saved blocks can be changed or cleared.
- If the proposed schedule omits or blocks an existing booked start, the entire operation is rejected. Compatible bookings whose start remains available do not prevent other changes. This check uses exact appointment starts, matching existing blocking semantics.
- Past dates are skipped according to `Asia/Jerusalem`. Today can be edited. Invalid legacy day records are skipped rather than silently repaired.
- `editedTimes: []` means the default schedule in the existing application; full closure therefore uses a nonempty effective schedule with all of its starts blocked.
- Previously omitted default starts in shorter legacy schedules appear as blocked rows, so loading an old schedule does not silently reopen them. A full-length schedule with moved times retains those moved starts.

The month view reads current day records rather than a cached copy of an old editor configuration. Returning to a month later reloads its saved times and blocks. Selecting the first weekday of a group loads its reference schedule; differing dates are identified rather than presented as one uniform saved schedule. A failed month load disables saving until it is successfully retried.

Successful apply keeps the preview visible, refreshes saved month status, and updates the daily calendar below to an affected date. The calendar discards an outdated daily editing draft and ignores late responses for the previous date. The planner preserves the current viewport when saving; deliberate user scrolling during a pending request is respected.

## Source and API map

| Source | Responsibility |
| --- | --- |
| `src/components/admin/MonthlySchedulePlanner.jsx` | Independent Arabic month/group editor, preview and apply flow. |
| `src/app/admin/profile/page.js` | Places the new panel directly below the original blocker. |
| `src/lib/monthlyScheduleRules.js` | Strict request validation, weekday/date matching and preview calculations. |
| `src/lib/monthlySchedule.js` | Database preview, stale-state checks, transactional apply and replay handling. |
| `src/lib/monthlyScheduleRoute.js` | Shared authentication, error responses and cache policy for the three new endpoints. |
| `src/app/api/admin/monthly-schedule/preview/route.js` | Authenticated read-only preview. |
| `src/app/api/admin/monthly-schedule/apply/route.js` | Authenticated apply endpoint. |
| `src/app/api/admin/monthly-schedule/state/route.js` | Authenticated read of all saved/default days in a selected month. |
| `src/components/admin/BookForCustomer.jsx` | Refreshes selected-day availability after `appointments:changed`. |
| `src/components/admin/DailyCalendar.jsx` | Shows an affected date after monthly apply, refreshes the timeline and ignores outdated requests. |

The implementation keeps JavaScript/JSX and the current dependencies. It does not modify shared booking rules, the old blocker or its endpoint.

All three endpoints use `withAdminRoute` and return private/no-store responses. Preview exposes dates, schedule arrays and booking counts, without names or phone numbers. Month state exposes only appointment start times alongside schedules, with no customer details. Request groups use JavaScript weekdays (Sunday `0` through Saturday `6`), with no overlaps between groups. Times must be unique `HH:mm` strings; blocked times must belong to the group's offered starts. The retired `customizedDays` input is ignored. See [the revision plan](docs/superpowers/plans/2026-10-23-monthly-schedule-revision.md) for the current contract.

## Consistency and retries

The preview token represents the submitted settings, current clinic date and the relevant stored day state. Preview includes `conflicts` and `canApply`. Apply rechecks conflicts inside a MongoDB transaction before checking the preview token. A newly conflicting booking returns `409 APPOINTMENT_CONFLICT` with safe date/time details; other stale changes require a fresh preview. All selected day updates and the successful application receipt commit together; conflicts and other failures do not leave a partly updated month or a successful receipt.

The new `monthlyScheduleApplications` collection stores one receipt per request UUID, including the payload hash, result and timestamp. Retrying the same request returns the original result without rewriting dates or undoing a subsequent edit. Reusing a request UUID with different settings is rejected. The frontend retains the original request after an uncertain network response so its retry remains safe.

Apply requires MongoDB transaction support and a unique date index on `appointments`. It fails safely if those are unavailable. This follows the project's existing transactional treatment-plan infrastructure; no new environment variables, cron jobs or WhatsApp templates are needed.

## Verification

Backend tests live in `tests/monthlySchedule/`; browser tests and the isolated harness live in `tests/e2e/monthlySchedule/`. The browser harness bundles the real components, mocks API responses and forbids external services. Backend integration tests use temporary local MongoDB instances, never the production database.

Run:

```text
npx vitest run tests/monthlySchedule
node tests/e2e/monthlySchedule/run.cjs
```

These checks establish local behavior, not deployment state. The owner reviews and pushes the local changes.

The core revision passed 2,138 unit/regression tests and 75 browser checks. The subsequent UI cleanup passed 72 planner/calendar browser checks across desktop, tablet and phone, plus component lint. Its backend was unchanged. The verification details are recorded in its implementation plan.

# Monthly Schedule Planner Implementation Plan

**Historical initial plan:** the later [monthly schedule revision](2026-10-23-monthly-schedule-revision.md) supersedes its preservation option, add/delete time rows, appointment-conflict policy and saved-state/viewport behavior.

> **For agentic workers:** Use superpowers:subagent-driven-development to implement the tasks below. User has authorized local implementation on main; do not commit, push, deploy, or contact live services.

**Goal:** Add an independent Arabic monthly weekday schedule editor directly below the existing monthly blocker.

**Architecture:** A new client panel previews weekday groups through an authenticated read-only API. An authenticated apply endpoint checks that preview against current data and saves all selected dates in one MongoDB transaction, preserving appointments. Existing booking semantics and the old monthly blocker stay unchanged.

**Tech Stack:** Existing JavaScript/JSX, Next.js, React, Tailwind, MongoDB, Vitest and cached browser test tools; no new dependencies.

**Spec:** User request in this conversation: preserve `حظر أوقات لشهر كامل`; add separate flexible monthly weekday editing and blocking below it.

## Global constraints

- Do not modify `src/components/admin/MonthlyBlocker.jsx` or `src/app/api/appointments/block-month/route.js`.
- Preserve existing booked appointments, appointment duration checks, and exact-start blocking semantics. A blocked start does not represent a blocked time interval.
- Apply only selected weekdays of the selected month. Past dates are skipped using Asia/Jerusalem. Today may be edited. Never change other weekdays or months.
- Preview before apply; changes to form invalidate preview. Default preserves days already customized, with explicit replace option.
- Full-day closure blocks every effective offered start, including starts with existing appointments; it never cancels appointments.
- No `.env.local`, live database, provider calls, or new dependencies. Local main only; no commits/pushes.

## Shared API contract

POST `/api/admin/monthly-schedule/preview`:

```json
{"month":"2026-11","groups":[{"weekdays":[1,3],"mode":"times","times":["10:00","11:00","14:00"],"blockedTimes":["14:00"]},{"weekdays":[5],"mode":"closed"}],"excludedDates":[],"customizedDays":"preserve"}
```

- Weekdays use Sunday=0 to Saturday=6. Between 1 and 7 groups, no overlapping weekdays; each group has at least one weekday.
- Times: 1..40 unique strict HH:mm starts, within existing 10:00..19:30 inclusive. Blocked times must be a unique subset. Closed groups omit times/blockedTimes.
- Exclusions are unique valid dates in the selected month. Policy is `preserve` or `replace`.
- Preview returns `{previewToken, days, summary}`. Token is a SHA256 digest of canonical intent, clinic date, and current relevant day state (including appointments), suitable for a stale-state guard, not an authorization credential.
- Each day: `{date, groupIndex, status, previousTimes, previousBlockedTimes, nextTimes, nextBlockedTimes, appointmentCount, affectedAppointmentCount}`. Status: `apply`, `past`, `excluded`, `customized`, or `invalid` (malformed legacy day data).
- Summary: `{apply, skipped, existingAppointments, affectedAppointments}`. Counts concern selected days; affected means booked starts removed or blocked by the proposal, without cancelling them.
- Customized means existing nonempty editedTimes or blockedTimes. Invalid legacy data must not be silently overwritten. Preview exposes no customer personal data.
- Full closure uses the day's effective schedule and blocks all of it; preserve hidden existing block values as well. Normal edit replaces both schedule arrays.

POST `/api/admin/monthly-schedule/apply`: same intent plus `{requestId, previewToken}`. requestId is stable UUID for retries of one attempt. Return `{success:true, requestId, summary, appliedDates}`. An idempotent replay returns original result without reapplying.

- Errors use `{error:CODE,message:...}`. Relevant codes: `INVALID_SCHEDULE` (400), `NO_DATES_TO_APPLY` (400), `SCHEDULE_CHANGED` (409), `REQUEST_ID_REUSED` (409), `TRANSACTIONS_REQUIRED` (503), `SCHEDULE_STORAGE_UNAVAILABLE` (503), plus existing auth errors.
- Apply checks unique date index and fails safely if unavailable; requires transactions, no partial fallback. Receipt in `monthlyScheduleApplications` keyed by UUID, with payload hash and result, written atomically with schedule arrays. Repeated/concurrent same UUID returns original receipt; different intent cannot reuse UUID. Re-read current preview inside transaction; stale => 409. Day writes preserve appointments and unknown metadata.
- Both routes require withAdminRoute and private/no-store responses including auth failures.

## Tasks

- [x] Backend: write failing validation/preview/transaction/auth tests; implement separate rules/service/routes. Use isolated memory replica set for atomicity, duplicate requests, stale previews, and concurrent booking coverage. Lazy production DB resolution with injected db/client/now for tests.
- [x] Frontend: independent `MonthlySchedulePlanner` below old blocker. Month; weekday chips; add/remove groups; select remaining weekdays; mode; editable time rows with lock icons; add/remove starts; preservation policy; preview/exclude dates; apply. Arabic, responsive, accessible labels/icons, existing loading component. Invalidate previews on edit. Handle stale, errors, retry with same UUID after uncertain response, duplicate clicks. Browser tests with isolated harness, no Next dev/env/services.
- [x] Integration: refresh manual booking availability on `appointments:changed`; new planner dispatches event only after confirmed apply. DailyCalendar already listens.
- [x] Review and verification: inspect implementation, targeted/full unit suites, desktop/tablet/mobile browser coverage, lint changed sources, verify old hashes unchanged.
- [x] Document new panel and add overview pointer without duplicating old blocker explanation.

## Review focus

- Days customized by the old blocker are preserved by default; replacement must be explicit and previewed.
- Simultaneous booking/day edits invalidate preview or conflict atomically; never erase bookings or partly update month.
- Closure retains blocked booked starts after later cancellation; empty editedTimes must never accidentally reopen a day.
- A lost apply response can be retried without overwriting subsequent edits; retain the original UUID and payload until resolved.
- Mobile controls remain operable, errors visible, and preview counts align with exclusions and selected weekdays.

## Baseline fingerprints

- MonthlyBlocker.jsx SHA256: E0359F304A4D2CBE29824EB747A4904DA0C8E97A8FCC33142B4BCA7A5EC93BCA
- block-month/route.js SHA256: 62C8A2139ACCEC698ACF90150C2303538C1ABA3BE4075FD55E49C468F6810397

## Progress ledger

- Planning: user authorized implementation directly, existing main worktree clean at 004325380da10f49dd9960bf4e068aa6bffefa37.
- Ruling: preserve exact-start blocking rather than introduce duration ranges, because changing shared booking behavior would broaden scope and affect the old section.
- Ruling: separate sibling section and separate APIs; existing appointments remain even when their starts are blocked or removed.
- Backend implemented in rules/service modules plus a shared route boundary. Read-only independent review found no material blockers. Existing full unique date indexes are accepted regardless of name; missing/incompatible indexes fail safely if uniqueness cannot be established.
- Frontend and booking refresh implemented. Browser regression first reproduced the missing refresh, then passed after the listener was added. Retry regressions cover lost responses, stale previews and authentication loss after an uncertain result.
- Final verification: `npm run test:run -- --maxWorkers=1` passed 2,107 tests in 61 files. The initial two-worker run had one existing Firebase runtime test exceed its 5-second timeout; that test passed alone and the complete sequential rerun passed without code changes.
- `node tests/e2e/monthlySchedule/run.cjs` passed all 33 desktop/tablet/mobile checks. Filled desktop/mobile preview screenshots inspected; no horizontal clipping. Changed-source ESLint and `git diff --check` passed.
- Both original SHA256 fingerprints still match; branch remains `main` at the original HEAD. No commits, pushes, deployment, live services or production database writes.

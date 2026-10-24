# Return reminder UI checks

Run `node tests/e2e/returnReminders/run.cjs` from the project root. Optional Playwright arguments, such as `--project=mobile`, are forwarded.

The harness bundles the real JSX components and stylesheet without starting Next or loading environment files. It uses the existing browser/runtime resolver in `../firebaseOtpV2/runtime.cjs`; no package installation is attempted. The server binds only to `127.0.0.1`, denies outbound connections and backend dependencies, and the browser blocks every non-local request. APIs are fulfilled locally by each test. No database, provider, cron, or deployment is touched.

Desktop, tablet and mobile checks cover manual-only unsubscribe, loading, invalid/used links, failed read/write retry, repeated clicks, default-enabled status without a consent claim or write on load, consent attestation to re-enable an explicitly disabled preference, disable, failed persistence, and permission reset across customer navigation.

The custom schedule cases cover saved selection, immediate default persistence, day/month limits, independent consent, stale revision recovery, and late responses after navigation. Private comment cases cover multiple entries, accessible edit/delete controls, literal long text, retained drafts, idempotent add retries and explicit refresh after conflicts. Every request stays inside the isolated mock API. Screenshots are written under this folder's `artifacts/results`.

The independently loaded status row uses the real API shape for latest attendance, latest attempt and the next eligible daily opportunity. Tests check clinic timezone formatting, refresh after saved consent/schedule changes, paused states, load failure/retry, and safe navigation while status is pending. Status reads cannot block settings or comment editing.

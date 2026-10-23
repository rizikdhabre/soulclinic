# Return reminder UI checks

Run `node tests/e2e/returnReminders/run.cjs` from the project root. Optional Playwright arguments, such as `--project=mobile`, are forwarded.

The harness bundles the real JSX components and stylesheet without starting Next or loading environment files. It uses the existing browser/runtime resolver in `../firebaseOtpV2/runtime.cjs`; no package installation is attempted. The server binds only to `127.0.0.1`, denies outbound connections and backend dependencies, and the browser blocks every non-local request. APIs are fulfilled locally by each test. No database, provider, cron, or deployment is touched.

Desktop, tablet and mobile checks cover manual-only unsubscribe, loading, invalid/used links, failed read/write retry, repeated clicks, default-enabled status without a consent claim or write on load, consent attestation to re-enable an explicitly disabled preference, disable, failed persistence, and permission reset across customer navigation. Screenshots are written under this folder's `artifacts/results`.

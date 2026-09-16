# Frontend Contract Note For Parent / Galileo

Ownership: Task5 only writes `tests/e2e/firebaseOtpV2/**` and `playwright.otp.config.cjs`.
No agent/thread messaging tool was exposed in this session. Galileo target supplied by parent:
`01a091aa-31f0-72e1-97ad-111ecff89a0c`. This note records the contracts for coordination.

The suite imports the CURRENT real `LoginPage`, `AppointmentForm`, `usePhoneOtp`,
`otp/client`, `firebaseClient`, `firebaseSendPolicy`, `bookingFormFlow`, and application CSS.
Only `firebase/app`, `firebase/auth`, and `next/navigation` are intercepted at bundle time.
The real Firebase adapter's return shape is NOT patched or flattened by the harness.

Observed integration issue during initial inspection: `firebaseClient.confirm` returned
`{ credential, user, idToken }` but `otp/client.runComplete` expected a string. The browser
success and recovery tests deliberately require these real modules to interoperate.
This was fixed by concurrent frontend work before the successful smoke run: the real
adapter now returns the token string. Task5 did not alter production files.

Wire mocks follow the current client: challenge `{provider,providerPolicy,phone,challengeToken}`;
firebase-send reserve `{provider:'firebase',phone,firebaseSendId,status:'reserved'}`;
accepted `{provider:'firebase',status:'pending'}`; fallback `{provider:'twilio',status:'pending'}`;
complete sends `idToken` (Firebase) or `code` (Twilio), with endpoint-scoped recovery receipts.
Booking success supplies a synthetic grant and records the `onSubmit` callback in memory.
Form-only tests disallow appointment API requests. Full-page booking UI tests now explicitly
opt in to Playwright-intercepted appointment reads/writes; responses and submission records
are in memory only. No request reaches an application server or creates an appointment.
The exact shop redirect is also fulfilled locally to prevent outbound navigation.

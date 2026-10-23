const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { defineConfig } = require(resolveRuntime('playwright/test'));
if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.RETURN_REMINDER_TEST_BASE_URL || '')) throw new Error('Use node tests/e2e/returnReminders/run.cjs');
module.exports = defineConfig({
  testDir: __dirname, testMatch: '**/*.spec.cjs', outputDir: './artifacts/results',
  workers: 1, retries: 0, timeout: 20000, expect: { timeout: 4000 }, reporter: 'list',
  use: { baseURL: process.env.RETURN_REMINDER_TEST_BASE_URL, headless: true, serviceWorkers: 'block', timezoneId: 'America/Los_Angeles', screenshot: 'only-on-failure', trace: 'retain-on-failure' },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'tablet', use: { viewport: { width: 820, height: 1180 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true } },
  ],
});

const path = require('node:path');
const { resolveRuntime } = require('./tests/e2e/firebaseOtpV2/runtime.cjs');
const { defineConfig } = require(resolveRuntime('playwright/test'));

if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(process.env.OTP_TEST_BASE_URL || '')) {
  throw new Error('Run node tests/e2e/firebaseOtpV2/run.cjs. An isolated loopback harness is required.');
}

module.exports = defineConfig({
  testDir: './tests/e2e/firebaseOtpV2',
  testMatch: '**/*.spec.cjs',
  outputDir: './tests/e2e/firebaseOtpV2/artifacts/results',
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 20000,
  expect: { timeout: 5000 },
  reporter: [
    ['list'],
    ['json', { outputFile: path.join(__dirname, 'tests/e2e/firebaseOtpV2/artifacts/report.json') }],
  ],
  use: {
    baseURL: process.env.OTP_TEST_BASE_URL,
    browserName: 'chromium',
    headless: true,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 } },
  ],
});

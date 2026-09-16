const { resolveRuntime } = require('./runtime.cjs');
const { test: base, expect } = require(resolveRuntime('playwright/test'));

const PHONE = '0501234567';
const NORMALIZED = '+972501234567';
const OTHER_PHONE = '0527654321';
const OTHER_NORMALIZED = '+972527654321';
const CODE = '123456';

const test = base.extend({
  otp: async ({ page, context, baseURL }, use) => {
    const requests = [];
    const unexpected = [];
    const pageErrors = [];
    const challenges = new Map();
    const shopNavigations = [];
    const appointmentRequests = [];
    const holds = new Map();
    const config = { provider: 'firebase', cooldown: 60, profileComplete: true };
    page.on('pageerror', error => pageErrors.push(error.message));
    const count = (endpoint, operation) => requests.filter(item => item.endpoint === endpoint && (!operation || item.body.operation === operation));
    const deadline = () => ({ serverTime: '2030-01-01T00:00:00.000Z', retryAt: new Date(Date.parse('2030-01-01T00:00:00Z') + config.cooldown * 1000).toISOString(), retryAfterSeconds: config.cooldown });
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname;
      const block = async () => { unexpected.push(`${request.method()} ${url.origin}${endpoint}`); await route.abort('blockedbyclient'); };
      if (request.isNavigationRequest() && request.method() === 'GET' && url.href === 'https://www.soulperfume.co/shop') {
        shopNavigations.push(url.href);
        return route.fulfill({ status: 200, contentType: 'text/html', body: '<h1>Isolated shop destination</h1>' });
      }
      if (url.origin !== baseURL) return block();
      if (request.method() === 'GET' && ['/login', '/booking', '/both', '/appointments', '/harness.js', '/styles.css', '/health'].includes(endpoint)) return route.continue();
      if (config.allowBookingApi && endpoint === '/api/appointments') {
        if (request.method() === 'GET') return route.fulfill({ json: { appointments: [], blockedTimes: [], editedTimes: [] } });
        if (request.method() === 'POST') {
          appointmentRequests.push(request.postDataJSON());
          if (holds.has('appointment')) await holds.get('appointment').promise;
          if (config.bookingConflict) return route.fulfill({ status: 409, json: { error: 'TIME_SLOT_UNAVAILABLE' } });
          return route.fulfill({ json: { success: true } });
        }
      }
      if (request.method() !== 'POST' || !['/api/otp/challenge', '/api/otp/firebase-send', '/api/otp/fallback', '/api/otp/send', '/api/otp/complete'].includes(endpoint)) return block();
      const body = request.postDataJSON();
      requests.push({ endpoint, body });
      const holdKey = body.operation || endpoint.split('/').pop();
      if (holds.has(holdKey)) await holds.get(holdKey).promise;
      const reply = async (json, status = 200) => route.fulfill({ status, json });
      if (endpoint === '/api/otp/challenge') {
        const id = challenges.size + 1;
        const challenge = { challengeToken: `mock-challenge-${id}`, phone: body.phone, purpose: body.purpose, provider: config.provider, providerPolicy: config.provider === 'firebase' ? 'firebase_first' : 'twilio_only', correlationId: `00000000-0000-4000-8000-${String(id).padStart(12, '0')}` };
        challenges.set(challenge.challengeToken, challenge);
        return reply({ ...challenge, ...deadline(), expiresAt: '2030-01-01T00:10:00Z' });
      }
      const challenge = challenges.get(body.challengeToken);
      if (!challenge) return reply({ error: 'OTP_CHALLENGE_FAILED' }, 400);
      if (endpoint === '/api/otp/firebase-send') {
        if (body.operation === 'diagnostic') return reply({ recorded: true });
        if (body.operation === 'accepted' && config.acceptedFailures > 0) {
          config.acceptedFailures -= 1;
          return reply({ error: 'OTP_PERSISTENCE_FAILED' }, 503);
        }
        const status = { reserve: 'reserved', status: 'reserved', accepted: 'pending', rejected: 'failed' }[body.operation];
        if (!status) return block();
        return reply({ provider: 'firebase', phone: challenge.phone, firebaseSendId: `reservation:${body.challengeToken}`, status, ...deadline() });
      }
      if (endpoint === '/api/otp/fallback') {
        if (config.fallbackFailures > 0) {
          config.fallbackFailures -= 1;
          return reply({ error: 'OTP_PERSISTENCE_FAILED', recoveryReceipt: 'mock-fallback-receipt' }, 503);
        }
        challenge.provider = 'twilio';
        return reply({ provider: 'twilio', status: 'pending', ...deadline() });
      }
      if (endpoint === '/api/otp/send') return reply({ provider: 'twilio', status: 'pending', ...deadline() });
      if (challenge.provider === 'firebase' && (body.idToken !== `mock-id-token:${challenge.phone}` || 'code' in body)) return reply({ error: 'OTP_VERIFICATION_INVALID' }, 400);
      if (challenge.provider === 'twilio' && (body.code !== CODE || 'idToken' in body)) return reply({ error: 'INVALID_OTP' }, 400);
      if (config.completionFailures > 0) {
        config.completionFailures -= 1;
        return reply({ error: config.completionError || 'OTP_PERSISTENCE_FAILED', recoveryReceipt: 'mock-complete-receipt',
          ...(config.firebaseFallbackAllowed ? { firebaseFallbackAllowed: true } : {}) }, 503);
      }
      return reply({
        success: true, purpose: challenge.purpose,
        ...(challenge.purpose === 'booking' ? {
          verificationToken: `mock-booking-grant:${body.challengeToken}`,
          profile: config.profileComplete ? { hasCompleteName: true, firstName: 'Test', lastName: 'Only' } : { hasCompleteName: false },
        } : {}),
      });
    });
    const api = {
      requests, unexpected, config, count, shopNavigations, appointmentRequests,
      hold(key) {
        let release;
        const promise = new Promise(resolve => { release = resolve; });
        holds.set(key, { promise, release });
      },
      release(key) { holds.get(key)?.release(); holds.delete(key); },
      async open(purpose, scenario = {}) {
        await page.addInitScript(scenario => {
          window.__otpTest = { scenario, sdk: { sends: [], confirms: [], tokens: 0, construct: 0, clear: 0, signOut: 0, containers: [] }, navigation: [], submissions: [] };
        }, scenario);
        await page.goto(purpose === 'appointments' ? '/appointments?duration=20&price=180&title=Test' : `/${purpose}`);
        if (purpose === 'appointments') await expect(page.getByRole('heading', { name: 'حجز موعد', exact: true })).toBeVisible();
        else await expect(page.locator('input[inputmode="tel"]').first()).toBeVisible();
      },
      ui(purpose) {
        const scope = page.getByTestId(purpose);
        return {
          scope,
          phone: scope.locator('input[inputmode="tel"]'),
          code: scope.locator('input[autocomplete="one-time-code"]'),
          send: scope.getByRole('button', { name: purpose === 'login' ? 'إرسال رمز التحقق' : 'تأكيد الموعد', exact: true }),
          verify: scope.getByRole('button', { name: purpose === 'login' ? 'تأكيد الرمز' : 'التحقق وحفظ الموعد', exact: true }),
          back: scope.getByRole('button', { name: purpose === 'login' ? 'رجوع' : 'تغيير الرقم', exact: true }),
          resend: scope.getByRole('button', { name: /إعادة|^جاري الإرسال\.\.\.$/ }),
          recover: scope.getByRole('button', { name: 'التحقق من حالة الإرسال', exact: true }),
        };
      },
      async start(purpose) {
        const ui = api.ui(purpose);
        await ui.phone.fill(PHONE); await ui.send.click();
        await expect(ui.code).toBeVisible();
        await expect(ui.back).toBeEnabled();
        return ui;
      },
      async verify(purpose, code = CODE) {
        const ui = api.ui(purpose);
        await ui.code.fill(code); await ui.verify.click();
      },
      async success(purpose) {
        if (purpose === 'login') await expect.poll(() => page.evaluate(() => window.__otpTest.navigation)).toEqual(['/userAppointments']);
        else {
          await expect(page.getByRole('heading', { name: 'تم تأكيد الموعد بنجاح', exact: true })).toBeVisible();
          await expect.poll(() => page.evaluate(() => window.__otpTest.submissions.length)).toBe(1);
        }
      },
      snapshot: () => page.evaluate(() => ({ sdk: window.__otpTest.sdk, navigation: window.__otpTest.navigation, submissions: window.__otpTest.submissions })),
      async screenshot(name, testInfo) {
        await page.screenshot({ path: testInfo.outputPath(`${name}.png`), fullPage: true, animations: 'disabled' });
      },
    };
    await use(api);
    for (const hold of holds.values()) hold.release();
    expect(unexpected, 'Unexpected outbound, appointment, or API request').toEqual([]);
    expect(pageErrors, 'Uncaught application errors').toEqual([]);
  },
});

module.exports = { test, expect, PHONE, NORMALIZED, OTHER_PHONE, OTHER_NORMALIZED, CODE };

const { test, expect, PHONE, NORMALIZED, OTHER_PHONE, OTHER_NORMALIZED, CODE } = require('./fixtures.cjs');

for (const purpose of ['login', 'booking']) {
  test.describe(purpose, () => {
    test('Firebase success uses real adapter proof and no appointment HTTP request', async ({ page, otp }, testInfo) => {
      await otp.open(purpose); await otp.start(purpose);
      await otp.screenshot(`${purpose}-code`, testInfo);
      await otp.verify(purpose); await otp.success(purpose);
      const { sdk, submissions } = await otp.snapshot();
      expect(sdk.sends).toEqual([NORMALIZED]); expect(sdk.confirms).toEqual([CODE]); expect(sdk.tokens).toBe(1);
      expect(otp.count('/api/otp/complete')[0].body).toEqual({ challengeToken: 'mock-challenge-1', purpose, idToken: `mock-id-token:${NORMALIZED}` });
      expect(otp.count('/api/otp/fallback')).toHaveLength(0);
      expect(otp.count('/api/otp/send')).toHaveLength(0);
      if (purpose === 'booking') expect(submissions[0]).toMatchObject({ phone: NORMALIZED, firstName: 'Test', lastName: 'Only', verificationToken: 'mock-booking-grant:mock-challenge-1' });
      await otp.screenshot(`${purpose}-success`, testInfo);
      expect(await page.evaluate(() => Object.keys(localStorage))).toEqual([]);
    });

    test('settled technical send rejection transfers once with Arabic fallback status', async ({ page, otp }, testInfo) => {
      otp.hold('fallback');
      await otp.open(purpose, { sendError: 'auth/internal-error' });
      const ui = otp.ui(purpose); await ui.phone.fill(PHONE); await ui.send.click();
      await expect(ui.scope.getByRole('status')).toContainText('الخدمة البديلة');
      expect(otp.count('/api/otp/fallback')).toHaveLength(1);
      await otp.screenshot(`${purpose}-fallback`, testInfo);
      otp.release('fallback'); await expect(ui.back).toBeEnabled();
      await otp.verify(purpose); await otp.success(purpose);
      expect((await otp.snapshot()).sdk.confirms).toEqual([]);
      expect(otp.count('/api/otp/fallback')[0].body).toMatchObject({ challengeToken: 'mock-challenge-1', firebaseSendId: 'reservation:mock-challenge-1', failure: { code: 'auth/internal-error', stage: 'send', provenance: 'firebase_sdk' } });
      expect(otp.count('/api/otp/complete')[0].body).toEqual({ challengeToken: 'mock-challenge-1', purpose, code: CODE });
      expect(otp.count('/api/otp/send')).toHaveLength(0);
    });

    test('reCAPTCHA technical failure falls back before SDK SMS send', async ({ otp }) => {
      await otp.open(purpose, { renderError: 'auth/network-request-failed' });
      await otp.start(purpose); await otp.verify(purpose); await otp.success(purpose);
      expect((await otp.snapshot()).sdk.sends).toEqual([]);
      expect(otp.count('/api/otp/fallback')[0].body.failure).toEqual({ code: 'recaptcha/network-request-failed', stage: 'recaptcha_render', provenance: 'recaptcha_sdk' });
    });

    test('wrong code stays Firebase and a corrected code succeeds', async ({ otp }) => {
      await otp.open(purpose); const ui = await otp.start(purpose);
      await otp.verify(purpose, '000000');
      await expect(ui.scope.getByText('رمز التحقق غير صحيح. حاول مرة أخرى.', { exact: true })).toBeVisible();
      expect(otp.count('/api/otp/fallback')).toHaveLength(0); expect(otp.count('/api/otp/complete')).toHaveLength(0);
      await otp.verify(purpose); await otp.success(purpose);
      expect((await otp.snapshot()).sdk.confirms).toEqual(['000000', CODE]);
    });

    test('expired code never initiates fallback', async ({ otp }) => {
      await otp.open(purpose, { confirmError: 'auth/code-expired' }); const ui = await otp.start(purpose);
      await otp.verify(purpose); await expect(ui.verify).toBeEnabled();
      await expect(ui.scope.getByText(/انتهت صلاحية رمز التحقق/)).toBeVisible();
      expect(otp.count('/api/otp/fallback')).toHaveLength(0); expect(otp.count('/api/otp/complete')).toHaveLength(0);
    });

    test('quota rejection is not eligible for fallback', async ({ otp }) => {
      await otp.open(purpose, { sendError: 'auth/quota-exceeded' }); const ui = await otp.start(purpose);
      await expect(ui.scope.getByText(/خدمة الرسائل تقيّد الطلبات/)).toBeVisible();
      expect(otp.count('/api/otp/firebase-send', 'rejected')).toHaveLength(1);
      expect(otp.count('/api/otp/fallback')).toHaveLength(0);
    });

    test('completion recovery uses cached proof and scoped receipt without reconfirmation', async ({ otp }) => {
      otp.config.completionFailures = 1;
      await otp.open(purpose); const ui = await otp.start(purpose);
      await otp.verify(purpose); await expect(ui.verify).toBeEnabled();
      await expect(ui.scope.getByText(/تعذر حفظ حالة التحقق/)).toBeVisible();
      await otp.verify(purpose); await otp.success(purpose);
      expect(otp.count('/api/otp/complete')).toHaveLength(2);
      expect(otp.count('/api/otp/complete')[1].body).toEqual({ ...otp.count('/api/otp/complete')[0].body, recoveryReceipt: 'mock-complete-receipt' });
      const { sdk } = await otp.snapshot(); expect(sdk.confirms).toEqual([CODE]); expect(sdk.tokens).toBe(1); expect(sdk.sends).toHaveLength(1);
    });

    test('token fetch recovery keeps credential and never sends fallback', async ({ otp }) => {
      await otp.open(purpose, { tokenFailures: 1 }); const ui = await otp.start(purpose);
      await otp.verify(purpose); await expect(ui.verify).toBeEnabled();
      expect(otp.count('/api/otp/complete')).toHaveLength(0);
      await otp.verify(purpose); await otp.success(purpose);
      const { sdk } = await otp.snapshot(); expect(sdk.confirms).toEqual([CODE]); expect(sdk.tokens).toBe(2);
      expect(otp.count('/api/otp/fallback')).toHaveLength(0);
    });

    test('cached proof completion retries are bounded to three requests', async ({ otp }) => {
      otp.config.completionFailures = 10;
      await otp.open(purpose); const ui = await otp.start(purpose);
      for (let i = 0; i < 3; i += 1) { await otp.verify(purpose); await expect(ui.verify).toBeEnabled(); }
      expect(otp.count('/api/otp/complete')).toHaveLength(3);
      await otp.verify(purpose); await expect(ui.verify).toBeEnabled();
      expect(otp.count('/api/otp/complete')).toHaveLength(3);
      expect((await otp.snapshot()).sdk.confirms).toEqual([CODE]);
      await expect(ui.scope.getByText(/انتهت صلاحية رمز التحقق/)).toBeVisible();
    });

    test('cached proof expires after five minutes without reconfirmation or fallback', async ({ page, otp }) => {
      otp.config.completionFailures = 1;
      await page.clock.install(); await otp.open(purpose); const ui = await otp.start(purpose);
      await otp.verify(purpose); await expect(ui.verify).toBeEnabled();
      expect(otp.count('/api/otp/complete')).toHaveLength(1);
      await page.clock.fastForward(300100);
      await otp.verify(purpose); await expect(ui.verify).toBeEnabled();
      await expect(ui.scope.getByText(/انتهت صلاحية رمز التحقق/)).toBeVisible();
      expect(otp.count('/api/otp/complete')).toHaveLength(1);
      expect(otp.count('/api/otp/fallback')).toHaveLength(0);
      expect((await otp.snapshot()).sdk.confirms).toEqual([CODE]);
    });

    test('accepted-state recovery replays acknowledgement, never SDK send', async ({ otp }) => {
      otp.config.acceptedFailures = 1;
      await otp.open(purpose); const ui = await otp.start(purpose);
      await expect(ui.resend).toBeEnabled(); await ui.resend.click(); await expect(ui.back).toBeEnabled();
      expect(otp.count('/api/otp/challenge')).toHaveLength(1);
      expect(otp.count('/api/otp/firebase-send', 'reserve')).toHaveLength(1);
      expect(otp.count('/api/otp/firebase-send', 'accepted')).toHaveLength(2);
      expect((await otp.snapshot()).sdk.sends).toHaveLength(1);
      await otp.verify(purpose); await otp.success(purpose);
    });

    test('fallback recovery replays same reservation and receipt', async ({ otp }) => {
      otp.config.fallbackFailures = 1;
      await otp.open(purpose, { sendError: 'auth/network-request-failed' }); const ui = await otp.start(purpose);
      await expect(ui.resend).toBeEnabled(); await ui.resend.click(); await expect(ui.back).toBeEnabled();
      const calls = otp.count('/api/otp/fallback'); expect(calls).toHaveLength(2);
      expect(calls[1].body).toEqual({ ...calls[0].body, recoveryReceipt: 'mock-fallback-receipt' });
      expect(otp.count('/api/otp/challenge')).toHaveLength(1);
      expect((await otp.snapshot()).sdk.sends).toHaveLength(1);
      await otp.verify(purpose); await otp.success(purpose);
    });

    test('phone change invalidates code but preserves original phone deadline', async ({ otp }) => {
      await otp.open(purpose); const ui = await otp.start(purpose);
      await ui.code.fill(CODE); await ui.back.click();
      await expect(ui.scope.getByRole('button', { name: /انتظر/ })).toBeDisabled();
      await ui.phone.fill(OTHER_PHONE); await ui.send.click(); await expect(ui.back).toBeEnabled();
      await expect(ui.code).toHaveValue('');
      await otp.verify(purpose); await otp.success(purpose);
      expect((await otp.snapshot()).sdk.sends).toEqual([NORMALIZED, OTHER_NORMALIZED]);
      expect(otp.count('/api/otp/complete')[0].body).toMatchObject({ challengeToken: 'mock-challenge-2', idToken: `mock-id-token:${OTHER_NORMALIZED}` });
    });

    test('equivalent phone formatting preserves pending challenge identity', async ({ page, otp }) => {
      otp.hold('challenge'); await otp.open(purpose); const ui = otp.ui(purpose);
      await ui.phone.fill(PHONE); await ui.send.click();
      await expect.poll(() => otp.count('/api/otp/challenge').length).toBe(1);
      // A physical phone edit remains possible on login; booking exposes a blocking send dialog.
      await ui.phone.fill('+972 50-123-4567', { force: true });
      otp.release('challenge'); await expect(ui.code).toBeVisible(); await expect(ui.back).toBeEnabled();
      await otp.verify(purpose); await otp.success(purpose);
      expect((await otp.snapshot()).sdk.sends).toEqual([NORMALIZED]);
      expect(otp.count('/api/otp/challenge')).toHaveLength(1);
    });

    test('late challenge response for a changed phone is ignored', async ({ otp }) => {
      otp.hold('challenge'); await otp.open(purpose); const ui = otp.ui(purpose);
      await ui.phone.fill(PHONE); await ui.send.click();
      await expect.poll(() => otp.count('/api/otp/challenge').length).toBe(1);
      await ui.phone.fill(OTHER_PHONE, { force: true });
      otp.release('challenge'); await expect(ui.send).toBeEnabled();
      expect((await otp.snapshot()).sdk.sends).toEqual([]); await expect(ui.code).toHaveCount(0);
      await ui.send.click(); await expect(ui.back).toBeEnabled();
      await otp.verify(purpose); await otp.success(purpose);
      expect((await otp.snapshot()).sdk.sends).toEqual([OTHER_NORMALIZED]);
    });

    test('resend observes absolute deadline and creates one new challenge', async ({ page, otp }) => {
      await page.clock.install(); await otp.open(purpose); const ui = await otp.start(purpose);
      await expect(ui.resend).toBeDisabled();
      await page.clock.fastForward(58000); await expect(ui.resend).toBeDisabled();
      expect(otp.count('/api/otp/challenge')).toHaveLength(1);
      await page.clock.fastForward(2100); await expect(ui.resend).toBeEnabled();
      await ui.resend.click(); await expect(ui.back).toBeEnabled();
      expect(otp.count('/api/otp/challenge')).toHaveLength(2); expect((await otp.snapshot()).sdk.sends).toHaveLength(2);
    });

    test('visibility foreground recalculates cooldown without another send', async ({ page, otp }) => {
      await page.clock.install({ time: new Date('2030-01-01T00:00:00Z') });
      await otp.open(purpose); const ui = await otp.start(purpose);
      await page.clock.pauseAt(new Date('2030-01-01T00:00:05Z'));
      await expect(ui.resend).toBeDisabled();
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
      await page.clock.setSystemTime(new Date('2030-01-01T00:02:00Z'));
      await page.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); });
      await expect(ui.resend).toBeEnabled();
      expect(otp.count('/api/otp/challenge')).toHaveLength(1); expect((await otp.snapshot()).sdk.sends).toHaveLength(1);
    });

    test('double clicks coalesce send and verification in flight', async ({ page, otp }) => {
      otp.hold('challenge'); otp.hold('complete'); await otp.open(purpose); const ui = otp.ui(purpose);
      await ui.phone.fill(PHONE);
      await ui.send.evaluate(button => { button.click(); button.click(); });
      await expect.poll(() => otp.count('/api/otp/challenge').length).toBe(1);
      otp.release('challenge'); await expect(ui.back).toBeEnabled(); await ui.code.fill(CODE);
      await ui.verify.evaluate(button => { button.click(); button.click(); });
      await expect.poll(() => otp.count('/api/otp/complete').length).toBe(1);
      expect((await otp.snapshot()).sdk.confirms).toEqual([CODE]);
      otp.release('complete'); await otp.success(purpose);
      expect(otp.count('/api/otp/challenge')).toHaveLength(1); expect(otp.count('/api/otp/complete')).toHaveLength(1);
    });

    test('hanging SDK send remains pending and late success never runs parallel fallback', async ({ page, otp }, testInfo) => {
      await page.clock.install(); await otp.open(purpose, { sendDeferred: true }); const ui = otp.ui(purpose);
      await ui.phone.fill(PHONE); await ui.send.click();
      await expect.poll(async () => (await otp.snapshot()).sdk.sends.length).toBe(1);
      await page.clock.fastForward(31000);
      await expect(ui.scope.getByRole('status')).toContainText('قيد الانتظار');
      await expect(ui.back).toBeDisabled(); await expect(ui.resend).toBeDisabled();
      expect(otp.count('/api/otp/fallback')).toHaveLength(0); expect(otp.count('/api/otp/firebase-send', 'accepted')).toHaveLength(0);
      await otp.screenshot(`${purpose}-pending`, testInfo);
      await page.evaluate(() => window.__otpTest.releaseSend()); await expect(ui.back).toBeEnabled();
      expect(otp.count('/api/otp/firebase-send', 'accepted')).toHaveLength(1); expect(otp.count('/api/otp/fallback')).toHaveLength(0);
    });

    test('unmount ignores late send result and releases owned container', async ({ page, otp }) => {
      await otp.open(purpose, { sendDeferred: true }); const ui = otp.ui(purpose);
      await ui.phone.fill(PHONE); await ui.send.click();
      await expect.poll(async () => (await otp.snapshot()).sdk.sends.length).toBe(1);
      await page.evaluate(() => window.__otpTest.unmount());
      await page.evaluate(() => window.__otpTest.releaseSend());
      await expect.poll(async () => (await otp.snapshot()).sdk.clear).toBe(1);
      expect(otp.count('/api/otp/firebase-send', 'accepted')).toHaveLength(0); expect(otp.count('/api/otp/fallback')).toHaveLength(0);
      expect((await otp.snapshot()).navigation).toEqual([]); expect((await otp.snapshot()).submissions).toEqual([]);
    });

    test('unmount ignores late verification and cannot complete application action', async ({ page, otp }) => {
      await otp.open(purpose, { confirmDeferred: true }); await otp.start(purpose); await otp.verify(purpose);
      await expect.poll(async () => (await otp.snapshot()).sdk.confirms.length).toBe(1);
      await page.evaluate(() => window.__otpTest.unmount()); await page.evaluate(() => window.__otpTest.releaseConfirm());
      expect(otp.count('/api/otp/complete')).toHaveLength(0); expect((await otp.snapshot()).navigation).toEqual([]); expect((await otp.snapshot()).submissions).toEqual([]);
    });

    test('viewport fits and recaptcha root remains identical through code and reset', async ({ page, otp }, testInfo) => {
      await otp.open(purpose);
      const selector = `[id^="otp-${purpose}-"]`;
      await page.evaluate(selector => { window.__otpTest.originalRoot = document.querySelector(selector); }, selector);
      const ui = await otp.start(purpose);
      expect(await page.evaluate(selector => window.__otpTest.originalRoot === document.querySelector(selector), selector)).toBe(true);
      expect(await page.locator(selector).count()).toBe(1);
      const width = await ui.scope.boundingBox();
      await ui.code.fill(CODE);
      await expect(ui.verify).toBeEnabled();
      await ui.verify.hover();
      expect((await ui.scope.boundingBox()).width).toBe(width.width);
      const overflow = await page.evaluate(() => Array.from(document.querySelectorAll('main input, main button, main textarea, main p, main h2')).filter(element => {
        const box = element.getBoundingClientRect();
        return box.width && (box.left < -1 || box.right > innerWidth + 1 || element.scrollWidth > element.clientWidth + 2);
      }).map(element => element.tagName + ':' + element.textContent.slice(0, 70)));
      expect(overflow).toEqual([]);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await otp.screenshot(`${purpose}-layout`, testInfo);
      await ui.back.click();
      expect(await page.evaluate(selector => window.__otpTest.originalRoot === document.querySelector(selector), selector)).toBe(true);
      await expect(ui.phone).toBeVisible();
    });

    test('twilio-only rollback never initializes Firebase SDK', async ({ otp }) => {
      otp.config.provider = 'twilio'; await otp.open(purpose); await otp.start(purpose);
      await otp.verify(purpose); await otp.success(purpose);
      const { sdk } = await otp.snapshot(); expect(sdk.sends).toEqual([]); expect(sdk.construct).toBe(0);
      expect(otp.count('/api/otp/firebase-send')).toHaveLength(0); expect(otp.count('/api/otp/fallback')).toHaveLength(0); expect(otp.count('/api/otp/send')).toHaveLength(1);
    });
  });
}

test('login and booking reCAPTCHA containers have distinct stable ownership', async ({ page, otp }) => {
  await otp.open('both');
  await otp.start('login'); await otp.start('booking');
  const roots = await page.locator('[id^="otp-"]').evaluateAll(elements => elements.map(element => element.id));
  expect(roots).toHaveLength(2); expect(new Set(roots).size).toBe(2);
  expect((await otp.snapshot()).sdk.containers).toEqual(roots);
  await otp.ui('login').back.click();
  await expect(otp.ui('booking').code).toBeVisible();
  await otp.verify('booking'); await otp.success('booking');
});

test('booking incomplete profile requires details and records only one in-memory submission', async ({ page, otp }) => {
  otp.config.profileComplete = false; await otp.open('booking'); await otp.start('booking'); await otp.verify('booking');
  await expect(page.getByPlaceholder('الاسم الأول')).toBeVisible();
  expect((await otp.snapshot()).submissions).toEqual([]);
  await page.getByPlaceholder('الاسم الأول').fill('Synthetic'); await page.getByPlaceholder('اسم العائلة').fill('Test');
  await page.getByRole('button', { name: 'حفظ الموعد', exact: true }).click(); await otp.success('booking');
  expect((await otp.snapshot()).submissions[0]).toMatchObject({ firstName: 'Synthetic', lastName: 'Test' });
});

test('unmocked local server rejects API writes and never serves environment files', async ({ request, baseURL }) => {
  expect(new URL(baseURL).hostname).toBe('127.0.0.1');
  const health = await request.get('/health');
  expect(await health.json()).toEqual({ isolated: true, sdkMocked: true, productionComponents: true });
  const write = await request.post('/api/otp/complete', { data: { challengeToken: 'synthetic-safety-probe' } });
  expect(write.status()).toBe(405);
  expect(await write.text()).toBe('No API or database exists in this harness');
  expect((await request.get('/.env.local')).status()).toBe(404);
});

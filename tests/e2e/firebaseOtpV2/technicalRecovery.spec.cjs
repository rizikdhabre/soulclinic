const { test, expect, CODE } = require('./fixtures.cjs');

for (const purpose of ['login', 'booking']) {
  test(`${purpose} a trusted Admin infrastructure permit requests a fresh Twilio code`, async ({ otp }) => {
    otp.config.completionFailures = 1;
    otp.config.completionError = 'OTP_VERIFY_TEMPORARY_FAILURE';
    otp.config.firebaseFallbackAllowed = true;
    await otp.open(purpose); const ui = await otp.start(purpose);
    await otp.verify(purpose);
    await expect(ui.scope.getByText('أدخل الرمز الجديد المرسل عبر الخدمة البديلة.', { exact: true })).toBeVisible();
    await expect(ui.code).toHaveValue('');
    expect(otp.count('/api/otp/fallback')).toHaveLength(1);
    await otp.verify(purpose); await otp.success(purpose);
    const completions = otp.count('/api/otp/complete');
    expect(completions).toHaveLength(2);
    expect(completions[0].body).toHaveProperty('idToken');
    expect(completions[1].body).not.toHaveProperty('idToken');
    expect(completions[1].body).not.toHaveProperty('recoveryReceipt');
  });
  test(`${purpose} acknowledgement outage reconciles before confirmation recovery transfers ownership`, async ({ otp }) => {
    otp.config.acceptedFailures = 1;
    await otp.open(purpose, { confirmError: 'auth/network-request-failed' });
    const ui = await otp.start(purpose);
    await otp.verify(purpose);
    await expect(ui.scope.getByText('أدخل الرمز الجديد المرسل عبر الخدمة البديلة.', { exact: true })).toBeVisible();
    expect(otp.count('/api/otp/firebase-send', 'accepted')).toHaveLength(2);
    expect(otp.count('/api/otp/fallback')).toHaveLength(1);
    await otp.verify(purpose); await otp.success(purpose);
  });
  test(`${purpose} identified SDK module loading failure falls back before Firebase dispatch`, async ({ otp }) => {
    await otp.open(purpose, { sdkLoadError: true });
    await otp.start(purpose);
    expect(otp.count('/api/otp/fallback')).toHaveLength(1);
    expect(otp.count('/api/otp/fallback')[0].body.failure).toEqual({ code: 'client/module-load-failed', stage: 'initialize', provenance: 'client' });
    expect((await otp.snapshot()).sdk.sends).toHaveLength(0);
    await otp.verify(purpose); await otp.success(purpose);
  });
  test(`${purpose} technical confirmation transfers to Twilio and requires a new code`, async ({ page, otp }, testInfo) => {
    await otp.open(purpose, { confirmError: 'auth/network-request-failed' });
    const ui = await otp.start(purpose);
    otp.hold('fallback');
    await otp.verify(purpose);
    await expect(ui.scope.getByRole('status')).toContainText('الخدمة البديلة');
    await expect(ui.code).toHaveCount(0);
    expect(otp.count('/api/otp/complete')).toHaveLength(0);
    otp.release('fallback');
    await expect(ui.code).toBeVisible();
    await expect(ui.code).toHaveValue('');
    await expect(ui.scope.getByText('أدخل الرمز الجديد المرسل عبر الخدمة البديلة.', { exact: true })).toBeVisible();
    await otp.screenshot(`${purpose}-technical-fallback-code`, testInfo);
    expect(otp.count('/api/otp/fallback')).toHaveLength(1);
    await otp.verify(purpose, CODE);
    await otp.success(purpose);
    expect(otp.count('/api/otp/complete')).toHaveLength(1);
    expect(otp.count('/api/otp/complete')[0].body).not.toHaveProperty('idToken');
    expect((await otp.snapshot()).sdk.confirms).toHaveLength(1);
  });

  test(`${purpose} non-receipt requires cooldown then switches once without verifying old code`, async ({ page, otp }) => {
    await otp.open(purpose);
    const ui = await otp.start(purpose);
    const alternative = ui.scope.getByRole('button', { name: 'لم يصلني الرمز، أرسله عبر الخدمة البديلة', exact: true });
    await expect(alternative).toBeDisabled();
    await page.clock.install(); await page.clock.fastForward(61000);
    await expect(alternative).toBeEnabled();
    await alternative.click();
    await expect(ui.code).toBeVisible();
    await expect(alternative).toHaveCount(0);
    expect(otp.count('/api/otp/fallback')).toHaveLength(1);
    expect(otp.count('/api/otp/challenge')).toHaveLength(1);
    expect((await otp.snapshot()).sdk.confirms).toHaveLength(0);
    await otp.verify(purpose); await otp.success(purpose);
  });

  test(`${purpose} wrong code cannot unlock alternative-provider sending`, async ({ page, otp }) => {
    otp.config.cooldown = 0;
    await otp.open(purpose); await otp.start(purpose);
    await otp.verify(purpose, '000000');
    await expect(otp.ui(purpose).scope.getByText('رمز التحقق غير صحيح. حاول مرة أخرى.', { exact: true })).toBeVisible();
    await expect(otp.ui(purpose).scope.getByRole('button', { name: 'لم يصلني الرمز، أرسله عبر الخدمة البديلة', exact: true })).toBeDisabled();
    expect(otp.count('/api/otp/fallback')).toHaveLength(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

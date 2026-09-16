const { test, expect, PHONE, CODE } = require('./fixtures.cjs');

async function pickDate(page) {
  const calendar = page.getByRole('region', { name: 'اختيار التاريخ', exact: true });
  await calendar.getByRole('button', { name: /^\d+$/ }).and(page.locator(':enabled')).last().click();
}

async function inScrollPosition(locator) {
  await expect.poll(() => locator.evaluate(element => {
    const { top } = element.getBoundingClientRect();
    return top >= 70 && top < 200;
  })).toBe(true);
}

test('booking journey reveals and scrolls to each step without remounting verification', async ({ page, otp }, testInfo) => {
  otp.config.allowBookingApi = true;
  await otp.open('appointments');
  const ui = otp.ui('booking');
  await expect(ui.phone).toBeHidden();
  await expect(page.getByRole('heading', { name: 'الأوقات المتاحة', exact: true })).toBeHidden();
  const root = await ui.scope.locator('[id^="otp-"]').elementHandle();
  await otp.screenshot('booking-calendar-only', testInfo);
  await pickDate(page);
  const times = page.getByRole('region', { name: 'اختيار الوقت', exact: true });
  await expect(times).toBeVisible();
  await inScrollPosition(times);
  await expect(ui.phone).toBeHidden();
  await otp.screenshot('booking-times', testInfo);
  await times.getByRole('button', { name: '10:30', exact: true }).click();
  const form = page.getByRole('region', { name: 'تأكيد الموعد', exact: true });
  await expect(ui.phone).toBeVisible();
  await inScrollPosition(form);
  await otp.screenshot('booking-phone', testInfo);
  await ui.phone.fill(PHONE); await ui.send.click();
  await expect(ui.code).toBeFocused();
  const otherDate = page.getByRole('region', { name: 'اختيار التاريخ', exact: true })
    .getByRole('button', { name: /^\d+$/ }).and(page.locator(':enabled')).first();
  await otherDate.click();
  await expect(ui.code).toBeHidden();
  await expect(times).toBeVisible();
  expect(await root.evaluate(element => element.isConnected)).toBe(true);
  expect(otp.count('/api/otp/challenge')).toHaveLength(1);
  expect(otp.appointmentRequests).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('booking waiting card remains until acceptance then focuses the code on send and resend', async ({ page, otp }, testInfo) => {
  otp.config.cooldown = 0;
  await otp.open('booking', { sendDeferred: true });
  const ui = otp.ui('booking');
  const root = await ui.scope.locator('[id^="otp-"]').elementHandle();
  await ui.phone.fill(PHONE); await ui.send.click();
  const waiting = ui.scope.getByRole('status');
  await expect(waiting).toContainText('يرجى الانتظار');
  await expect(waiting.getByRole('img', { name: 'جارٍ الإرسال' })).toBeVisible();
  await expect(ui.code).toHaveCount(0);
  await expect(ui.scope.getByRole('dialog')).toHaveCount(0);
  await expect.poll(async () => (await otp.snapshot()).sdk.sends.length).toBe(1);
  await otp.screenshot('booking-waiting-card', testInfo);
  await page.evaluate(() => window.__otpTest.releaseSend());
  await expect(ui.code).toBeFocused();
  await expect(waiting).toHaveCount(0);
  await otp.screenshot('booking-focused-code', testInfo);
  await ui.resend.click();
  await expect(waiting).toContainText('يرجى الانتظار');
  await expect.poll(async () => (await otp.snapshot()).sdk.sends.length).toBe(2);
  await page.evaluate(() => window.__otpTest.releaseSend());
  await expect(ui.code).toBeFocused();
  expect(await root.evaluate(element => element.isConnected)).toBe(true);
  expect(otp.count('/api/otp/complete')).toHaveLength(0);
});

test('booking fallback retains the waiting card without opening code entry early', async ({ otp }) => {
  otp.hold('fallback');
  await otp.open('booking', { sendError: 'auth/error-code:-39' });
  const ui = otp.ui('booking');
  await ui.phone.fill(PHONE); await ui.send.click();
  await expect(ui.scope.getByRole('status')).toContainText('الخدمة البديلة');
  await expect(ui.scope.getByRole('status')).toContainText('يرجى الانتظار');
  await expect(ui.code).toHaveCount(0);
  otp.release('fallback');
  await expect(ui.code).toBeFocused();
  expect(otp.count('/api/otp/fallback')).toHaveLength(1);
});

test('booking confirms in Arabic with a checkmark before navigating to the exact shop URL', async ({ page, otp }, testInfo) => {
  otp.config.allowBookingApi = true;
  await otp.open('appointments'); await pickDate(page);
  await page.getByRole('button', { name: '10:30', exact: true }).click();
  await otp.start('booking');
  await page.clock.install();
  otp.hold('complete');
  await otp.verify('booking');
  await page.clock.fastForward(4000);
  expect(otp.shopNavigations).toEqual([]);
  expect(otp.appointmentRequests).toHaveLength(0);
  otp.release('complete');
  const confirmation = page.getByRole('status');
  await expect(confirmation).toContainText('تم تأكيد الموعد بنجاح');
  await expect(confirmation.getByRole('img', { name: 'تم تأكيد الموعد' })).toBeVisible();
  expect(otp.appointmentRequests).toHaveLength(1);
  expect(otp.appointmentRequests[0]).toMatchObject({ time: '10:30', duration: 20, price: 180, verificationToken: 'mock-booking-grant:mock-challenge-1' });
  expect(otp.shopNavigations).toEqual([]);
  await otp.screenshot('booking-confirmed', testInfo);
  await page.clock.fastForward(3100);
  await expect(page).toHaveURL('https://www.soulperfume.co/shop');
  expect(otp.shopNavigations).toEqual(['https://www.soulperfume.co/shop']);
});

test('booking failure and incomplete profile never show success or redirect', async ({ page, otp }) => {
  otp.config.profileComplete = false;
  await otp.open('booking', { bookingFailure: true });
  await otp.start('booking'); await otp.verify('booking', CODE);
  await expect(page.getByPlaceholder('الاسم الأول')).toBeVisible();
  await page.clock.install(); await page.clock.fastForward(4000);
  expect(otp.shopNavigations).toEqual([]);
  await page.getByPlaceholder('الاسم الأول').fill('Test');
  await page.getByPlaceholder('اسم العائلة').fill('Only');
  await page.getByRole('button', { name: 'حفظ الموعد', exact: true }).click();
  await page.clock.fastForward(4000);
  await expect(page.getByRole('heading', { name: 'تم تأكيد الموعد بنجاح', exact: true })).toHaveCount(0);
  expect(otp.shopNavigations).toEqual([]);
  expect((await otp.snapshot()).submissions).toHaveLength(1);
});

test('unmounting the booking success screen cancels its redirect', async ({ page, otp }) => {
  await otp.open('booking'); await otp.start('booking');
  await page.clock.install();
  await otp.verify('booking'); await otp.success('booking');
  await page.evaluate(() => window.__otpTest.unmount());
  await page.clock.fastForward(4000);
  expect(otp.shopNavigations).toEqual([]);
});

test('booking guided steps respect reduced motion and fit a narrow screen', async ({ page, otp }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 320, height: 640 });
  await page.addInitScript(() => {
    window.__scrollCalls = [];
    const scroll = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function(options) {
      window.__scrollCalls.push(options);
      return scroll.call(this, options);
    };
  });
  otp.config.allowBookingApi = true;
  await otp.open('appointments'); await pickDate(page);
  await page.getByRole('button', { name: '10:30', exact: true }).click();
  await otp.start('booking');
  await expect(otp.ui('booking').code).toBeFocused();
  const calls = await page.evaluate(() => window.__scrollCalls);
  expect(calls.length).toBeGreaterThanOrEqual(3);
  expect(calls.every(options => options.behavior !== 'smooth')).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('calendar month animation never widens the mobile viewport', async ({ page, otp }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    window.__overflowFrames = [];
    function sample(time) {
      if (document.documentElement.scrollWidth > innerWidth) window.__overflowFrames.push(document.documentElement.scrollWidth);
      if (time < 2500) requestAnimationFrame(sample);
      else window.__samplingDone = true;
    }
    requestAnimationFrame(sample);
  });
  await otp.open('appointments');
  await page.getByRole('region', { name: 'اختيار التاريخ', exact: true }).getByRole('button').nth(1).click();
  await expect.poll(() => page.evaluate(() => window.__samplingDone)).toBe(true);
  expect(await page.evaluate(() => window.__overflowFrames)).toEqual([]);
});

test('booking rejection removes the waiting card and never opens code entry', async ({ page, otp }) => {
  await otp.open('booking', { sendDeferred: true });
  const ui = otp.ui('booking');
  await ui.phone.fill(PHONE); await ui.send.click();
  await expect(ui.scope.getByRole('status')).toContainText('يرجى الانتظار');
  await expect.poll(async () => (await otp.snapshot()).sdk.sends.length).toBe(1);
  await page.evaluate(() => window.__otpTest.rejectSend('auth/too-many-requests'));
  await expect(ui.scope.getByText(/خدمة الرسائل تقيّد الطلبات/)).toBeVisible();
  await expect(ui.scope.getByRole('status')).toHaveCount(0);
  await expect(ui.code).toHaveCount(0);
  await expect(ui.phone).toBeVisible();
  expect(otp.count('/api/otp/fallback')).toHaveLength(0);
});

test('booking conflict returns to times and preserves the grant for a different slot', async ({ page, otp }) => {
  otp.config.allowBookingApi = true; otp.config.bookingConflict = true;
  await otp.open('appointments'); await pickDate(page);
  await page.getByRole('button', { name: '10:30', exact: true }).click();
  await otp.start('booking'); await otp.verify('booking');
  await expect(page.getByRole('region', { name: 'تأكيد الموعد', exact: true })).toBeHidden();
  const times = page.getByRole('region', { name: 'اختيار الوقت', exact: true });
  await inScrollPosition(times);
  await expect(times.getByRole('alert')).toContainText('هذه الساعة تم حجزها للتو');
  expect(otp.shopNavigations).toEqual([]);
  otp.config.bookingConflict = false;
  await times.getByRole('button', { name: '11:00', exact: true }).click();
  await page.getByRole('button', { name: 'إعادة محاولة حفظ الموعد', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'تم تأكيد الموعد بنجاح', exact: true })).toBeVisible();
  expect(otp.appointmentRequests).toHaveLength(2);
  expect(otp.appointmentRequests[1]).toMatchObject({ time: '11:00', verificationToken: otp.appointmentRequests[0].verificationToken });
  expect(otp.count('/api/otp/complete')).toHaveLength(1);
  expect((await otp.snapshot()).sdk.confirms).toHaveLength(1);
});

test('date and time selection stay locked while saving and showing confirmation', async ({ page, otp }) => {
  otp.config.allowBookingApi = true;
  otp.hold('appointment');
  await otp.open('appointments'); await pickDate(page);
  await page.getByRole('button', { name: '10:30', exact: true }).click();
  await otp.start('booking'); await otp.verify('booking');
  await expect.poll(() => otp.appointmentRequests.length).toBe(1);
  await expect(page.getByRole('region', { name: 'اختيار التاريخ', exact: true }).getByRole('button', { disabled: false })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'اختيار الوقت', exact: true }).getByRole('button', { disabled: false })).toHaveCount(0);
  expect(otp.shopNavigations).toEqual([]);
  otp.release('appointment');
  await expect(page.getByRole('status')).toContainText('تم تأكيد الموعد بنجاح');
  await expect(page.getByRole('status')).toContainText('10:30');
  await expect(page.getByRole('region', { name: 'اختيار التاريخ', exact: true }).getByRole('button', { disabled: false })).toHaveCount(0);
  expect(otp.appointmentRequests).toHaveLength(1);
});

const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { test, expect } = require(resolveRuntime('playwright/test'));

test('customer name opens their profile while existing name editing remains available', async ({ page }) => {
  await page.route('**/*', route => new URL(route.request().url()).origin === process.env.PROFILE_TEST_BASE_URL ? route.continue() : route.abort());
  await page.goto('/users');
  await expect(page.getByRole('link', { name: 'ليلى أحمد' }).filter({ visible: true })).toHaveAttribute('href', '/admin/users/customer-one');
  await page.getByRole('button', { name: /تعديل الاسم|تغيير الاسم/ }).filter({ visible: true }).click();
  await expect(page.getByPlaceholder('الاسم الأول').filter({ visible: true })).toHaveValue('ليلى');
});

const feedback = 'تحسنت حالتي بعد الجلسة.\n' + 'كلمةطويلة'.repeat(100) + '\n' + 'هذه ملاحظتي التفصيلية.\n'.repeat(120) + '<img src=x onerror=alert(1)>';
const profile = {
  user: { _id: 'customer-one', firstName: 'ليلى', lastName: 'أحمد', phone: '0500000000' },
  appointments: [
    { _id: 'older', title: 'جلسة أقدم', date: '2026-08-01', time: '10:00', price: 100, attended: false, feedback: null, isPast: true },
    { _id: 'recent', title: 'جلسة حديثة', date: '2026-09-20', time: '11:00', price: 150, attended: true, feedback: { text: feedback, submittedAt: '2026-09-28T12:00:00Z' }, isPast: true },
    { _id: 'future', title: 'جلسة قادمة', date: '2030-01-15', time: '14:00', price: 150, attended: false, feedback: null, isPast: false },
  ], plans: [],
};
const catalog = [{ _id: 'treatment-one', title: 'العلاج الطبيعي', services: [{ title: 'جلسة كاملة', duration: 60, price: 150 }, { title: 'جلسة قصيرة', duration: 30, price: 80, cupsCount: 0 }] }];

async function mockApi(page, overrides = {}) {
  const calls = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== process.env.PROFILE_TEST_BASE_URL) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push({ path: url.pathname, method: request.method(), body: request.method() === 'POST' ? request.postDataJSON() : null });
    const fulfill = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (overrides.handle && await overrides.handle({ route, request, url, fulfill, calls })) return;
    if (url.pathname === '/api/admin/users/customer-one') return fulfill(profile);
    if (url.pathname === '/api/admin/users/customer-one/return-reminders') return fulfill({ enabled: false });
    if (url.pathname === '/api/admin/treatments') return fulfill(catalog);
    if (url.pathname === '/api/appointments') {
      expect(url.searchParams.get('admin')).toBe('true');
      return fulfill({ appointments: [{ time: '13:00', duration: 60 }], blockedTimes: ['15:00'], editedTimes: [] });
    }
    if (url.pathname.endsWith('/treatment-plans')) return fulfill({ success: true, planId: 'plan-one', appointmentIds: ['new-one'], notification: { status: 'not_configured' } });
    if (url.pathname.startsWith('/api/feedback/')) return fulfill(request.method() === 'GET' ? { appointment: { title: 'جلسة كاملة', date: '2026-09-20', time: '11:00' }, submitted: false } : { success: true });
    return fulfill({ error: 'UNEXPECTED_REQUEST' }, 500);
  });
  return calls;
}

async function fillRow(page, index, time, date = '2030-01-20') {
  const row = page.getByRole('group', { name: `الموعد ${index + 1}`, exact: true });
  await row.getByRole('combobox', { name: 'القسم', exact: true }).selectOption('treatment-one');
  await row.getByRole('combobox', { name: 'العلاج', exact: true }).selectOption('0');
  await row.getByLabel('التاريخ', { exact: true }).fill(date);
  await expect(row.getByRole('combobox', { name: 'الساعة', exact: true })).toBeEnabled();
  await row.getByRole('combobox', { name: 'الساعة', exact: true }).selectOption(time);
  return row;
}

test('history is latest first and attendance is read only; full long feedback stays contained and keyboard accessible', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'ليلى أحمد' })).toBeVisible();
  const history = page.getByRole('region', { name: 'المواعيد السابقة' });
  await expect(history).toContainText('حضر');
  await expect(history).toContainText('لم يحضر');
  expect(await history.getByRole('checkbox').count()).toBe(0);
  expect(await history.getByRole('switch').count()).toBe(0);
  const text = await history.innerText();
  expect(text.indexOf('جلسة حديثة')).toBeLessThan(text.indexOf('جلسة أقدم'));
  expect(text).not.toContain('جلسة قادمة');
  const opener = history.getByRole('button', { name: /عرض الملاحظة كاملة/ });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'ملاحظة الزبون' });
  await expect(dialog).toBeVisible();
  expect(await dialog.locator('[data-feedback-text]').textContent()).toBe(feedback);
  expect(await dialog.locator('img').count()).toBe(0);
  const close = dialog.getByRole('button', { name: 'إغلاق' });
  await expect(close).toBeFocused();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('feedback-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await page.screenshot({ path: testInfo.outputPath('customer-profile.png'), fullPage: true });
});

test('plan uses preselected customer and excludes local duration overlap; notification failure leaves saved plan protected', async ({ page }) => {
  const calls = await mockApi(page);
  await page.goto('/profile');
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'إضافة موعد' }).click();
  const second = await fillRow(page, 1, '11:00');
  const choices = await second.getByRole('combobox', { name: 'الساعة', exact: true }).locator('option').allTextContents();
  expect(choices).not.toContain('10:00');
  expect(choices).not.toContain('10:30');
  expect(choices).not.toContain('12:30');
  expect(choices).not.toContain('15:00');
  expect(choices).toContain('11:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'تم حفظ البرنامج' })).toContainText('لم تُرسل');
  expect(calls.filter(call => call.path.endsWith('/treatment-plans'))).toHaveLength(1);
  const payload = calls.find(call => call.path.endsWith('/treatment-plans')).body;
  expect(payload.requestId).toMatch(/^[a-f0-9-]{36}$/);
  expect(payload.appointments).toEqual([
    { treatmentId: 'treatment-one', serviceIndex: 0, expectedService: { title: 'جلسة كاملة', duration: 60, price: 150, cupsCount: null }, date: '2030-01-20', time: '10:00' },
    { treatmentId: 'treatment-one', serviceIndex: 0, expectedService: { title: 'جلسة كاملة', duration: 60, price: 150, cupsCount: null }, date: '2030-01-20', time: '11:00' },
  ]);
  expect(calls.some(call => /lookup/.test(call.path))).toBe(false);
  await expect(page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' })).toBeHidden();
});

test('uncertain result retries exact payload and request ID; failed profile refresh cannot repeat booking', async ({ page }) => {
  let submissions = 0;
  const calls = await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (url.pathname.endsWith('/treatment-plans')) {
      submissions++;
      if (submissions === 1) { await fulfill({ error: 'TREATMENT_PLAN_OUTCOME_UNKNOWN' }, 503); return true; }
      await fulfill({ success: true, planId: 'plan-one', appointmentIds: ['new-one'], notification: { status: 'unknown' } }); return true;
    }
    if (url.pathname === '/api/admin/users/customer-one' && submissions > 1 && request.method() === 'GET') { await fulfill({ error: 'TEMPORARY_FAILURE' }, 503); return true; }
    return false;
  } });
  await page.goto('/profile');
  const row = await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect(row.getByLabel('التاريخ', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'التحقق وإعادة المحاولة بأمان' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'تم حفظ البرنامج' })).toBeVisible();
  await expect(page.getByText('تعذر تحديث قائمة المواعيد. البرنامج محفوظ.')).toBeVisible();
  const submitted = calls.filter(call => call.path.endsWith('/treatment-plans'));
  expect(submitted).toHaveLength(2);
  expect(submitted[1].body).toEqual(submitted[0].body);
  await expect(page.getByRole('button', { name: 'التحقق وإعادة المحاولة بأمان' })).toBeHidden();
});

test('conflicting row is identified and can be changed without losing other appointments', async ({ page }) => {
  await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (!url.pathname.endsWith('/treatment-plans')) return false;
    await fulfill({ error: 'TIME_SLOT_UNAVAILABLE', rowIndex: 1 }, 409); return true;
  } });
  await page.goto('/profile');
  const first = await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'إضافة موعد' }).click();
  const second = await fillRow(page, 1, '11:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect(page.getByRole('alert').filter({ hasText: 'الموعد 2' })).toBeVisible();
  await expect(first.getByRole('combobox', { name: 'الساعة', exact: true })).toHaveValue('10:00');
  await expect(second.getByLabel('التاريخ', { exact: true })).toBeEnabled();
});

test('public feedback sends long plain text once and shows immutable confirmation', async ({ page }, testInfo) => {
  const calls = await mockApi(page);
  await page.goto('/feedback/private-token');
  const input = page.getByRole('textbox', { name: 'ملاحظتك', exact: true });
  await input.fill(feedback);
  await expect(input).toHaveAttribute('maxlength', '10000');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('public-feedback.png'), fullPage: true });
  await page.getByRole('button', { name: 'إرسال الملاحظة' }).click();
  await expect(page.getByRole('status')).toContainText('شكرًا');
  await expect(input).toBeHidden();
  expect(calls.filter(call => call.method === 'POST').map(call => call.body)).toEqual([{ text: feedback }]);
});

test('used or unavailable feedback links expose no editable form or customer identity', async ({ page }) => {
  let used = false;
  await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (!url.pathname.startsWith('/api/feedback/')) return false;
    if (used) { await fulfill({ appointment: { title: 'جلسة كاملة', date: '2026-09-20', time: '11:00' }, submitted: true }); return true; }
    await fulfill({ error: 'FEEDBACK_UNAVAILABLE' }, 404); return true;
  } });
  await page.goto('/feedback/private-token');
  await expect(page.getByRole('alert')).toContainText('غير متاح');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText('ليلى أحمد')).toHaveCount(0);
  used = true;
  await page.reload();
  await expect(page.getByRole('status')).toContainText('تم استلام ملاحظتك');
  await expect(page.getByRole('textbox')).toHaveCount(0);
  await expect(page.getByText('ليلى أحمد')).toHaveCount(0);
});

test('plan date and start choices follow Israel time even when the browser timezone differs', async ({ page }) => {
  await page.clock.install({ time: new Date('2030-01-20T08:30:00Z') });
  await mockApi(page);
  await page.goto('/profile');
  const row = await fillRow(page, 0, '11:00');
  await expect(row.getByLabel('التاريخ', { exact: true })).toHaveAttribute('min', '2030-01-20');
  const times = await row.getByRole('combobox', { name: 'الساعة', exact: true }).locator('option').allTextContents();
  expect(times).not.toContain('10:00');
  expect(times).not.toContain('10:30');
  expect(times).toContain('11:00');
});

test('a definite unavailable booking service allows editing without claiming uncertain saved appointments', async ({ page }) => {
  await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (!url.pathname.endsWith('/treatment-plans')) return false;
    await fulfill({ error: 'TRANSACTIONS_REQUIRED' }, 503); return true;
  } });
  await page.goto('/profile');
  const row = await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect(page.getByRole('alert')).toContainText('غير متاح مؤقتًا');
  await expect(row.getByLabel('التاريخ', { exact: true })).toBeEnabled();
});

test('catalog reorder after a stale service response requires explicit reselection before another save', async ({ page }) => {
  let stale = false;
  const calls = await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (url.pathname.endsWith('/treatment-plans') && !stale) {
      stale = true;
      await fulfill({ error: 'SERVICE_CHANGED', rowIndex: 0 }, 409);
      return true;
    }
    if (url.pathname === '/api/admin/treatments' && stale) {
      await fulfill([{ ...catalog[0], services: [catalog[0].services[1], catalog[0].services[0]] }]);
      return true;
    }
    return false;
  } });
  await page.goto('/profile');
  const row = await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  const service = row.getByRole('combobox', { name: 'العلاج', exact: true });
  await expect(service).toBeEnabled();
  await expect(service).toHaveValue('');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  expect(calls.filter(call => call.path.endsWith('/treatment-plans'))).toHaveLength(1);
  await service.selectOption({ label: 'جلسة كاملة' });
  await row.getByRole('combobox', { name: 'الساعة', exact: true }).selectOption('10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'تم حفظ البرنامج' })).toBeVisible();
  const payloads = calls.filter(call => call.path.endsWith('/treatment-plans')).map(call => call.body);
  expect(payloads).toHaveLength(2);
  expect(payloads[1].appointments[0].serviceIndex).toBe(1);
  expect(payloads[1].appointments[0].expectedService.title).toBe('جلسة كاملة');
  expect(payloads[1].requestId).not.toBe(payloads[0].requestId);
});

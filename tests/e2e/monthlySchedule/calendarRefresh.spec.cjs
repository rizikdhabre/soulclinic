const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { test, expect } = require(resolveRuntime('playwright/test'));

const defaults = Array.from({ length: 20 }, (_, i) => `${10 + Math.floor(i / 2)}:${i % 2 ? '30' : '00'}`);
function state(month) {
  const days = [];
  const date = new Date(`${month}-01T12:00:00Z`);
  while (date.toISOString().startsWith(month)) {
    days.push({ date: date.toISOString().slice(0, 10), weekday: date.getUTCDay(), times: defaults, blockedTimes: [], appointmentTimes: [], valid: true, customized: false });
    date.setUTCDate(date.getUTCDate() + 1);
  }
  return { month, days };
}
async function setup(page, baseURL, beforeDay) {
  await page.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== baseURL) return route.abort();
    if (url.pathname === '/api/admin/monthly-schedule/state') return route.fulfill({ json: state(url.searchParams.get('month')) });
    if (url.pathname === '/api/appointments') {
      const date = url.searchParams.get('date');
      if (beforeDay && await beforeDay(route, date)) return;
      return route.fulfill({ json: { appointments: [], editedTimes: date === '2026-11-02' ? ['10:15', '11:00'] : [], blockedTimes: date === '2026-11-02' ? ['10:15'] : [] } });
    }
    if (url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  await page.goto('/calendar');
  return page.getByRole('heading', { name: 'المواعيد اليومية', exact: true }).locator('..').locator('..');
}
async function applied(page) {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('appointments:changed', { detail: { month: '2026-11', appliedDates: ['2026-11-02'] } })));
}

test('daily calendar displays the applied month, edited starts and saved blocks after a monthly save', async ({ page, baseURL }) => {
  const calendar = await setup(page, baseURL);
  await expect(calendar.getByText('10:00', { exact: true })).toBeVisible();
  await calendar.getByRole('button', { name: 'تعديل الأوقات', exact: true }).click();
  await expect(calendar.getByRole('button', { name: 'حفظ التغييرات', exact: true })).toBeVisible();
  await applied(page);
  await expect(calendar.getByRole('heading', { name: 'جدول المواعيد بتاريخ November 2, 2026', exact: true })).toBeVisible();
  await expect(calendar.getByRole('button', { name: 'تعديل الأوقات', exact: true })).toBeVisible();
  const blocked = calendar.getByText('10:15', { exact: true }).locator('..').locator('..');
  await expect(blocked).toContainText('محظور');
  await expect(calendar.getByText('11:00', { exact: true })).toBeVisible();
  await expect(calendar.getByText('10:00', { exact: true })).toHaveCount(0);
  await calendar.getByRole('button', { name: '3', exact: true }).first().click();
  await expect(calendar.getByText('10:00', { exact: true })).toBeVisible();
  await calendar.getByRole('button', { name: '2', exact: true }).first().click();
  await expect(calendar.getByText('10:15', { exact: true }).locator('..').locator('..')).toContainText('محظور');
});

test('late availability from the old date cannot overwrite the newly applied day', async ({ page, baseURL }) => {
  const pending = [];
  const calendar = await setup(page, baseURL, async (route, date) => {
    if (date !== '2026-10-23') return false;
    await new Promise(resolve => pending.push(async () => { await route.fulfill({ json: { appointments: [], editedTimes: ['18:00'], blockedTimes: [] } }); resolve(); }));
    return true;
  });
  await expect.poll(() => pending.length).toBeGreaterThan(0);
  await applied(page);
  await expect(calendar.getByText('10:15', { exact: true })).toBeVisible();
  await Promise.all(pending.map(release => release()));
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await expect(calendar.getByText('10:15', { exact: true })).toBeVisible();
  await expect(calendar.getByText('18:00', { exact: true })).toHaveCount(0);
});

for (const outcome of ['success', 'conflict']) {
  test(`combined planner and calendar preserve viewport on ${outcome} with delayed calendar readback`, async ({ page, baseURL }) => {
    let saved = false;
    let releaseCalendar;
    const calendarGate = new Promise(resolve => { releaseCalendar = resolve; });
    const dates = ['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'];
    await page.clock.install({ time: new Date('2026-10-23T12:00:00Z') });
    await page.route('**/*', async route => {
      const url = new URL(route.request().url());
      if (url.origin !== baseURL) return route.abort();
      if (url.pathname === '/api/admin/monthly-schedule/state') {
        const result = state(url.searchParams.get('month'));
        result.days = result.days.map(day => (saved ? dates.includes(day.date) : day.date === dates[0])
          ? { ...day, times: [saved ? '10:15' : '10:05', ...defaults.slice(1)], customized: true } : day);
        return route.fulfill({ json: result });
      }
      if (url.pathname === '/api/admin/monthly-schedule/preview') {
        const body = route.request().postDataJSON();
        return route.fulfill({ json: { previewToken: 'preview-current', canApply: true, conflicts: [], summary: { apply: 5, skipped: 0, existingAppointments: 0, affectedAppointments: 0 }, days: dates.map(date => ({ date, groupIndex: 0, status: 'apply', previousTimes: defaults, previousBlockedTimes: [], nextTimes: body.groups[0].times, nextBlockedTimes: [], appointmentCount: 0, affectedAppointmentCount: 0 })) } });
      }
      if (url.pathname === '/api/admin/monthly-schedule/apply') {
        if (outcome === 'conflict') return route.fulfill({ status: 409, json: { error: 'APPOINTMENT_CONFLICT', conflicts: [{ date: dates[0], time: '10:00' }] } });
        saved = true;
        const body = route.request().postDataJSON();
        return route.fulfill({ json: { success: true, requestId: body.requestId, appliedDates: dates, summary: { apply: 5, skipped: 0, existingAppointments: 0, affectedAppointments: 0 } } });
      }
      if (url.pathname === '/api/appointments') {
        if (saved) await calendarGate;
        return route.fulfill({ json: { appointments: [], editedTimes: saved ? ['10:15', ...defaults.slice(1)] : [], blockedTimes: [] } });
      }
      if (url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    await page.goto('/calendar');
    const planner = page.getByRole('region', { name: 'تنظيم أوقات الشهر', exact: true });
    const calendar = page.getByRole('heading', { name: 'المواعيد اليومية', exact: true }).locator('..').locator('..');
    await planner.getByLabel('الشهر', { exact: true }).fill('2026-11');
    await planner.getByRole('button', { name: 'الاثنين', exact: true }).click();
    await planner.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:15');
    await planner.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
    const apply = planner.getByRole('button', { name: 'تطبيق الجدول', exact: true });
    await expect(apply).toBeEnabled();
    await apply.scrollIntoViewIfNeeded();
    const position = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
    await apply.click();
    await expect(planner).toHaveAttribute('aria-busy', 'false');
    if (outcome === 'success') await expect(planner.getByRole('status')).toContainText('تم تطبيق');
    else await expect(planner.getByRole('alert')).toContainText('مواعيد');
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(position);
    releaseCalendar();
    if (outcome === 'success') {
      await expect(calendar.getByText('10:15', { exact: true })).toHaveCount(1);
      await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
      expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(position);
    }
  });
}

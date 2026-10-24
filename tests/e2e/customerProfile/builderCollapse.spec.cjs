const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { test, expect } = require(resolveRuntime('playwright/test'));

const appointment = { _id: 'existing-one', title: 'جلسة قادمة', date: '2030-01-15', time: '14:00', price: 150, attended: false, bookingNote: '', feedback: null, isPast: false, status: 'upcoming' };
const profile = {
  user: { _id: 'customer-one', firstName: 'ليلى', lastName: 'أحمد', phone: '0500000000' },
  appointments: [appointment],
  plans: [{ _id: '000000000000000000000001', createdAt: '2026-09-01T10:00:00Z', status: 'upcoming', counts: { total: 1, upcoming: 1, attended: 0, notAttended: 0, canceled: 0, unknown: 0 }, notification: { status: 'not_configured' }, appointments: [appointment], comments: [], commentsVersion: 0 }],
  plansPagination: { hasMore: false, nextCursor: null },
};

async function openBuilder(page) {
  const bookings = [];
  await page.route('**/*', route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== process.env.PROFILE_TEST_BASE_URL) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const fulfill = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    if (url.pathname === '/api/admin/users/customer-one') return fulfill(profile);
    if (url.pathname.endsWith('/return-reminders')) return fulfill({ enabled: false, schedule: { mode: 'default' }, scheduleRevision: 0 });
    if (url.pathname.endsWith('/return-reminders/comments')) return fulfill({ comments: [], commentsVersion: 0 });
    if (url.pathname.endsWith('/return-reminders/status')) return fulfill({ lastAttended: null, lastAttemptAt: null, nextReminderAt: null, status: 'no_attendance' });
    if (url.pathname === '/api/admin/treatments') return fulfill([{ _id: 'treatment-one', title: 'العلاج الطبيعي', services: [{ title: 'جلسة كاملة', duration: 60, price: 150 }] }]);
    if (url.pathname === '/api/appointments') return fulfill({ appointments: [], blockedTimes: [], editedTimes: [] });
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'POST') {
      bookings.push(request.postDataJSON());
      return fulfill({ success: true, planId: 'new-plan', appointmentIds: ['new-one'], notification: { status: 'not_configured' } });
    }
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ error: 'UNEXPECTED_REQUEST' }) });
  });
  await page.goto('/profile');
  const builder = page.getByRole('region', { name: 'برنامج علاجي', exact: true });
  const row = builder.getByRole('group', { name: 'الموعد 1', exact: true });
  await row.getByRole('combobox', { name: 'القسم', exact: true }).selectOption('treatment-one');
  await row.getByRole('combobox', { name: 'العلاج', exact: true }).selectOption('0');
  await row.getByLabel('التاريخ', { exact: true }).fill('2030-01-20');
  const time = row.getByRole('combobox', { name: 'الساعة', exact: true });
  await expect(time).toBeEnabled();
  await time.selectOption('10:00');
  return { builder, bookings };
}

test('builder collapse retains its draft independently of appointment and saved-program sections', async ({ page }, testInfo) => {
  const { builder, bookings } = await openBuilder(page);
  const history = page.getByRole('region', { name: 'جميع المواعيد', exact: true });
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة', exact: true });
  const collapse = builder.getByRole('button', { name: 'طي إعداد برنامج علاجي', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  const contentId = await collapse.getAttribute('aria-controls');
  expect(contentId).toBeTruthy();
  const content = page.locator(`[id="${contentId}"]`);
  await expect(content).toBeVisible();
  await collapse.click();
  await expect(content).toBeHidden();
  await expect(content.locator('input[type="date"]')).toHaveValue('2030-01-20');
  await expect(history.getByRole('button', { name: 'طي جميع المواعيد', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(plans.getByRole('button', { name: 'طي البرامج المحفوظة', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await history.getByRole('button', { name: 'طي جميع المواعيد', exact: true }).click();
  await plans.getByRole('button', { name: 'طي البرامج المحفوظة', exact: true }).click();
  const expand = builder.getByRole('button', { name: 'توسيع إعداد برنامج علاجي', exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expand.click();
  const row = builder.getByRole('group', { name: 'الموعد 1', exact: true });
  await expect(row.getByRole('combobox', { name: 'القسم', exact: true })).toHaveValue('treatment-one');
  await expect(row.getByRole('combobox', { name: 'العلاج', exact: true })).toHaveValue('0');
  await expect(row.getByLabel('التاريخ', { exact: true })).toHaveValue('2030-01-20');
  await expect(row.getByRole('combobox', { name: 'الساعة', exact: true })).toHaveValue('10:00');
  await expect(history.getByRole('button', { name: 'توسيع جميع المواعيد', exact: true })).toHaveAttribute('aria-expanded', 'false');
  await expect(plans.getByRole('button', { name: 'توسيع البرامج المحفوظة', exact: true })).toHaveAttribute('aria-expanded', 'false');
  expect(bookings).toHaveLength(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await builder.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('builder-draft-expanded.png') });
});

test('builder collapse retains a successful receipt without submitting another booking', async ({ page }) => {
  const { builder, bookings } = await openBuilder(page);
  await builder.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد', exact: true }).click();
  await expect(builder.getByRole('status')).toContainText('تم حفظ البرنامج بنجاح');
  await builder.getByRole('button', { name: 'طي إعداد برنامج علاجي', exact: true }).click();
  const receipt = builder.getByRole('status', { includeHidden: true });
  await expect(receipt).toBeHidden();
  await expect(receipt).toContainText('تم حفظ البرنامج بنجاح');
  await builder.getByRole('button', { name: 'توسيع إعداد برنامج علاجي', exact: true }).click();
  await expect(receipt).toBeVisible();
  await expect(receipt).toContainText('عدد المواعيد: 1');
  await expect(builder.getByRole('button', { name: 'إنشاء برنامج جديد', exact: true })).toBeVisible();
  await expect(builder.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد', exact: true })).toHaveCount(0);
  expect(bookings).toHaveLength(1);
});

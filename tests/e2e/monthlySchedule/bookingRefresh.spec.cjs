const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { test, expect } = require(resolveRuntime('playwright/test'));

test('manual booking refreshes and clears a selected time after a schedule change', async ({ page, baseURL }) => {
  let closed = false;
  let availabilityReads = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== baseURL) return route.abort();
    if (url.pathname === '/api/admin/treatments') return route.fulfill({ json: [{ _id: 'test-category', title: 'قسم تجريبي', services: [{ title: 'جلسة تجريبية', duration: 30, price: 100 }] }] });
    if (url.pathname === '/api/appointments') {
      availabilityReads++;
      return route.fulfill({ json: { appointments: [], editedTimes: ['10:00', '11:00'], blockedTimes: closed ? ['10:00'] : [] } });
    }
    if (url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  await page.goto('/booking');
  await page.getByRole('combobox', { name: 'اختر القسم', exact: true }).selectOption('test-category');
  await page.getByRole('combobox', { name: 'اختر العلاج', exact: true }).selectOption('0');
  await page.getByLabel('التاريخ', { exact: true }).fill('2030-11-04');
  const time = page.getByRole('combobox', { name: /^الساعة/ });
  await expect(time).toBeEnabled();
  await time.selectOption('10:00');
  const previousReads = availabilityReads;
  closed = true;
  await page.evaluate(() => window.dispatchEvent(new Event('appointments:changed')));
  await expect.poll(() => availabilityReads).toBeGreaterThan(previousReads);
  await expect(time).toHaveValue('');
  await expect(time.locator('option[value="10:00"]')).toHaveCount(0);
  await expect(time.locator('option[value="11:00"]')).toHaveCount(1);
});

test('schedule changes do not fetch availability before a date is chosen', async ({ page, baseURL }) => {
  let availabilityReads = 0;
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== baseURL) return route.abort();
    if (url.pathname === '/api/admin/treatments') return route.fulfill({ json: [] });
    if (url.pathname === '/api/appointments') { availabilityReads++; return route.abort(); }
    if (url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  await page.goto('/booking');
  await expect(page.getByRole('combobox', { name: 'اختر القسم', exact: true })).toBeEnabled();
  await page.evaluate(async () => {
    window.dispatchEvent(new Event('appointments:changed'));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
  expect(availabilityReads).toBe(0);
  await expect(page.getByRole('combobox', { name: /^الساعة/ })).toBeDisabled();
});

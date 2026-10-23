const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { test, expect } = require(resolveRuntime('playwright/test'));

async function mockApi(page, handle = () => null) {
  const calls = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== process.env.RETURN_REMINDER_TEST_BASE_URL) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const call = { path: url.pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null };
    calls.push(call);
    const response = await handle(call);
    const body = response?.body ?? (url.pathname.startsWith('/api/admin/') ? { enabled: call.body?.enabled ?? false } : request.method() === 'GET' ? { unsubscribed: false } : { success: true, unsubscribed: true });
    await route.fulfill({ status: response?.status ?? 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  return calls;
}

test('public link waits for manual confirmation and protects repeated clicks before showing success', async ({ page }, testInfo) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, async call => { if (call.method === 'POST') await pending; });
  await page.goto('/reminders/unsubscribe/private-token');
  const confirm = page.getByRole('button', { name: 'تأكيد إيقاف التذكيرات', exact: true });
  await expect(confirm).toBeVisible();
  expect(calls.some(call => call.method === 'POST')).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('confirm.png'), fullPage: true });
  await confirm.evaluate(button => { button.click(); button.click(); });
  await expect(page.getByRole('button', { name: 'جارٍ إيقاف التذكيرات...' })).toBeDisabled();
  await expect.poll(() => calls.filter(call => call.method === 'POST').length).toBe(1);
  release();
  await expect(page.getByRole('status')).toContainText('تم إيقاف تذكيرات العودة');
  await expect(confirm).toHaveCount(0);
  expect(await page.locator('body').innerText()).not.toContain('private-token');
  await page.screenshot({ path: testInfo.outputPath('success.png'), fullPage: true });
});

test('invalid links and an already stopped preference expose no confirmation or personal data', async ({ page }) => {
  let stopped = false;
  const calls = await mockApi(page, () => stopped ? { body: { unsubscribed: true } } : { status: 404, body: { error: 'RETURN_REMINDER_LINK_UNAVAILABLE' } });
  await page.goto('/reminders/unsubscribe/private-token');
  await expect(page.getByRole('alert')).toContainText('غير صالح');
  await expect(page.getByRole('button')).toHaveCount(0);
  stopped = true;
  await page.reload();
  await expect(page.getByRole('status')).toContainText('تم إيقاف تذكيرات العودة');
  await expect(page.getByRole('button')).toHaveCount(0);
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  expect(await page.locator('body').innerText()).not.toMatch(/private-token|050|ليلى/);
});

test('public load and submit failures can be retried without automatically submitting', async ({ page }) => {
  let failRead = true;
  let failWrite = true;
  const calls = await mockApi(page, call => {
    if (call.method === 'GET' && failRead) return { status: 503, body: { error: 'UNAVAILABLE' } };
    if (call.method === 'POST' && failWrite) return { status: 503, body: { error: 'UNAVAILABLE' } };
  });
  await page.goto('/reminders/unsubscribe/private-token');
  await expect(page.getByRole('alert')).toContainText('تعذر');
  failRead = false;
  await page.getByRole('button', { name: 'إعادة المحاولة', exact: true }).click();
  const confirm = page.getByRole('button', { name: 'تأكيد إيقاف التذكيرات', exact: true });
  await expect(confirm).toBeVisible();
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  await confirm.click();
  await expect(page.getByRole('alert')).toContainText('تعذر');
  await expect(page.getByRole('status')).toHaveCount(0);
  failWrite = false;
  await confirm.click();
  await expect(page.getByRole('status')).toContainText('تم إيقاف تذكيرات العودة');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(2);
});

test('admin permission starts off, requires attestation, guards pending requests and supports disabling', async ({ page }, testInfo) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, async call => { if (call.method === 'PATCH' && call.body.enabled) await pending; });
  await page.goto('/admin');
  const enable = page.getByRole('button', { name: 'تسجيل موافقة الزبون', exact: true });
  const consent = page.getByRole('checkbox', { name: 'أؤكد أن الزبون وافق صراحةً على تلقي تذكيرات العودة عبر واتساب.' });
  await expect(enable).toBeDisabled();
  await expect(consent).not.toBeChecked();
  expect(calls.every(call => call.method === 'GET')).toBe(true);
  await consent.check();
  await enable.evaluate(button => { button.click(); button.click(); });
  await expect(consent).toBeDisabled();
  await expect.poll(() => calls.filter(call => call.method === 'PATCH').length).toBe(1);
  release();
  await expect(page.getByRole('status')).toContainText('موافقة الزبون مسجّلة');
  expect(calls.find(call => call.method === 'PATCH').body).toEqual({ enabled: true, consentConfirmed: true });
  await page.getByRole('button', { name: 'إيقاف تذكيرات العودة', exact: true }).click();
  await expect(enable).toBeDisabled();
  await expect(consent).not.toBeChecked();
  expect(calls.filter(call => call.method === 'PATCH')[1].body).toEqual({ enabled: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('admin-preference.png'), fullPage: true });
});

test('admin load retry and failed save do not report permission as saved', async ({ page }) => {
  let failRead = true;
  let failWrite = true;
  await mockApi(page, call => {
    if (call.method === 'GET' && failRead || call.method === 'PATCH' && failWrite) return { status: 503, body: { error: 'UNAVAILABLE' } };
  });
  await page.goto('/admin');
  await expect(page.getByRole('alert')).toContainText('تعذر');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  failRead = false;
  await page.getByRole('button', { name: 'إعادة المحاولة', exact: true }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: 'تسجيل موافقة الزبون', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('تعذر');
  await expect(page.getByRole('status')).toContainText('متوقفة');
  failWrite = false;
  await page.getByRole('button', { name: 'تسجيل موافقة الزبون', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('موافقة الزبون مسجّلة');
});

test('an existing enabled preference can be disabled without an enrollment checkbox', async ({ page }) => {
  const calls = await mockApi(page, call => call.method === 'GET' ? { body: { enabled: true } } : null);
  await page.goto('/admin');
  await expect(page.getByRole('checkbox')).toHaveCount(0);
  await page.getByRole('button', { name: 'إيقاف تذكيرات العودة', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('متوقفة');
  expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ enabled: false }]);
});

test('permission and consent reset when the profile changes to another customer', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, async call => {
    if (call.path === '/api/admin/treatments') return { body: [] };
    if (/\/api\/admin\/users\/[a-f0-9]{24}$/.test(call.path)) return { body: { user: { firstName: 'زبون', lastName: '', phone: '0500000000' }, appointments: [], plans: [] } };
    if (call.path.endsWith('000022/return-reminders')) await pending;
  });
  await page.goto('/profile-switch');
  const card = page.getByRole('region', { name: 'موافقة الزبون على تذكيرات العودة' });
  await card.getByRole('checkbox').check();
  await expect(card.getByRole('button', { name: 'تسجيل موافقة الزبون' })).toBeEnabled();
  await page.getByRole('button', { name: 'عرض الزبون التالي' }).click();
  await expect(card.getByRole('checkbox')).toHaveCount(0);
  await expect(card.getByRole('status')).toContainText('جارٍ تحميل');
  release();
  await expect(card.getByRole('checkbox')).not.toBeChecked();
  await expect(card.getByRole('button', { name: 'تسجيل موافقة الزبون' })).toBeDisabled();
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});

test('public loading waits for the link check and cannot submit before it resolves', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, async () => { await pending; });
  await page.goto('/reminders/unsubscribe/private-token');
  await expect(page.getByRole('status')).toContainText('جارٍ التحقق');
  await expect(page.getByRole('button')).toHaveCount(0);
  release();
  await expect(page.getByRole('button', { name: 'تأكيد إيقاف التذكيرات' })).toBeVisible();
  expect(calls.every(call => call.method === 'GET')).toBe(true);
});

const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { test, expect } = require(resolveRuntime('playwright/test'));

const first = { _id: '11111111-1111-4111-8111-111111111111', text: 'طلب الزبون مدة مختلفة', revision: 1, createdAt: '2026-10-23T10:00:00Z', updatedAt: '2026-10-23T10:00:00Z' };
const second = { ...first, _id: '22222222-2222-4222-8222-222222222222', text: 'ملاحظة ثانية' };
const card = page => page.getByRole('region', { name: 'تذكيرات العودة عبر واتساب', exact: true });
const comments = page => card(page).getByRole('region', { name: 'تعليقات الإدارة', exact: true });

async function mockApi(page, { schedule = { mode: 'custom', value: 25, unit: 'days' }, enabled = false, initialComments = [first, second], handle } = {}) {
  const state = { enabled, schedule, scheduleRevision: 4, comments: structuredClone(initialComments), commentsVersion: 2 };
  const calls = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== process.env.RETURN_REMINDER_TEST_BASE_URL) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    const call = { path: url.pathname, method: request.method(), body: request.postData() ? request.postDataJSON() : null };
    calls.push(call);
    const fulfill = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (handle && await handle({ call, state, fulfill })) return;
    if (call.path.endsWith('/return-reminders/status')) return fulfill({ lastAttended: { date: '2026-10-01', time: '14:00' }, lastAttemptAt: null, nextReminderAt: state.enabled ? '2026-10-26T17:00:00.000Z' : null, status: state.enabled ? 'scheduled' : 'disabled' });
    if (call.path === '/api/admin/treatments') return fulfill([]);
    if (/\/users\/[^/]+$/.test(call.path)) return fulfill({ user: { firstName: 'زبون', lastName: '', phone: '0500000000' }, appointments: [], plans: [] });
    if (call.path.includes('/comments')) {
      if (call.method === 'POST' && !state.comments.some(item => item._id === call.body.commentId)) state.comments.push({ ...first, _id: call.body.commentId, text: call.body.text });
      if (call.method === 'PATCH') state.comments = state.comments.map(item => call.path.endsWith(item._id) ? { ...item, text: call.body.text, revision: item.revision + 1 } : item);
      if (call.method === 'DELETE') state.comments = state.comments.filter(item => !call.path.endsWith(item._id));
      if (call.method !== 'GET') state.commentsVersion++;
      return fulfill({ comments: state.comments, commentsVersion: state.commentsVersion });
    }
    if (call.method === 'PATCH') {
      if (call.body.schedule) { state.schedule = call.body.schedule; state.scheduleRevision++; }
      if (typeof call.body.enabled === 'boolean') state.enabled = call.body.enabled;
    }
    return fulfill({ enabled: state.enabled, schedule: state.schedule, scheduleRevision: state.scheduleRevision });
  });
  return { state, calls };
}

test('saved custom rule loads and default selection saves only the schedule immediately', async ({ page }, testInfo) => {
  const { calls } = await mockApi(page);
  await page.goto('/admin');
  await expect(card(page).getByRole('radio', { name: 'جدول مخصص', exact: true })).toBeChecked();
  await expect(card(page).getByRole('spinbutton')).toHaveValue('25');
  await expect(card(page).getByRole('combobox')).toHaveValue('days');
  await expect(card(page).getByRole('button', { name: 'حفظ الإعدادات', exact: true })).toBeDisabled();
  await expect(comments(page).getByText(first.text, { exact: true })).toBeVisible();
  const consent = card(page).getByRole('checkbox', { name: 'أؤكد أن الزبون وافق صراحةً على تلقي تذكيرات العودة عبر واتساب.' });
  await consent.check();
  await card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true }).click();
  await expect(card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true })).toBeChecked();
  expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ schedule: { mode: 'default' }, scheduleRevision: 4 }]);
  await expect(card(page)).toContainText('3 أشهر تقويمية');
  await expect(card(page)).toContainText('30 يومًا');
  await expect(card(page)).toContainText('7:00 مساءً');
  await expect(card(page).getByRole('checkbox', { name: 'تفعيل تذكيرات العودة', exact: true })).not.toBeChecked();
  await expect(consent).toBeChecked();
  await expect(comments(page).getByText(first.text, { exact: true })).toBeVisible();
  await expect(card(page)).toContainText('التذكير القادم');
  await expect(card(page)).toContainText('01/10/2026');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('default-rule.png'), fullPage: true });
});

test('custom values validate days and months and save independently from disabled consent', async ({ page }, testInfo) => {
  const { calls } = await mockApi(page, { schedule: { mode: 'default' } });
  await page.goto('/admin');
  await expect(card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true })).toBeChecked();
  await card(page).getByRole('radio', { name: 'جدول مخصص', exact: true }).check();
  const value = card(page).getByRole('spinbutton');
  const save = card(page).getByRole('button', { name: 'حفظ الإعدادات', exact: true });
  for (const invalid of ['', '0', '-1', '1.5', '3651']) {
    await value.fill(invalid);
    await expect(save).toBeDisabled();
    await expect(value).toHaveAttribute('aria-invalid', 'true');
  }
  await value.fill('3650');
  await expect(save).toBeEnabled();
  await card(page).getByRole('combobox').selectOption('months');
  await expect(save).toBeDisabled();
  await value.fill('121');
  await expect(save).toBeDisabled();
  await value.fill('2');
  await expect(card(page)).toContainText('شهرين');
  await save.click();
  await expect(save).toBeDisabled();
  expect(calls.filter(call => call.method === 'PATCH').map(call => call.body)).toEqual([{ schedule: { mode: 'custom', value: 2, unit: 'months' }, scheduleRevision: 4 }]);
  await expect(card(page).getByRole('button', { name: 'تسجيل موافقة الزبون', exact: true })).toBeDisabled();
  await page.reload();
  await expect(card(page).getByRole('spinbutton')).toHaveValue('2');
  await expect(card(page).getByRole('combobox')).toHaveValue('months');
  await page.screenshot({ path: testInfo.outputPath('custom-rule.png'), fullPage: true });
});

test('failed default save retains custom selection and prevents duplicate requests while pending', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  let fail = true;
  const { calls } = await mockApi(page, { handle: async ({ call, fulfill }) => {
    if (call.method !== 'PATCH') return false;
    if (fail) { await pending; await fulfill({ error: 'UNAVAILABLE' }, 503); return true; }
    return false;
  } });
  await page.goto('/admin');
  const chooseDefault = card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true });
  await chooseDefault.evaluate(input => { input.click(); input.click(); });
  await expect(chooseDefault).toBeDisabled();
  expect(calls.filter(call => call.method === 'PATCH')).toHaveLength(1);
  release();
  await expect(card(page).getByRole('alert')).toContainText('تعذر');
  await expect(card(page).getByRole('radio', { name: 'جدول مخصص', exact: true })).toBeChecked();
  fail = false;
  await chooseDefault.click();
  await expect(chooseDefault).toBeChecked();
});

test('schedule conflict preserves draft until an explicit refresh supplies the latest revision', async ({ page }) => {
  let conflict = true;
  const { calls } = await mockApi(page, { handle: async ({ call, state, fulfill }) => {
    if (call.method !== 'PATCH' || !conflict) return false;
    conflict = false; state.scheduleRevision = 9;
    state.schedule = { mode: 'custom', value: 6, unit: 'months' };
    await fulfill({ error: 'SCHEDULE_CONFLICT' }, 409); return true;
  } });
  await page.goto('/admin');
  await card(page).getByRole('spinbutton').fill('12');
  const save = card(page).getByRole('button', { name: 'حفظ الإعدادات', exact: true });
  await save.click();
  await expect(card(page).getByRole('alert')).toContainText('تغيّر');
  await expect(save).toBeDisabled();
  await card(page).getByRole('button', { name: 'تحديث جدول التذكير' }).click();
  await expect(card(page).getByRole('spinbutton')).toHaveValue('12');
  await save.click();
  await expect(save).toBeDisabled();
  expect(calls.filter(call => call.method === 'PATCH').at(-1).body).toEqual({ schedule: { mode: 'custom', value: 12, unit: 'days' }, scheduleRevision: 9 });
});

test('private comments add multiple entries, preserve drafts across schedule changes and use accessible edit/delete icons', async ({ page }, testInfo) => {
  const { calls } = await mockApi(page);
  await page.goto('/admin');
  const area = comments(page);
  await expect(area).toContainText('خاصة بالإدارة');
  await area.getByLabel('إضافة تعليق', { exact: true }).fill('تعليق ثالث');
  await card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true }).click();
  await expect(area.getByLabel('إضافة تعليق', { exact: true })).toHaveValue('تعليق ثالث');
  await area.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect(area.getByText('تعليق ثالث', { exact: true })).toBeVisible();
  await area.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  const longText = 'ملاحظة معدلة\n' + 'نصطويل'.repeat(120) + '<img src=x onerror=alert(1)>';
  await area.getByLabel('تعديل التعليق', { exact: true }).fill(longText);
  await area.getByRole('button', { name: 'حفظ التعليق', exact: true }).click();
  await expect(area.getByText(longText, { exact: true })).toBeVisible();
  await area.getByRole('button', { name: 'حذف التعليق 2', exact: true }).click();
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
  await area.getByRole('button', { name: 'تأكيد حذف التعليق', exact: true }).click();
  await expect(area.getByText(second.text, { exact: true })).toHaveCount(0);
  expect(calls.find(call => call.method === 'POST').body).toMatchObject({ commentId: expect.stringMatching(/^[a-f0-9-]{36}$/), text: 'تعليق ثالث' });
  expect(calls.find(call => call.method === 'PATCH' && call.path.includes('/comments/')).body).toEqual({ text: longText, revision: 1 });
  expect(calls.find(call => call.method === 'DELETE').body).toEqual({ revision: 1 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await expect(area.locator('img')).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('private-comments.png'), fullPage: true });
});

test('uncertain comment add locks its draft and retries the same UUID without double submission', async ({ page }) => {
  let fail = true;
  const { calls } = await mockApi(page, { handle: async ({ call, fulfill }) => {
    if (call.method === 'POST' && fail) { await fulfill({ error: 'UNAVAILABLE' }, 503); return true; }
    return false;
  } });
  await page.goto('/admin');
  const area = comments(page);
  await area.getByLabel('إضافة تعليق', { exact: true }).fill('محاولة واحدة');
  await area.getByRole('button', { name: 'إضافة تعليق', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect(area.getByRole('alert')).toContainText('تعذر');
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  await expect(area.getByLabel('إضافة تعليق', { exact: true })).toHaveValue('محاولة واحدة');
  await expect(area.getByLabel('إضافة تعليق', { exact: true })).toBeDisabled();
  fail = false;
  await area.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect(area.getByText('محاولة واحدة', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.method === 'POST')[1].body).toEqual(calls.find(call => call.method === 'POST').body);
  await expect(area.getByLabel('إضافة تعليق', { exact: true })).toHaveValue('');
});

test('comment conflicts keep edit drafts and require refresh before using the latest revision', async ({ page }) => {
  let fail = true;
  const { calls } = await mockApi(page, { handle: async ({ call, state, fulfill }) => {
    if (call.method === 'PATCH' && call.path.includes('/comments/') && fail) {
      fail = false; state.comments[0] = { ...first, text: 'عدله مسؤول آخر', revision: 3 }; state.commentsVersion = 5;
      await fulfill({ error: 'COMMENT_CONFLICT' }, 409); return true;
    }
    return false;
  } });
  await page.goto('/admin');
  const area = comments(page);
  await area.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  await area.getByLabel('تعديل التعليق', { exact: true }).fill('مسودتي');
  await area.getByRole('button', { name: 'حفظ التعليق', exact: true }).click();
  await expect(area.getByRole('alert')).toContainText('تغيّر');
  await expect(area.getByLabel('تعديل التعليق', { exact: true })).toHaveValue('مسودتي');
  await expect(area.getByRole('button', { name: 'حفظ التعليق', exact: true })).toBeDisabled();
  await area.getByRole('button', { name: 'تحديث التعليقات', exact: true }).click();
  await expect(area.getByText('عدله مسؤول آخر', { exact: true })).toBeVisible();
  await area.getByRole('button', { name: 'حفظ التعليق', exact: true }).click();
  await expect(area.getByText('مسودتي', { exact: true })).toBeVisible();
  expect(calls.filter(call => call.method === 'PATCH').at(-1).body).toEqual({ text: 'مسودتي', revision: 3 });
});

test('a late save cannot put the previous customer schedule or private draft on the new profile', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await mockApi(page, { handle: async ({ call, fulfill }) => {
    if (call.method === 'PATCH' && call.path.includes('000011/')) { await pending; await fulfill({ enabled: true, schedule: { mode: 'custom', value: 90, unit: 'days' }, scheduleRevision: 5 }); return true; }
    if (call.path.includes('000022/return-reminders/comments')) { await fulfill({ comments: [], commentsVersion: 0 }); return true; }
    if (call.path.includes('000022/return-reminders/status')) { await fulfill({ lastAttended: null, lastAttemptAt: null, nextReminderAt: null, status: 'no_attendance' }); return true; }
    if (call.path.includes('000022/return-reminders')) { await fulfill({ enabled: false, schedule: { mode: 'default' }, scheduleRevision: 0 }); return true; }
    return false;
  } });
  await page.goto('/profile-switch');
  await comments(page).getByLabel('إضافة تعليق', { exact: true }).fill('مسودة الزبون الأول');
  await card(page).getByRole('spinbutton').fill('90');
  await card(page).getByRole('button', { name: 'حفظ الإعدادات', exact: true }).click();
  await page.getByRole('button', { name: 'عرض الزبون التالي' }).click();
  await expect(card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true })).toBeChecked();
  release();
  await expect(comments(page).getByLabel('إضافة تعليق', { exact: true })).toHaveValue('');
  await expect(card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true })).toBeChecked();
  await expect(card(page)).not.toContainText(first.text);
  await expect(card(page).getByRole('checkbox', { name: 'تفعيل تذكيرات العودة', exact: true })).not.toBeChecked();
});

test('comment load failures preserve a new draft through explicit retry', async ({ page }) => {
  let fail = true;
  await mockApi(page, { handle: async ({ call, fulfill }) => {
    if (call.path.endsWith('/comments') && call.method === 'GET' && fail) { await fulfill({ error: 'UNAVAILABLE' }, 503); return true; }
    return false;
  } });
  await page.goto('/admin');
  const area = comments(page);
  await expect(area.getByRole('alert')).toContainText('تعذر تحميل');
  await area.getByLabel('إضافة تعليق', { exact: true }).fill('مسودة أثناء تعذر التحميل');
  await expect(area.getByRole('button', { name: 'إضافة تعليق', exact: true })).toBeDisabled();
  fail = false;
  await area.getByRole('button', { name: 'تحديث التعليقات', exact: true }).click();
  await expect(area.getByText(first.text, { exact: true })).toBeVisible();
  await expect(area.getByLabel('إضافة تعليق', { exact: true })).toHaveValue('مسودة أثناء تعذر التحميل');
  await expect(area.getByRole('button', { name: 'إضافة تعليق', exact: true })).toBeEnabled();
});

test('delete conflicts retain the comment until explicit refresh and confirm the newer revision', async ({ page }) => {
  let fail = true;
  const { calls } = await mockApi(page, { handle: async ({ call, state, fulfill }) => {
    if (call.method === 'DELETE' && fail) {
      fail = false; state.comments[0] = { ...first, text: 'أحدث نص قبل الحذف', revision: 3 }; state.commentsVersion = 5;
      await fulfill({ error: 'COMMENT_CONFLICT' }, 409); return true;
    }
    return false;
  } });
  await page.goto('/admin');
  const area = comments(page);
  await area.getByRole('button', { name: 'حذف التعليق 1', exact: true }).click();
  await area.getByRole('button', { name: 'تأكيد حذف التعليق', exact: true }).click();
  await expect(area.getByText(first.text, { exact: true })).toBeVisible();
  await expect(area.getByRole('button', { name: 'تأكيد حذف التعليق', exact: true })).toBeDisabled();
  await area.getByRole('button', { name: 'تحديث التعليقات', exact: true }).click();
  await expect(area.getByText('أحدث نص قبل الحذف', { exact: true })).toBeVisible();
  await area.getByRole('button', { name: 'تأكيد حذف التعليق', exact: true }).click();
  await expect(area.getByText('أحدث نص قبل الحذف', { exact: true })).toHaveCount(0);
  expect(calls.filter(call => call.method === 'DELETE').map(call => call.body)).toEqual([{ revision: 1 }, { revision: 3 }]);
});

test('a deleted comment keeps an edit draft available for copying without allowing resurrection', async ({ page }) => {
  await mockApi(page, { handle: async ({ call, state, fulfill }) => {
    if (call.method === 'PATCH' && call.path.includes('/comments/')) {
      state.comments = [second]; state.commentsVersion = 5;
      await fulfill({ error: 'COMMENT_NOT_FOUND' }, 404); return true;
    }
    return false;
  } });
  await page.goto('/admin');
  const area = comments(page);
  await area.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  await area.getByLabel('تعديل التعليق', { exact: true }).fill('مسودة مهمة');
  await area.getByRole('button', { name: 'حفظ التعليق', exact: true }).click();
  await area.getByRole('button', { name: 'تحديث التعليقات', exact: true }).click();
  await expect(area.getByLabel('تعديل التعليق', { exact: true })).toHaveValue('مسودة مهمة');
  await expect(area.getByRole('button', { name: 'حفظ التعليق', exact: true })).toBeDisabled();
  await expect(area).toContainText('حُذف هذا التعليق');
});

test('real reminder status uses clinic time and refreshes after schedule and consent saves', async ({ page }) => {
  const { calls } = await mockApi(page, { enabled: true, handle: async ({ call, state, fulfill }) => {
    if (!call.path.endsWith('/status')) return false;
    await fulfill({ lastAttended: { date: '2026-10-01', time: '14:00' }, lastAttemptAt: '2026-10-23T21:30:00.000Z', nextReminderAt: state.enabled ? state.schedule.mode === 'default' ? '2027-01-01T17:00:00.000Z' : '2026-10-26T17:00:00.000Z' : null, status: state.enabled ? 'scheduled' : 'disabled' });
    return true;
  } });
  await page.goto('/admin');
  const details = card(page).getByRole('group', { name: 'حالة تذكير العودة', exact: true });
  await expect(details).toContainText('01/10/2026');
  await expect(details).toContainText('24/10/2026');
  await expect(details).toContainText('00:30');
  await expect(details).toContainText('26/10/2026');
  await expect(details).toContainText('19:00');
  await card(page).getByRole('radio', { name: 'الجدول الافتراضي', exact: true }).click();
  await expect(details).toContainText('01/01/2027');
  await card(page).getByRole('checkbox', { name: 'تفعيل تذكيرات العودة', exact: true }).click();
  await expect(details).toContainText('التذكيرات متوقفة');
  expect(calls.filter(call => call.path.endsWith('/status')).length).toBeGreaterThanOrEqual(3);
  await expect(details).not.toContainText('01/01/2027');
});

test('status load failure has independent retry and never blocks schedule or comment editing', async ({ page }) => {
  let fail = true;
  await mockApi(page, { handle: async ({ call, fulfill }) => {
    if (!call.path.endsWith('/status')) return false;
    if (fail) await fulfill({ error: 'UNAVAILABLE' }, 503);
    else await fulfill({ lastAttended: { date: '2026-10-01', time: '14:00' }, lastAttemptAt: null, nextReminderAt: null, status: 'upcoming' });
    return true;
  } });
  await page.goto('/admin');
  const details = card(page).getByRole('group', { name: 'حالة تذكير العودة', exact: true });
  await expect(details.getByRole('alert')).toContainText('تعذر');
  await card(page).getByRole('spinbutton').fill('10');
  await expect(card(page).getByRole('button', { name: 'حفظ الإعدادات', exact: true })).toBeEnabled();
  await comments(page).getByLabel('إضافة تعليق', { exact: true }).fill('مسودة مستقلة');
  await expect(comments(page).getByRole('button', { name: 'إضافة تعليق', exact: true })).toBeEnabled();
  fail = false;
  await details.getByRole('button', { name: 'إعادة تحميل حالة التذكير', exact: true }).click();
  await expect(details).toContainText('متوقف لوجود موعد قادم');
  await expect(card(page).getByRole('spinbutton')).toHaveValue('10');
  await expect(comments(page).getByLabel('إضافة تعليق', { exact: true })).toHaveValue('مسودة مستقلة');
});

for (const [status, expected] of [['no_attendance', 'بانتظار جلسة يحضرها الزبون'], ['unavailable', 'تعذر تحديد الموعد']]) {
  test(`status ${status} never invents a next date`, async ({ page }) => {
    await mockApi(page, { handle: async ({ call, fulfill }) => {
      if (!call.path.endsWith('/status')) return false;
      await fulfill({ lastAttended: null, lastAttemptAt: null, nextReminderAt: null, status }); return true;
    } });
    await page.goto('/admin');
    const details = card(page).getByRole('group', { name: 'حالة تذكير العودة', exact: true });
    await expect(details).toContainText(expected);
    if (status === 'unavailable') {
      await expect(details.getByText('غير متاح', { exact: true })).toHaveCount(2);
      await expect(details).not.toContainText('لا توجد جلسة حضور');
      await expect(details).not.toContainText('لم تُسجّل محاولة');
    } else {
      await expect(details).toContainText('لا توجد جلسة حضور');
      await expect(details).toContainText('لم تُسجّل محاولة');
    }
  });
}

test('dirty custom draft labels the next date as belonging to the saved schedule until a successful save', async ({ page }) => {
  await mockApi(page, { enabled: true, handle: async ({ call, state, fulfill }) => {
    if (!call.path.endsWith('/status')) return false;
    await fulfill({ lastAttended: { date: '2026-10-01', time: '14:00' }, lastAttemptAt: null, nextReminderAt: state.schedule.value === 10 ? '2026-10-11T16:00:00.000Z' : '2026-10-26T17:00:00.000Z', status: 'scheduled' }); return true;
  } });
  await page.goto('/admin');
  const details = card(page).getByRole('group', { name: 'حالة تذكير العودة', exact: true });
  await expect(details).toContainText('26/10/2026');
  await card(page).getByRole('spinbutton').fill('10');
  await expect(details).toContainText('الموعد المعروض حسب الجدول المحفوظ؛ احفظ التغييرات لتحديثه.');
  await expect(details).toContainText('26/10/2026');
  await card(page).getByRole('button', { name: 'حفظ الإعدادات', exact: true }).click();
  await expect(details).toContainText('11/10/2026');
  await expect(details).not.toContainText('احفظ التغييرات لتحديثه');
});

test('pending status does not block editing and its late response cannot cross customer navigation', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await mockApi(page, { handle: async ({ call, fulfill }) => {
    if (call.path.includes('000011/return-reminders/status')) {
      await pending;
      await fulfill({ lastAttended: { date: '2026-09-09', time: '09:00' }, lastAttemptAt: null, nextReminderAt: '2026-11-11T17:00:00.000Z', status: 'scheduled' }); return true;
    }
    if (call.path.includes('000022/return-reminders/status')) { await fulfill({ lastAttended: null, lastAttemptAt: null, nextReminderAt: null, status: 'no_attendance' }); return true; }
    return false;
  } });
  await page.goto('/profile-switch');
  const details = card(page).getByRole('group', { name: 'حالة تذكير العودة', exact: true });
  await expect(details).toHaveAttribute('aria-busy', 'true');
  await card(page).getByRole('spinbutton').fill('12');
  await expect(card(page).getByRole('button', { name: 'حفظ الإعدادات', exact: true })).toBeEnabled();
  await comments(page).getByLabel('إضافة تعليق', { exact: true }).fill('مسودة أثناء التحميل');
  await page.getByRole('button', { name: 'عرض الزبون التالي' }).click();
  await expect(details).toContainText('بانتظار جلسة يحضرها الزبون');
  release();
  await expect(details).not.toContainText('09/09/2026');
  await expect(details).not.toContainText('11/11/2026');
  await expect(comments(page).getByLabel('إضافة تعليق', { exact: true })).toHaveValue('');
});

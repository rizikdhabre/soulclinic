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
const bookingNote = 'ملاحظة عند الحجز قبل العلاج.\n' + 'تفاصيلالحجز'.repeat(100) + '\n' + 'أرجو مراعاة هذه الملاحظة.\n'.repeat(120) + '<script>alert(1)</script>';
const profile = {
  user: { _id: 'customer-one', firstName: 'ليلى', lastName: 'أحمد', phone: '0500000000' },
  appointments: [
    { _id: 'older', title: 'جلسة أقدم', date: '2026-08-01', time: '10:00', price: 100, attended: false, bookingNote: '', feedback: null, isPast: true, status: 'not_attended' },
    { _id: 'recent', title: 'جلسة حديثة', date: '2026-09-20', time: '11:00', price: 150, attended: true, bookingNote, feedback: { text: feedback, submittedAt: '2026-09-28T12:00:00Z' }, isPast: true, status: 'attended' },
    { _id: 'future', title: 'جلسة قادمة', date: '2030-01-15', time: '14:00', price: 170, attended: false, bookingNote: 'يفضل الاتصال قبل الموعد', feedback: null, isPast: false, status: 'upcoming' },
    { _id: 'canceled', title: 'جلسة ملغاة', date: '2030-01-16', time: '15:00', price: 180, attended: false, bookingNote: '', feedback: null, isPast: false, status: 'canceled' },
    { _id: 'unverified', title: 'جلسة غير مؤكدة', date: '2030-01-17', time: '16:00', price: 190, attended: false, bookingNote: '', feedback: null, isPast: false, status: 'unknown' },
  ], plans: [],
};
const allPlans = [
  { _id: '000000000000000000000001', createdAt: '2026-09-01T10:00:00Z', status: 'in_progress', counts: { total: 3, upcoming: 1, attended: 1, notAttended: 0, canceled: 1, unknown: 0 }, notification: { status: 'sent' }, appointments: [profile.appointments[1], profile.appointments[2], profile.appointments[3]] },
  { _id: '000000000000000000000002', createdAt: '2026-09-02T10:00:00Z', status: 'canceled', counts: { total: 1, upcoming: 0, attended: 0, notAttended: 0, canceled: 1, unknown: 0 }, notification: { status: 'failed' }, appointments: [profile.appointments[3]] },
  { _id: '000000000000000000000003', createdAt: '2026-09-03T10:00:00Z', status: 'completed', counts: { total: 1, upcoming: 0, attended: 1, notAttended: 0, canceled: 0, unknown: 0 }, notification: { status: 'pending' }, appointments: [profile.appointments[1]] },
  { _id: '000000000000000000000004', createdAt: '2026-09-04T10:00:00Z', status: 'ended', counts: { total: 1, upcoming: 0, attended: 0, notAttended: 1, canceled: 0, unknown: 0 }, notification: { status: 'not_configured' }, appointments: [profile.appointments[0]] },
  { _id: '000000000000000000000005', createdAt: '2026-09-05T10:00:00Z', status: 'unknown', counts: { total: 1, upcoming: 0, attended: 0, notAttended: 0, canceled: 0, unknown: 1 }, notification: { status: 'unknown' }, appointments: [profile.appointments[4]] },
  { _id: '000000000000000000000006', createdAt: '2026-09-06T10:00:00Z', status: 'upcoming', counts: { total: 1, upcoming: 1, attended: 0, notAttended: 0, canceled: 0, unknown: 0 }, notification: { status: 'sent' }, appointments: [profile.appointments[2]] },
  { _id: '000000000000000000000007', createdAt: '2026-08-31T10:00:00Z', status: 'completed', counts: { total: 1, upcoming: 0, attended: 1, notAttended: 0, canceled: 0, unknown: 0 }, notification: { status: 'sent' }, appointments: [profile.appointments[1]] },
].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
function planPageAfter(cursor) {
  const offset = cursor ? allPlans.findIndex(plan => plan._id === cursor) + 1 : 0;
  const plans = allPlans.slice(offset, offset + 3);
  const hasMore = offset + plans.length < allPlans.length;
  return { plans, plansPagination: { hasMore, nextCursor: hasMore ? plans.at(-1)._id : null } };
}
Object.assign(profile, planPageAfter(null));
const catalog = [{ _id: 'treatment-one', title: 'العلاج الطبيعي', services: [{ title: 'جلسة كاملة', duration: 60, price: 150 }, { title: 'جلسة قصيرة', duration: 30, price: 80, cupsCount: 0 }] }];

async function mockApi(page, overrides = {}) {
  const calls = [];
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== process.env.PROFILE_TEST_BASE_URL) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push({ path: url.pathname, cursor: url.searchParams.get('cursor'), method: request.method(), body: ['POST', 'PATCH', 'DELETE'].includes(request.method()) && request.postData() ? request.postDataJSON() : null });
    const fulfill = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (overrides.handle && await overrides.handle({ route, request, url, fulfill, calls })) return;
    if (url.pathname === '/api/admin/users/customer-one') return fulfill(profile);
    if (url.pathname === '/api/admin/users/customer-one/return-reminders') return fulfill({ enabled: false });
    if (url.pathname === '/api/admin/treatments') return fulfill(catalog);
    if (url.pathname === '/api/appointments') {
      expect(url.searchParams.get('admin')).toBe('true');
      return fulfill({ appointments: [{ time: '13:00', duration: 60 }], blockedTimes: ['15:00'], editedTimes: [] });
    }
    if (url.pathname.endsWith('/treatment-plans')) return fulfill(request.method() === 'GET' ? planPageAfter(url.searchParams.get('cursor')) : { success: true, planId: 'plan-one', appointmentIds: ['new-one'], notification: { status: 'not_configured' } });
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

const firstComment = { _id: '11111111-1111-4111-8111-111111111111', text: 'ملاحظة داخلية أولى', revision: 1, createdAt: '2026-10-23T10:00:00Z', updatedAt: '2026-10-23T10:00:00Z' };
const secondComment = { ...firstComment, _id: '22222222-2222-4222-8222-222222222222', text: 'ملاحظة داخلية ثانية' };
const commentsBase = `/api/admin/users/customer-one/treatment-plans/${allPlans[0]._id}/comments`;

async function mockComments(page, { initial = [firstComment, secondComment], plan = allPlans[0], handle } = {}) {
  const state = { comments: structuredClone(initial), commentsVersion: 2 };
  const base = `/api/admin/users/customer-one/treatment-plans/${plan._id}/comments`;
  const withComments = item => item._id === plan._id ? { ...item, ...state } : item;
  const calls = await mockApi(page, { handle: async context => {
    const { url, request, fulfill } = context;
    if (handle && await handle({ ...context, state })) return true;
    if (url.pathname === '/api/admin/users/customer-one') {
      await fulfill({ ...profile, plans: profile.plans.map(withComments) });
      return true;
    }
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'GET') {
      const page = planPageAfter(url.searchParams.get('cursor'));
      await fulfill({ ...page, plans: page.plans.map(withComments) });
      return true;
    }
    if (!url.pathname.startsWith(base)) return false;
    const method = request.method();
    const body = method === 'GET' ? null : request.postDataJSON();
    if (method === 'POST') state.comments.push({ ...firstComment, _id: body.commentId, text: body.text });
    if (method === 'PATCH') state.comments = state.comments.map(comment => url.pathname.endsWith(comment._id) ? { ...comment, text: body.text, revision: comment.revision + 1 } : comment);
    if (method === 'DELETE') state.comments = state.comments.filter(comment => !url.pathname.endsWith(comment._id));
    if (method !== 'GET') state.commentsVersion++;
    await fulfill({ success: true, ...state });
    return true;
  } });
  return { calls, state };
}

function programComments(page) {
  return page.getByRole('region', { name: 'تعليقات الإدارة', exact: true }).first();
}

test('program comments add multiple private entries and edit or delete one using icon actions', async ({ page }) => {
  const { calls } = await mockComments(page);
  await page.goto('/profile');
  const comments = programComments(page);
  await expect(comments).toContainText(firstComment.text);
  await expect(comments).toContainText(secondComment.text);
  await comments.getByRole('textbox', { name: 'تعليق جديد', exact: true }).fill('تعليق ثالث خاص بالإدارة');
  await comments.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect(comments).toContainText('تعليق ثالث خاص بالإدارة');
  const edit = comments.getByRole('button', { name: 'تعديل التعليق 1', exact: true });
  await expect(edit).toHaveText('');
  await expect(edit).toHaveAttribute('title', 'تعديل التعليق 1');
  await edit.click();
  await comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true }).fill('النص المعدّل للتعليق الأول');
  await comments.getByRole('button', { name: 'حفظ تعديلات التعليق', exact: true }).click();
  await expect(comments).toContainText('النص المعدّل للتعليق الأول');
  await expect(comments).not.toContainText(firstComment.text);
  const trash = comments.getByRole('button', { name: 'حذف التعليق 2', exact: true });
  await expect(trash).toHaveText('');
  await trash.click();
  await expect(comments).toContainText(secondComment.text);
  await comments.getByRole('button', { name: 'إلغاء حذف التعليق', exact: true }).click();
  expect(calls.filter(call => call.path.startsWith(commentsBase) && call.method === 'DELETE')).toHaveLength(0);
  await trash.click();
  await comments.getByRole('button', { name: 'تأكيد حذف التعليق', exact: true }).click();
  await expect(comments).not.toContainText(secondComment.text);
  await expect(comments).toContainText('تعليق ثالث خاص بالإدارة');
  const mutations = calls.filter(call => call.path.startsWith(commentsBase));
  expect(mutations.map(call => call.method)).toEqual(['POST', 'PATCH', 'DELETE']);
  expect(mutations[0].body).toMatchObject({ text: 'تعليق ثالث خاص بالإدارة', commentId: expect.stringMatching(/^[a-f0-9-]{36}$/) });
  expect(mutations[1]).toMatchObject({ path: `${commentsBase}/${firstComment._id}`, body: { text: 'النص المعدّل للتعليق الأول', revision: 1 } });
  expect(mutations[2]).toMatchObject({ path: `${commentsBase}/${secondComment._id}`, body: { revision: 1 } });
});

test('program comments retry an uncertain add with the same UUID and block rapid duplicate requests', async ({ page }) => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let submissions = 0;
  const { calls } = await mockComments(page, { handle: async ({ url, request, fulfill }) => {
    if (url.pathname !== commentsBase || request.method() !== 'POST') return false;
    submissions++;
    if (submissions > 1) return false;
    await waiting;
    await fulfill({ error: 'TEMPORARY_FAILURE' }, 503);
    return true;
  } });
  await page.goto('/profile');
  const comments = programComments(page);
  const draft = comments.getByRole('textbox', { name: 'تعليق جديد', exact: true });
  await draft.fill('تعليق بعد انقطاع الاتصال');
  await comments.getByRole('button', { name: 'إضافة تعليق', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => submissions).toBe(1);
  await expect(draft).toBeDisabled();
  release();
  await expect(comments.getByRole('alert')).toContainText('تعذر');
  await expect(draft).toHaveValue('تعليق بعد انقطاع الاتصال');
  await comments.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect(comments.getByText('تعليق بعد انقطاع الاتصال', { exact: true })).toBeVisible();
  await expect(draft).toHaveValue('');
  const posts = calls.filter(call => call.path === commentsBase && call.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[1].body).toEqual(posts[0].body);
});

for (const action of ['PATCH', 'DELETE']) test(`program comments preserve edits and require refreshed revision after ${action} conflict`, async ({ page }) => {
  let conflict = true;
  const { calls } = await mockComments(page, { handle: async ({ url, request, fulfill, state }) => {
    if (url.pathname !== `${commentsBase}/${firstComment._id}` || request.method() !== action || !conflict) return false;
    conflict = false;
    state.comments[0] = { ...firstComment, text: 'نسخة أحدث من مسؤول آخر', revision: 2 };
    state.commentsVersion = 3;
    await fulfill({ error: 'COMMENT_CONFLICT' }, 409);
    return true;
  } });
  await page.goto('/profile');
  const comments = programComments(page);
  await comments.getByRole('button', { name: action === 'PATCH' ? 'تعديل التعليق 1' : 'حذف التعليق 1', exact: true }).click();
  if (action === 'PATCH') await comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true }).fill('مسودتي محفوظة');
  const confirm = comments.getByRole('button', { name: action === 'PATCH' ? 'حفظ تعديلات التعليق' : 'تأكيد حذف التعليق', exact: true });
  await confirm.click();
  await expect(comments.getByRole('alert')).toContainText('تغيّر');
  await expect(confirm).toBeDisabled();
  await comments.getByRole('button', { name: 'تحديث التعليقات', exact: true }).click();
  await expect(comments).toContainText('نسخة أحدث من مسؤول آخر');
  if (action === 'PATCH') await expect(comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true })).toHaveValue('مسودتي محفوظة');
  await expect(confirm).toBeEnabled();
  await confirm.click();
  await expect(comments.getByText(action === 'PATCH' ? 'مسودتي محفوظة' : secondComment.text, { exact: true })).toBeVisible();
  await expect(comments).not.toContainText('نسخة أحدث من مسؤول آخر');
  const writes = calls.filter(call => call.path === `${commentsBase}/${firstComment._id}` && call.method === action);
  expect(writes.map(call => call.body.revision)).toEqual([1, 2]);
});

test('program comments preserve drafts after failures and cancellation leaves saved text unchanged', async ({ page }) => {
  const { calls } = await mockComments(page, { handle: async ({ url, request, fulfill }) => {
    if (!url.pathname.startsWith(commentsBase) || request.method() === 'GET') return false;
    await fulfill({ error: request.method() === 'POST' ? 'PLAN_NOT_FOUND' : 'TEMPORARY_FAILURE' }, request.method() === 'POST' ? 404 : 500);
    return true;
  } });
  await page.goto('/profile');
  const comments = programComments(page);
  await comments.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  await comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true }).fill('مسودة لم تحفظ');
  await comments.getByRole('button', { name: 'حفظ تعديلات التعليق', exact: true }).click();
  await expect(comments.getByRole('alert')).toContainText('تعذر');
  await expect(comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true })).toHaveValue('مسودة لم تحفظ');
  await comments.getByRole('button', { name: 'إلغاء التعديل', exact: true }).click();
  await expect(comments).toContainText(firstComment.text);
  await comments.getByRole('button', { name: 'حذف التعليق 1', exact: true }).click();
  await comments.getByRole('button', { name: 'تأكيد حذف التعليق', exact: true }).click();
  await expect(comments.getByRole('alert')).toContainText('تعذر');
  await expect(comments).toContainText(firstComment.text);
  await comments.getByRole('button', { name: 'إلغاء حذف التعليق', exact: true }).click();
  await comments.getByRole('textbox', { name: 'تعليق جديد', exact: true }).fill('مسودة برنامج حُذف');
  await comments.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect(comments.getByRole('alert')).toContainText('البرنامج');
  await expect(comments.getByRole('textbox', { name: 'تعليق جديد', exact: true })).toHaveValue('مسودة برنامج حُذف');
  expect(calls.filter(call => call.path === commentsBase && call.method === 'POST')).toHaveLength(1);
});

test('program comments keep newer confirmed text across stale profile refresh and preserve drafts while collapsed', async ({ page }) => {
  let profileReads = 0;
  let saved = false;
  await mockComments(page, { handle: async ({ url, request, fulfill }) => {
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'POST') saved = true;
    if (url.pathname !== '/api/admin/users/customer-one' || !saved) return false;
    profileReads++;
    await fulfill({ ...profile, plans: profile.plans.map((plan, index) => index === 0 ? { ...plan, comments: [firstComment, secondComment], commentsVersion: 2 } : plan) });
    return true;
  } });
  await page.goto('/profile');
  const comments = programComments(page);
  await comments.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  await comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true }).fill('أحدث نص مؤكد');
  await comments.getByRole('button', { name: 'حفظ تعديلات التعليق', exact: true }).click();
  await expect(comments).toContainText('أحدث نص مؤكد');
  await comments.getByRole('textbox', { name: 'تعليق جديد', exact: true }).fill('مسودة إضافة محفوظة');
  await page.getByRole('button', { name: 'طي البرامج المحفوظة', exact: true }).click();
  await page.getByRole('button', { name: 'توسيع البرامج المحفوظة', exact: true }).click();
  await expect(comments.getByRole('textbox', { name: 'تعليق جديد', exact: true })).toHaveValue('مسودة إضافة محفوظة');
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد', exact: true }).click();
  await expect.poll(() => profileReads).toBe(1);
  await expect(comments).toContainText('أحدث نص مؤكد');
  await expect(comments).not.toContainText(firstComment.text);
  await expect(comments.getByRole('textbox', { name: 'تعليق جديد', exact: true })).toHaveValue('مسودة إضافة محفوظة');
});

test('program comments show long untrusted text literally without horizontal overflow', async ({ page }, testInfo) => {
  const text = 'تعليق إداري طويل\n' + 'تفاصيلمتصلة'.repeat(160) + '\n' + '<img src=x onerror=alert(1)>\n' + 'سطر خاص بالإدارة.\n'.repeat(20);
  await mockComments(page, { initial: [{ ...firstComment, text }] });
  await page.goto('/profile');
  const comments = programComments(page);
  await expect(comments.getByText(text, { exact: true })).toBeVisible();
  expect(await comments.locator('img, script').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await comments.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  await expect(comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true })).toHaveValue(text);
  await expect(comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true })).toHaveAttribute('maxlength', '10000');
  await comments.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('program-admin-comments.png') });
});

test('program comments retain older-plan drafts and an uncertain add while newest-three refresh temporarily removes its card', async ({ page }) => {
  const olderPlan = allPlans[3];
  const base = `/api/admin/users/customer-one/treatment-plans/${olderPlan._id}/comments`;
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let submissions = 0;
  const { calls } = await mockComments(page, { plan: olderPlan, handle: async ({ url, request, fulfill }) => {
    if (url.pathname !== base || request.method() !== 'POST' || ++submissions > 1) return false;
    await waiting;
    await fulfill({ error: 'TEMPORARY_FAILURE' }, 503);
    return true;
  } });
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة', exact: true });
  await plans.getByRole('button', { name: 'عرض المزيد', exact: true }).click();
  const card = plans.getByRole('article').filter({ hasText: '2026-09-03' });
  const comments = card.getByRole('region', { name: 'تعليقات الإدارة', exact: true });
  await comments.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  await comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true }).fill('مسودة تعديل في برنامج أقدم');
  await comments.getByRole('textbox', { name: 'تعليق جديد', exact: true }).fill('إضافة غير مؤكدة لبرنامج أقدم');
  await comments.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect.poll(() => submissions).toBe(1);
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد', exact: true }).click();
  await expect(plans.getByRole('article')).toHaveCount(3);
  await expect(card).toHaveCount(0);
  release();
  await plans.getByRole('button', { name: 'عرض المزيد', exact: true }).click();
  await expect(comments.getByRole('textbox', { name: 'تعليق جديد', exact: true })).toHaveValue('إضافة غير مؤكدة لبرنامج أقدم');
  await expect(comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true })).toHaveValue('مسودة تعديل في برنامج أقدم');
  await expect(comments.getByRole('alert')).toContainText('تعذر');
  await comments.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect(comments.getByText('إضافة غير مؤكدة لبرنامج أقدم', { exact: true })).toBeVisible();
  const posts = calls.filter(call => call.path === base && call.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[1].body).toEqual(posts[0].body);
});

test('program comments can resolve an uncertain existing add after a profile refresh reaches the comment cap', async ({ page }) => {
  const initial = Array.from({ length: 99 }, (_, index) => ({ ...firstComment, _id: `${String(index).padStart(8, '0')}-1111-4111-8111-111111111111`, text: `تعليق محفوظ ${index + 1}` }));
  let submissions = 0;
  const { calls } = await mockComments(page, { initial, handle: async ({ url, request, fulfill, state }) => {
    if (url.pathname !== commentsBase || request.method() !== 'POST') return false;
    submissions++;
    if (submissions === 1) {
      const body = request.postDataJSON();
      state.comments.push({ ...firstComment, _id: body.commentId, text: body.text });
      state.commentsVersion++;
      await fulfill({ error: 'TEMPORARY_FAILURE' }, 503);
    } else await fulfill({ success: true, ...state });
    return true;
  } });
  await page.goto('/profile');
  const comments = programComments(page);
  await comments.getByRole('textbox', { name: 'تعليق جديد', exact: true }).fill('التعليق المئة غير المؤكد');
  await comments.getByRole('button', { name: 'إضافة تعليق', exact: true }).click();
  await expect(comments.getByRole('alert')).toContainText('تعذر');
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد', exact: true }).click();
  await expect(comments.getByRole('paragraph').filter({ hasText: 'التعليق المئة غير المؤكد' })).toBeVisible();
  const retry = comments.getByRole('button', { name: 'إضافة تعليق', exact: true });
  await expect(retry).toBeEnabled();
  await retry.click();
  await expect(comments.getByRole('textbox', { name: 'تعليق جديد', exact: true })).toHaveValue('');
  await expect(retry).toBeDisabled();
  const posts = calls.filter(call => call.path === commentsBase && call.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[1].body).toEqual(posts[0].body);
});

test('program comments require explicit refresh after a reused add ID and retain its draft for a deliberate new addition', async ({ page }) => {
  let attempts = 0;
  const { calls } = await mockComments(page, { handle: async ({ url, request, fulfill }) => {
    if (url.pathname !== commentsBase || request.method() !== 'POST' || ++attempts > 1) return false;
    await fulfill({ error: 'COMMENT_ID_REUSED' }, 409);
    return true;
  } });
  await page.goto('/profile');
  const comments = programComments(page);
  const draft = comments.getByRole('textbox', { name: 'تعليق جديد', exact: true });
  const add = comments.getByRole('button', { name: 'إضافة تعليق', exact: true });
  await draft.fill('تعليق يحتاج مراجعة بعد الحذف');
  await add.click();
  await expect(comments.getByRole('alert')).toContainText('تغيّر');
  await expect(draft).toHaveValue('تعليق يحتاج مراجعة بعد الحذف');
  await expect(add).toBeDisabled();
  await comments.getByRole('button', { name: 'تحديث التعليقات', exact: true }).click();
  await expect(add).toBeEnabled();
  expect(attempts).toBe(1);
  await expect(draft).toHaveValue('تعليق يحتاج مراجعة بعد الحذف');
  await add.click();
  await expect(comments.getByRole('paragraph').filter({ hasText: 'تعليق يحتاج مراجعة بعد الحذف' })).toBeVisible();
  const posts = calls.filter(call => call.path === commentsBase && call.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[1].body.commentId).not.toBe(posts[0].body.commentId);
});

test('program comments use the newest confirmed revision when an older conflict refresh finishes last', async ({ page }) => {
  let release;
  const waiting = new Promise(resolve => { release = resolve; });
  let changes = 0;
  let refreshing = false;
  const { calls } = await mockComments(page, { handle: async ({ url, request, fulfill, state }) => {
    if (url.pathname === `${commentsBase}/${firstComment._id}` && request.method() === 'PATCH' && ++changes === 1) {
      state.comments[0] = { ...firstComment, text: 'آخر نص من مسؤول آخر', revision: 3 };
      state.commentsVersion = 4;
      await fulfill({ error: 'COMMENT_CONFLICT' }, 409);
      return true;
    }
    if (url.pathname === commentsBase && request.method() === 'GET') {
      refreshing = true;
      await waiting;
      await fulfill({ comments: [{ ...firstComment, text: 'نسخة أقدم من التعليق', revision: 2 }, secondComment], commentsVersion: 3 });
      return true;
    }
    return false;
  } });
  await page.goto('/profile');
  const comments = programComments(page);
  await comments.getByRole('button', { name: 'تعديل التعليق 1', exact: true }).click();
  await comments.getByRole('textbox', { name: 'تعديل التعليق', exact: true }).fill('مسودة مستقرة رغم التحديثات');
  await comments.getByRole('button', { name: 'حفظ تعديلات التعليق', exact: true }).click();
  await comments.getByRole('button', { name: 'تحديث التعليقات', exact: true }).click();
  await expect.poll(() => refreshing).toBe(true);
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد', exact: true }).click();
  await expect(comments).toContainText('آخر نص من مسؤول آخر');
  release();
  const save = comments.getByRole('button', { name: 'حفظ تعديلات التعليق', exact: true });
  await expect(save).toBeEnabled();
  await expect(comments).not.toContainText('نسخة أقدم من التعليق');
  await save.click();
  await expect(comments.getByRole('paragraph').filter({ hasText: 'مسودة مستقرة رغم التحديثات' })).toBeVisible();
  expect(calls.filter(call => call.path === `${commentsBase}/${firstComment._id}` && call.method === 'PATCH').map(call => call.body.revision)).toEqual([1, 3]);
});

test('mobile customer-list link leaves room for the floating sidebar control', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'mobile', 'Mobile-only spacing regression.');
  await mockApi(page);
  await page.goto('/profile');
  const link = page.getByRole('link', { name: 'قائمة الزبائن', exact: true });
  const header = page.locator('header');
  await expect(link).toBeVisible();
  const [linkBox, headerBox] = await Promise.all([link.boundingBox(), header.boundingBox()]);
  expect(headerBox.x + headerBox.width - linkBox.x - linkBox.width).toBeGreaterThanOrEqual(30);
  await page.screenshot({ path: testInfo.outputPath('mobile-back-link.png') });
});

test('all appointments are latest first with distinct read-only states and booking notes', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/profile');
  await expect(page.getByRole('heading', { name: 'ليلى أحمد' })).toBeVisible();
  const history = page.getByRole('region', { name: 'جميع المواعيد' });
  await expect(history).toContainText('حضر');
  await expect(history).toContainText('لم يحضر');
  expect(await history.getByRole('checkbox').count()).toBe(0);
  expect(await history.getByRole('switch').count()).toBe(0);
  const text = await history.innerText();
  expect(text.indexOf('جلسة حديثة')).toBeLessThan(text.indexOf('جلسة أقدم'));
  expect(text.indexOf('جلسة قادمة')).toBeLessThan(text.indexOf('جلسة حديثة'));
  for (const [title, status] of [['جلسة قادمة', 'قادم'], ['جلسة ملغاة', 'ملغى'], ['جلسة غير مؤكدة', 'بحاجة للتحقق']]) {
    const row = history.locator('tr, article').filter({ hasText: title }).filter({ visible: true });
    await expect(row).toContainText(status);
    await expect(row).not.toContainText('لم يحضر');
  }
  await expect(page.getByRole('region', { name: 'المواعيد القادمة' })).toHaveCount(0);
  await expect(history.getByText('ملاحظة الحجز', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(history.getByText('تقييم العلاج', { exact: true }).filter({ visible: true }).first()).toBeVisible();
  await expect(history.getByText('لا توجد ملاحظة حجز').filter({ visible: true }).first()).toBeVisible();
  await expect(history.getByText('لا يوجد تقييم للعلاج').filter({ visible: true }).first()).toBeVisible();
  if (testInfo.project.name === 'desktop') await expect(history.getByRole('columnheader')).toHaveCount(6);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('customer-profile.png'), fullPage: true });
});

test('long treatment feedback remains plain text, scrollable and keyboard accessible', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/profile');
  const history = page.getByRole('region', { name: 'جميع المواعيد' });
  const opener = history.getByRole('button', { name: /عرض تقييم العلاج كاملًا/ });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'تقييم العلاج' });
  await expect(dialog).toBeVisible();
  expect(await dialog.locator('[data-feedback-text]').textContent()).toBe(feedback);
  expect(await dialog.locator('img').count()).toBe(0);
  expect(await dialog.getByLabel('نص تقييم العلاج').evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(page.locator('body')).toHaveCSS('overflow', 'hidden');
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
  await expect(page.locator('body')).not.toHaveCSS('overflow', 'hidden');
  await opener.click();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await opener.click();
  await dialog.getByRole('button', { name: 'إغلاق' }).click();
  await expect(dialog).toBeHidden();
});

test('long booking note opens separately from treatment feedback with safe text and restored focus', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/profile');
  const opener = page.getByRole('region', { name: 'جميع المواعيد' }).getByRole('button', { name: 'عرض ملاحظة الحجز كاملة — جلسة حديثة' });
  await opener.click();
  const dialog = page.getByRole('dialog', { name: 'ملاحظة الحجز' });
  const content = dialog.getByLabel('نص ملاحظة الحجز');
  await expect(dialog).toBeVisible();
  expect(await content.textContent()).toBe(bookingNote);
  expect(await dialog.locator('script, img').count()).toBe(0);
  expect(await dialog.locator('[data-feedback-text]').count()).toBe(0);
  expect(await content.evaluate(el => el.scrollHeight > el.clientHeight)).toBe(true);
  await expect(dialog.getByRole('button', { name: 'إغلاق' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(content).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'إغلاق' })).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('booking-note-dialog.png') });
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(opener).toBeFocused();
  await opener.click();
  await page.mouse.click(5, 5);
  await expect(dialog).toBeHidden();
  await opener.click();
  await dialog.getByRole('button', { name: 'إغلاق' }).click();
  await expect(dialog).toBeHidden();
});

test('saved programs expose current session details, cancellation counts and truthful completion states', async ({ page }, testInfo) => {
  await mockApi(page);
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  await plans.getByRole('button', { name: 'عرض المزيد', exact: true }).click();
  await expect(plans.getByRole('article')).toHaveCount(6);
  const mixed = plans.getByRole('article').filter({ hasText: '2026-09-01' });
  await expect(mixed.locator(':scope > div > span')).toHaveText('جارٍ');
  for (const label of ['الإجمالي: 3', 'قادمة: 1', 'حضر: 1', 'ملغاة: 1']) await expect(mixed).toContainText(label);
  const sessions = mixed.getByRole('listitem');
  await expect(sessions).toHaveCount(3);
  await expect(sessions.nth(0)).toContainText('جلسة حديثة');
  await expect(sessions.nth(0)).toContainText('حضر');
  await expect(sessions.nth(1)).toContainText('جلسة قادمة');
  await expect(sessions.nth(1)).toContainText('2030-01-15');
  await expect(sessions.nth(1)).toContainText('14:00');
  await expect(sessions.nth(1)).toContainText('170 ₪');
  await expect(sessions.nth(1)).toContainText('قادم');
  await expect(sessions.nth(1)).not.toContainText('لم يحضر');
  await expect(sessions.nth(2)).toContainText('جلسة ملغاة');
  await expect(sessions.nth(2)).toContainText('ملغى');
  for (const [date, status] of [['2026-09-02', 'ملغى'], ['2026-09-03', 'مكتمل'], ['2026-09-04', 'انتهى دون اكتمال العلاج'], ['2026-09-05', 'بحاجة للتحقق'], ['2026-09-06', 'قادم']]) {
    const plan = plans.getByRole('article').filter({ hasText: date });
    await expect(plan.locator(':scope > div > span')).toHaveText(status);
  }
  await expect(mixed).toContainText('تم طلب إرسال رسالة المواعيد؛ لم يتأكد تسليمها بعد.');
  await expect(mixed).not.toContainText('تم إرسال المواعيد إلى الزبون');
  expect(await plans.getByRole('checkbox').count()).toBe(0);
  expect(await plans.getByRole('switch').count()).toBe(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await plans.scrollIntoViewIfNeeded();
  await page.screenshot({ path: testInfo.outputPath('saved-programs.png'), fullPage: true });
});

for (const phone of ['0501234567', '+972501234567']) {
  test(`profile contact links use the displayed phone and normalized WhatsApp number (${phone})`, async ({ page }) => {
    await mockApi(page, { handle: async ({ url, fulfill }) => {
      if (url.pathname !== '/api/admin/users/customer-one') return false;
      await fulfill({ ...profile, user: { ...profile.user, phone } });
      return true;
    } });
    await page.goto('/profile');
    const header = page.locator('header');
    await expect(header.getByRole('link', { name: 'اتصال', exact: true })).toHaveAttribute('href', `tel:${phone}`);
    const whatsapp = header.getByRole('link', { name: 'واتساب', exact: true });
    await expect(whatsapp).toHaveAttribute('href', 'https://wa.me/972501234567');
    await expect(whatsapp).toHaveAttribute('target', '_blank');
    await expect(whatsapp).toHaveAttribute('rel', /noreferrer/);
  });
}

test('saved program pagination appends three at a time using cursors and hides the final button', async ({ page }, testInfo) => {
  const calls = await mockApi(page);
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  const cards = plans.getByRole('article');
  const more = plans.getByRole('button', { name: 'عرض المزيد', exact: true });
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('2026-09-06');
  await expect(cards.nth(2)).toContainText('2026-09-04');
  await expect(more).toBeVisible();
  expect(calls.filter(call => call.path.endsWith('/treatment-plans'))).toHaveLength(0);
  await more.click();
  await expect(cards).toHaveCount(6);
  await expect(cards.nth(5)).toContainText('2026-09-01');
  await more.click();
  await expect(cards).toHaveCount(7);
  await expect(cards.nth(6)).toContainText('2026-08-31');
  await expect(more).toBeHidden();
  expect(calls.filter(call => call.path.endsWith('/treatment-plans')).map(call => [call.method, call.cursor])).toEqual([
    ['GET', '000000000000000000000004'], ['GET', '000000000000000000000001'],
  ]);
  await plans.screenshot({ path: testInfo.outputPath('programs-pagination-complete.png') });
});

test('saved program pagination locks rapid clicks while retaining the loaded cards', async ({ page }) => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (!url.pathname.endsWith('/treatment-plans') || request.method() !== 'GET') return false;
    await pending;
    await fulfill(planPageAfter(url.searchParams.get('cursor')));
    return true;
  } });
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  const more = plans.getByRole('button', { name: 'عرض المزيد', exact: true });
  await expect(more).toBeVisible();
  await more.evaluate(button => { button.click(); button.click(); button.click(); });
  await expect(plans.getByRole('button', { name: 'جارٍ تحميل البرامج...' })).toBeDisabled();
  await expect(plans.getByRole('article')).toHaveCount(3);
  await expect.poll(() => calls.filter(call => call.path.endsWith('/treatment-plans')).length).toBe(1);
  release();
  await expect(plans.getByRole('article')).toHaveCount(6);
  await expect(more).toBeEnabled();
  expect(calls.filter(call => call.path.endsWith('/treatment-plans'))).toHaveLength(1);
});

test('saved program pagination preserves cards and retries the same cursor after a failed request', async ({ page }) => {
  let failed = false;
  const calls = await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (!url.pathname.endsWith('/treatment-plans') || request.method() !== 'GET' || failed) return false;
    failed = true;
    await fulfill({ error: 'TEMPORARY_FAILURE' }, 503);
    return true;
  } });
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  const more = plans.getByRole('button', { name: 'عرض المزيد', exact: true });
  await expect(more).toBeVisible();
  await more.click();
  await expect(plans.getByRole('alert')).toContainText('تعذر تحميل المزيد من البرامج');
  await expect(plans.getByRole('article')).toHaveCount(3);
  await plans.getByRole('button', { name: 'إعادة المحاولة', exact: true }).click();
  await expect(plans.getByRole('article')).toHaveCount(6);
  await expect(plans.getByRole('alert')).toHaveCount(0);
  expect(calls.filter(call => call.path.endsWith('/treatment-plans')).map(call => call.cursor)).toEqual([
    '000000000000000000000004', '000000000000000000000004',
  ]);
});

test('saved program pagination deduplicates overlapping server pages by plan ID', async ({ page }) => {
  let pages = 0;
  await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (!url.pathname.endsWith('/treatment-plans') || request.method() !== 'GET') return false;
    pages++;
    await fulfill(pages === 1 ? { plans: allPlans.slice(2, 5), plansPagination: { hasMore: true, nextCursor: '000000000000000000000002' } } : { plans: allPlans.slice(4), plansPagination: { hasMore: false, nextCursor: null } });
    return true;
  } });
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  const more = plans.getByRole('button', { name: 'عرض المزيد', exact: true });
  await expect(more).toBeVisible();
  await more.click();
  await expect(plans.getByRole('article')).toHaveCount(5);
  await more.click();
  await expect(plans.getByRole('article')).toHaveCount(7);
  await expect(more).toBeHidden();
});

test('saved program pagination resets after saving and ignores an older in-flight page response', async ({ page }) => {
  let saved = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const newPlan = { ...allPlans[0], _id: '000000000000000000000008', createdAt: '2026-10-23T10:00:00Z' };
  const calls = await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'POST') { saved = true; return false; }
    if (url.pathname === '/api/admin/users/customer-one' && saved) {
      await fulfill({ ...profile, plans: [newPlan, ...allPlans.slice(0, 2)], plansPagination: { hasMore: true, nextCursor: '000000000000000000000005' } });
      return true;
    }
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'GET' && url.searchParams.get('cursor') === '000000000000000000000001') {
      await pending;
      await fulfill(planPageAfter(url.searchParams.get('cursor')));
      return true;
    }
    return false;
  } });
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  const cards = plans.getByRole('article');
  const more = plans.getByRole('button', { name: 'عرض المزيد', exact: true });
  await expect(more).toBeVisible();
  await more.click();
  await expect(cards).toHaveCount(6);
  await more.click();
  await expect(plans.getByRole('button', { name: 'جارٍ تحميل البرامج...' })).toBeDisabled();
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect(cards).toHaveCount(3);
  await expect(cards.nth(0)).toContainText('2026-10-23');
  const staleResponse = page.waitForResponse(response => response.url().includes('cursor=000000000000000000000001'));
  release();
  await (await staleResponse).finished();
  await more.click();
  await expect(cards).toHaveCount(6);
  await expect(cards.nth(0)).toContainText('2026-10-23');
  await expect(cards.nth(5)).toContainText('2026-09-02');
  expect(calls.filter(call => call.path.endsWith('/treatment-plans') && call.method === 'GET').map(call => call.cursor)).toEqual([
    '000000000000000000000004', '000000000000000000000001', '000000000000000000000005',
  ]);
});

const manyAppointments = Array.from({ length: 17 }, (_, index) => ({ ...profile.appointments[2], _id: `page-${index + 1}`, title: `جلسة رقم ${String(index + 1).padStart(2, '0')}`, date: `2030-02-${String(index + 1).padStart(2, '0')}`, bookingNote: '' }));
const visibleAppointments = region => region.locator('tbody tr, article').filter({ visible: true });
const canceledPlanId = '000000000000000000000002';

test('appointment paging uses 5 10 or 15 rows and obeys last-page bounds', async ({ page }, testInfo) => {
  await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (url.pathname !== '/api/admin/users/customer-one') return false;
    await fulfill({ ...profile, appointments: manyAppointments }); return true;
  } });
  await page.goto('/profile');
  const history = page.getByRole('region', { name: 'جميع المواعيد' });
  const size = history.getByRole('combobox', { name: 'عدد المواعيد في الصفحة' });
  const next = history.getByRole('button', { name: 'الصفحة التالية' });
  const previous = history.getByRole('button', { name: 'الصفحة السابقة' });
  await expect(size).toHaveValue('5');
  await expect(visibleAppointments(history)).toHaveCount(5);
  await expect(visibleAppointments(history).first()).toContainText('جلسة رقم 17');
  await expect(history).toContainText('عرض 1–5 من 17');
  await expect(previous).toBeDisabled();
  for (let index = 0; index < 3; index++) await next.click();
  await expect(history).toContainText('الصفحة 4 من 4');
  await expect(history).toContainText('عرض 16–17 من 17');
  await expect(visibleAppointments(history)).toHaveCount(2);
  await expect(next).toBeDisabled();
  await size.selectOption('10');
  await expect(history).toContainText('الصفحة 1 من 2');
  await expect(visibleAppointments(history)).toHaveCount(10);
  await expect(previous).toBeDisabled();
  await next.click();
  await expect(visibleAppointments(history)).toHaveCount(7);
  await size.selectOption('15');
  await expect(visibleAppointments(history)).toHaveCount(15);
  await expect(history).toContainText('الصفحة 1 من 2');
  await next.click();
  await expect(visibleAppointments(history)).toHaveCount(2);
  await expect(next).toBeDisabled();
  await previous.click();
  await expect(visibleAppointments(history)).toHaveCount(15);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await history.screenshot({ path: testInfo.outputPath('appointment-pagination.png') });
});

test('appointment paging clamps after profile refresh reduces the appointment count', async ({ page }) => {
  let saved = false;
  await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'POST') saved = true;
    if (url.pathname !== '/api/admin/users/customer-one') return false;
    await fulfill({ ...profile, appointments: saved ? manyAppointments.slice(0, 6) : manyAppointments }); return true;
  } });
  await page.goto('/profile');
  const history = page.getByRole('region', { name: 'جميع المواعيد' });
  const next = history.getByRole('button', { name: 'الصفحة التالية' });
  await expect(next).toBeVisible();
  for (let index = 0; index < 3; index++) await next.click();
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect(history).toContainText('الصفحة 2 من 2');
  await expect(visibleAppointments(history)).toHaveCount(1);
  await expect(next).toBeDisabled();
});

test('section collapse controls are independent and retain appointment and program pages', async ({ page }) => {
  await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (url.pathname !== '/api/admin/users/customer-one') return false;
    await fulfill({ ...profile, appointments: manyAppointments }); return true;
  } });
  await page.goto('/profile');
  const history = page.getByRole('region', { name: 'جميع المواعيد' });
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  const historyToggle = history.getByRole('button', { name: /جميع المواعيد/ });
  const plansToggle = plans.getByRole('button', { name: /البرامج المحفوظة/ });
  await expect(historyToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(historyToggle).toHaveAttribute('aria-controls', /.+/);
  await history.getByRole('button', { name: 'الصفحة التالية' }).click();
  await plans.getByRole('button', { name: 'عرض المزيد' }).click();
  await expect(plans.getByRole('article')).toHaveCount(6);
  await historyToggle.click();
  await expect(historyToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(history.getByRole('combobox')).toBeHidden();
  await expect(plans.getByRole('article')).toHaveCount(6);
  await plansToggle.click();
  await expect(plansToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(plans.getByRole('article')).toHaveCount(0);
  await historyToggle.click();
  await expect(history).toContainText('الصفحة 2 من 4');
  await expect(visibleAppointments(history).first()).toContainText('جلسة رقم 12');
  await plansToggle.click();
  await expect(plans.getByRole('article')).toHaveCount(6);
});

async function openCanceledProgram(page) {
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  await plans.getByRole('button', { name: 'عرض المزيد', exact: true }).click();
  const remove = plans.getByRole('button', { name: /حذف البرنامج الملغى/ });
  await expect(remove).toBeVisible();
  return { plans, remove };
}

test('canceled program deletion requires confirmation and every close action preserves the plan', async ({ page }, testInfo) => {
  const calls = await mockApi(page);
  await page.goto('/profile');
  const { plans, remove } = await openCanceledProgram(page);
  await expect(remove).toHaveCount(1);
  await expect(remove).toHaveAttribute('aria-label', /2026-09-02/);
  for (const close of ['cancel', 'escape', 'backdrop', 'x']) {
    await remove.click();
    const dialog = page.getByRole('dialog', { name: 'حذف البرنامج الملغى' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('2026-09-02');
    expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
    if (close === 'cancel') {
      await page.screenshot({ path: testInfo.outputPath('delete-plan-confirmation.png') });
      await dialog.getByRole('button', { name: 'إلغاء', exact: true }).click();
    } else if (close === 'escape') await page.keyboard.press('Escape');
    else if (close === 'backdrop') await page.mouse.click(5, 5);
    else await dialog.getByRole('button', { name: 'إغلاق', exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(remove).toBeFocused();
    await expect(plans.getByRole('article')).toHaveCount(6);
  }
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(0);
});

test('canceled program deletion rejects uncertain or partially canceled counts in the UI', async ({ page }) => {
  const canceled = allPlans.find(plan => plan._id === canceledPlanId);
  await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (url.pathname !== '/api/admin/users/customer-one') return false;
    await fulfill({ ...profile, plans: [canceled, { ...canceled, _id: 'unknown', status: 'unknown' }, { ...canceled, _id: 'partial', counts: { ...canceled.counts, total: 2, upcoming: 1 } }], plansPagination: { hasMore: false, nextCursor: null } }); return true;
  } });
  await page.goto('/profile');
  const plans = page.getByRole('region', { name: 'البرامج المحفوظة' });
  await expect(plans.getByRole('button', { name: /حذف البرنامج الملغى/ })).toHaveCount(1);
});

test('canceled program deletion sends once then refreshes programs and canceled appointment rows', async ({ page }) => {
  let deleted = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const calls = await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (request.method() === 'DELETE') { await pending; deleted = true; await fulfill({ success: true, deleted: true }); return true; }
    if (url.pathname === '/api/admin/users/customer-one' && deleted) { await fulfill({ ...profile, appointments: profile.appointments.filter(item => item._id !== 'canceled') }); return true; }
    return false;
  } });
  await page.goto('/profile');
  const { plans, remove } = await openCanceledProgram(page);
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'حذف البرنامج الملغى' });
  await dialog.getByRole('button', { name: 'تأكيد الحذف' }).evaluate(button => { button.click(); button.click(); });
  await expect(dialog.getByRole('button', { name: 'جارٍ الحذف...' })).toBeDisabled();
  await expect.poll(() => calls.filter(call => call.method === 'DELETE').length).toBe(1);
  release();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('status').filter({ hasText: 'تم حذف البرنامج' })).toBeVisible();
  await expect(plans.getByRole('article')).toHaveCount(3);
  await expect(page.getByRole('region', { name: 'جميع المواعيد' })).not.toContainText('جلسة ملغاة');
  expect(calls.filter(call => call.method === 'DELETE').map(call => call.path)).toEqual([`/api/admin/users/customer-one/treatment-plans/${canceledPlanId}`]);
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(0);
});

for (const status of [409, 500]) test(`canceled program deletion preserves the card after ${status} and retries only manually`, async ({ page }) => {
  let attempts = 0;
  const calls = await mockApi(page, { handle: async ({ request, fulfill }) => {
    if (request.method() !== 'DELETE') return false;
    attempts++;
    await fulfill(attempts === 1 ? { error: 'PLAN_CHANGED' } : { success: true, deleted: true }, attempts === 1 ? status : 200); return true;
  } });
  await page.goto('/profile');
  const { plans, remove } = await openCanceledProgram(page);
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'حذف البرنامج الملغى' });
  await dialog.getByRole('button', { name: 'تأكيد الحذف' }).click();
  await expect(dialog.getByRole('alert')).toContainText(status === 409 ? 'تغير البرنامج أو توجد مواعيد غير ملغاة' : 'تعذر حذف البرنامج');
  await expect(plans.locator('article')).toHaveCount(6);
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  await dialog.getByRole('button', { name: 'تأكيد الحذف' }).click();
  await expect(dialog).toBeHidden();
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(2);
});

for (const status of [409, 500]) test(`failed deletion ${status} preserves an in-flight successful save refresh`, async ({ page }) => {
  let saved = false;
  let profileRefreshes = 0;
  let releaseRefresh;
  const pendingRefresh = new Promise(resolve => { releaseRefresh = resolve; });
  const newPlan = { ...allPlans[0], _id: '000000000000000000000009', createdAt: '2026-10-24T10:00:00Z' };
  const calls = await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'POST') { saved = true; return false; }
    if (request.method() === 'DELETE') { await fulfill({ error: 'PLAN_CHANGED' }, status); return true; }
    if (url.pathname === '/api/admin/users/customer-one' && saved) {
      profileRefreshes++;
      await pendingRefresh;
      await fulfill({ ...profile, plans: [newPlan, ...allPlans.slice(0, 2)], plansPagination: { hasMore: true, nextCursor: '000000000000000000000005' } });
      return true;
    }
    return false;
  } });
  await page.goto('/profile');
  const { plans, remove } = await openCanceledProgram(page);
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  await expect.poll(() => profileRefreshes).toBe(1);
  await remove.click();
  const dialog = page.getByRole('dialog', { name: 'حذف البرنامج الملغى' });
  await dialog.getByRole('button', { name: 'تأكيد الحذف' }).click();
  await expect(dialog.getByRole('alert')).toContainText(status === 409 ? 'تغير البرنامج' : 'تعذر حذف البرنامج');
  await dialog.getByRole('button', { name: 'إلغاء', exact: true }).click();
  releaseRefresh();
  await expect(plans.getByRole('article').first()).toContainText('2026-10-24');
  await expect(plans.getByRole('article')).toHaveCount(3);
  await expect(plans.getByRole('button', { name: 'عرض المزيد', exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' })).toBeHidden();
  expect(calls.filter(call => call.method === 'POST')).toHaveLength(1);
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
  expect(profileRefreshes).toBe(1);
});

test('canceled program deletion keeps success when refreshing fails and retry never repeats DELETE', async ({ page }) => {
  let deleted = false;
  let failRefresh = true;
  const calls = await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (request.method() === 'DELETE') { deleted = true; await fulfill({ success: true, deleted: true }); return true; }
    if (url.pathname === '/api/admin/users/customer-one' && deleted) {
      await fulfill(failRefresh ? { error: 'TEMPORARY_FAILURE' } : { ...profile, appointments: profile.appointments.filter(item => item._id !== 'canceled') }, failRefresh ? 503 : 200); return true;
    }
    return false;
  } });
  await page.goto('/profile');
  const { plans, remove } = await openCanceledProgram(page);
  await remove.click();
  await page.getByRole('dialog').getByRole('button', { name: 'تأكيد الحذف' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'تم حذف البرنامج' })).toBeVisible();
  await expect(page.getByRole('alert').filter({ hasText: 'تعذر تحديث الملف' })).toBeVisible();
  await expect(plans.getByRole('article')).toHaveCount(5);
  await expect(plans.getByRole('button', { name: /حذف البرنامج الملغى/ })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'جميع المواعيد' })).not.toContainText('جلسة ملغاة');
  await expect(plans.getByRole('button', { name: 'عرض المزيد', exact: true })).toHaveCount(0);
  failRefresh = false;
  await page.getByRole('button', { name: 'تحديث قائمة المواعيد' }).click();
  await expect(plans.getByRole('article')).toHaveCount(3);
  await expect(page.getByRole('alert').filter({ hasText: 'تعذر تحديث الملف' })).toHaveCount(0);
  expect(calls.filter(call => call.method === 'DELETE')).toHaveLength(1);
});

test('canceled program deletion ignores a page response that started before deletion', async ({ page }) => {
  let deleted = false;
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  await mockApi(page, { handle: async ({ url, request, fulfill }) => {
    if (request.method() === 'DELETE') { deleted = true; await fulfill({ success: true, deleted: true }); return true; }
    if (deleted && url.pathname.endsWith('/treatment-plans') && request.method() === 'GET') {
      await fulfill({ plans: [allPlans[3], allPlans[5], allPlans[6]], plansPagination: { hasMore: false, nextCursor: null } }); return true;
    }
    if (url.pathname.endsWith('/treatment-plans') && request.method() === 'GET' && url.searchParams.get('cursor') === '000000000000000000000001') {
      await pending; await fulfill(planPageAfter(url.searchParams.get('cursor'))); return true;
    }
    return false;
  } });
  await page.goto('/profile');
  const { plans, remove } = await openCanceledProgram(page);
  await plans.getByRole('button', { name: 'عرض المزيد', exact: true }).click();
  await expect(plans.getByRole('button', { name: 'جارٍ تحميل البرامج...' })).toBeDisabled();
  await remove.click();
  await page.getByRole('dialog').getByRole('button', { name: 'تأكيد الحذف' }).click();
  await expect(plans.getByRole('article')).toHaveCount(3);
  const staleResponse = page.waitForResponse(response => response.url().includes('cursor=000000000000000000000001'));
  release(); await (await staleResponse).finished();
  await plans.getByRole('button', { name: 'عرض المزيد', exact: true }).click();
  await expect(plans.getByRole('article')).toHaveCount(6);
  await expect(plans.getByRole('button', { name: /حذف البرنامج الملغى/ })).toHaveCount(0);
});

test('successful provider acceptance does not claim message delivery after saving', async ({ page }) => {
  await mockApi(page, { handle: async ({ url, fulfill }) => {
    if (!url.pathname.endsWith('/treatment-plans')) return false;
    await fulfill({ success: true, planId: 'plan-new', appointmentIds: ['new-one'], notification: { status: 'sent' } });
    return true;
  } });
  await page.goto('/profile');
  await fillRow(page, 0, '10:00');
  await page.getByRole('button', { name: 'حفظ البرنامج وإرسال المواعيد' }).click();
  const saved = page.getByRole('status').filter({ hasText: 'تم حفظ البرنامج' });
  await expect(saved).toContainText('تم طلب إرسال رسالة المواعيد؛ لم يتأكد تسليمها بعد.');
  await expect(saved).not.toContainText('تم إرسال المواعيد إلى الزبون');
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

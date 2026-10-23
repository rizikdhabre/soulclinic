const { resolveRuntime } = require('../firebaseOtpV2/runtime.cjs');
const { test, expect } = require(resolveRuntime('playwright/test'));

function preview(body, token = 'preview-one') {
  const excluded = body.excludedDates.includes('2026-11-02');
  const group = body.groups[0];
  const times = group.mode === 'closed' ? ['10:00', '11:00'] : group.times;
  const blocks = group.mode === 'closed' ? times : group.blockedTimes;
  return {
    previewToken: token,
    conflicts: [], canApply: true,
    days: [
      { date: '2026-11-02', groupIndex: 0, status: excluded ? 'excluded' : 'apply', previousTimes: ['10:00', '11:00'], previousBlockedTimes: [], nextTimes: excluded ? ['10:00', '11:00'] : times, nextBlockedTimes: excluded ? [] : blocks, appointmentCount: 1, affectedAppointmentCount: excluded ? 0 : 1 },
      { date: '2026-11-09', groupIndex: 0, status: 'apply', previousTimes: ['10:00'], previousBlockedTimes: ['10:00'], nextTimes: times, nextBlockedTimes: blocks, appointmentCount: 0, affectedAppointmentCount: 0 },
      { date: '2026-11-16', groupIndex: 0, status: 'invalid', previousTimes: [], previousBlockedTimes: [], nextTimes: [], nextBlockedTimes: [], appointmentCount: 0, affectedAppointmentCount: 0 },
    ],
    summary: { apply: Number(!excluded) + 1, skipped: Number(excluded) + 1, existingAppointments: 1, affectedAppointments: 0 },
  };
}

const DEFAULT_STARTS = ['10:00', '10:30', '11:00', '11:30', '12:00', '12:30', '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30', '17:00', '17:30', '18:00', '18:30', '19:00', '19:30'];
function savedState(month, overrides = {}) {
  const count = new Date(`${month}-01T12:00:00Z`);
  count.setUTCMonth(count.getUTCMonth() + 1, 0);
  return { month, days: Array.from({ length: count.getUTCDate() }, (_, index) => {
    const date = `${month}-${String(index + 1).padStart(2, '0')}`;
    return { date, weekday: new Date(`${date}T12:00:00Z`).getUTCDay(), times: [...DEFAULT_STARTS], blockedTimes: [], appointmentTimes: [], valid: true, customized: false, ...overrides[date] };
  }) };
}

async function setup(page, handler) {
  const requests = { state: [], preview: [], apply: [] };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    window.scheduleChangedEvents = 0;
    window.addEventListener('appointments:changed', event => { window.scheduleChangedEvents += 1; window.scheduleChangedDetail = event.detail; });
  });
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const kind = path.endsWith('/state') ? 'state' : path.endsWith('/preview') ? 'preview' : path.endsWith('/apply') ? 'apply' : null;
    if (!kind) throw new Error(`Unexpected API request ${path}`);
    const body = kind === 'state' ? { month: new URL(route.request().url()).searchParams.get('month') } : route.request().postDataJSON();
    requests[kind].push(body);
    if (handler && await handler({ route, kind, body, requests })) return;
    await route.fulfill({ json: kind === 'state' ? savedState(body.month) : kind === 'preview' ? preview(body) : { success: true, requestId: body.requestId, summary: preview(body).summary, appliedDates: ['2026-11-02'] } });
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'تنظيم أوقات الشهر' })).toBeVisible();
  await page.getByLabel('الشهر', { exact: true }).fill('2026-11');
  await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeEnabled();
  return { requests, errors };
}

async function selectMonday(page) {
  await page.getByRole('group', { name: 'المجموعة 1', exact: true }).getByRole('button', { name: 'الاثنين', exact: true }).click();
}

test('saved state appears on initial load and revisit with a customized reference and no selected weekdays', async ({ page }) => {
  const moved = [...DEFAULT_STARTS.slice(1), '10:20'].sort();
  const { requests } = await setup(page, async ({ route, kind, body }) => {
    if (kind !== 'state') return false;
    await route.fulfill({ json: savedState(body.month, { '2026-11-02': { times: moved, blockedTimes: ['10:20'], appointmentTimes: ['11:00'], customized: true } }) });
    return true;
  });
  const first = page.getByRole('group', { name: 'المجموعة 1', exact: true });
  await expect(first.getByText('المرجع المحفوظ: 2026-11-02', { exact: true })).toBeVisible();
  await expect(first.locator('input[type="time"]')).toHaveCount(20);
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:20');
  await expect(first.getByRole('button', { name: 'الاثنين', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await expect(first.getByRole('button', { name: 'إلغاء حظر 10:20', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await selectMonday(page);
  await expect(first.getByText(/تختلف الجداول المحفوظة/)).toBeVisible();
  await page.getByLabel('الشهر', { exact: true }).fill('2026-12');
  await expect(first.getByText('المرجع المحفوظ: 2026-12-01', { exact: true })).toBeVisible();
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:00');
  await page.getByLabel('الشهر', { exact: true }).fill('2026-11');
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:20');
  await expect(first.getByRole('button', { name: 'إلغاء حظر 10:20', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(requests.state.filter(body => body.month === '2026-11')).toHaveLength(2);
  await page.reload();
  await page.getByLabel('الشهر', { exact: true }).fill('2026-11');
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:20');
  await expect(first.getByRole('button', { name: 'إلغاء حظر 10:20', exact: true })).toHaveAttribute('aria-pressed', 'true');
});

test('first selected weekday uses its saved reference and legacy missing starts stay blocked', async ({ page }) => {
  const { requests } = await setup(page, async ({ route, kind, body }) => {
    if (kind !== 'state') return false;
    await route.fulfill({ json: savedState(body.month, {
      '2026-11-01': { times: ['10:15', ...DEFAULT_STARTS.slice(1)], blockedTimes: [], customized: true },
      '2026-11-02': { times: ['10:30', '11:00'], blockedTimes: ['11:00'], customized: true },
      '2026-11-03': { times: DEFAULT_STARTS, blockedTimes: [], valid: false, customized: true },
      '2026-11-04': { times: DEFAULT_STARTS, blockedTimes: DEFAULT_STARTS, customized: true },
    }) });
    return true;
  });
  const first = page.getByRole('group', { name: 'المجموعة 1', exact: true });
  await selectMonday(page);
  await expect(first.getByText('المرجع المحفوظ: 2026-11-02', { exact: true })).toBeVisible();
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:00');
  await expect(first.getByRole('button', { name: 'إلغاء حظر 10:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByRole('button', { name: 'حظر 10:30', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await first.getByLabel('وقت البدء 2 للمجموعة 1', { exact: true }).fill('10:35');
  await first.getByRole('button', { name: 'الثلاثاء', exact: true }).click();
  await expect(first.getByLabel('وقت البدء 2 للمجموعة 1', { exact: true })).toHaveValue('10:35');
  await expect(first.getByText('المرجع المحفوظ: 2026-11-02', { exact: true })).toBeVisible();
  await expect(first.getByRole('button', { name: 'إلغاء حظر 11:00', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  expect(requests.preview[0].groups[0].blockedTimes).toContain('10:00');
  expect(requests.preview[0].groups[0].blockedTimes).not.toContain('10:35');
});

test('initial month shows a past saved customization while weekday selection prefers upcoming dates', async ({ page }) => {
  await page.clock.setFixedTime(new Date('2026-11-20T09:00:00Z'));
  await setup(page, async ({ route, kind, body }) => {
    if (kind !== 'state') return false;
    await route.fulfill({ json: savedState(body.month, { '2026-11-02': { times: ['10:15', ...DEFAULT_STARTS.slice(1)], customized: true } }) });
    return true;
  });
  const first = page.getByRole('group', { name: 'المجموعة 1', exact: true });
  await expect(first.getByText('المرجع المحفوظ: 2026-11-02', { exact: true })).toBeVisible();
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:15');
  await selectMonday(page);
  await expect(first.getByText('المرجع المحفوظ: 2026-11-23', { exact: true })).toBeVisible();
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:00');
});

test('month read failure prevents preview until retry succeeds and ignores late responses for previous months', async ({ page }) => {
  let failDecember = true;
  let releaseNovember;
  let holdNovember = false;
  const { requests } = await setup(page, async ({ route, kind, body }) => {
    if (kind !== 'state') return false;
    if (body.month === '2026-12' && failDecember) {
      await route.fulfill({ status: 503, json: { error: 'STATE_FAILED' } }); return true;
    }
    if (body.month === '2026-11' && holdNovember) {
      await new Promise(resolve => { releaseNovember = resolve; });
      await route.fulfill({ json: savedState(body.month, { '2026-11-02': { times: ['10:15', ...DEFAULT_STARTS.slice(1)], customized: true } }) }); return true;
    }
    return false;
  });
  await page.getByLabel('الشهر', { exact: true }).fill('2026-12');
  await expect(page.getByRole('alert')).toContainText('تعذر تحميل');
  await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeDisabled();
  failDecember = false;
  await page.getByRole('button', { name: 'إعادة تحميل الجدول', exact: true }).click();
  await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeEnabled();
  await expect(page.getByText('المرجع المحفوظ: 2026-12-01', { exact: true })).toBeVisible();
  holdNovember = true;
  await page.getByLabel('الشهر', { exact: true }).fill('2026-11');
  await expect.poll(() => Boolean(releaseNovember)).toBe(true);
  await page.getByLabel('الشهر', { exact: true }).fill('2026-12');
  await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeEnabled();
  await expect(page.getByText('المرجع المحفوظ: 2026-12-01', { exact: true })).toBeVisible();
  const lateResponse = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/state') && new URL(response.url()).searchParams.get('month') === '2026-11');
  releaseNovember();
  await lateResponse;
  await expect(page.getByText('المرجع المحفوظ: 2026-12-01', { exact: true })).toBeVisible();
  await expect(page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:00');
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  expect(requests.preview[0].month).toBe('2026-12');
  expect(requests.preview[0].groups[0].times[0]).toBe('10:00');
});

test('preview booking conflicts show dates and times and prevent applying', async ({ page }) => {
  const { requests } = await setup(page, async ({ route, kind, body }) => {
    if (kind !== 'preview') return false;
    await route.fulfill({ json: { ...preview(body), canApply: false, conflicts: [{ date: '2026-11-02', time: '10:15' }], summary: { ...preview(body).summary, affectedAppointments: 1 } } });
    return true;
  });
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  const conflicts = page.getByRole('region', { name: 'مواعيد تتعارض مع التغيير', exact: true });
  await expect(conflicts).toContainText('2026-11-02');
  await expect(conflicts).toContainText('10:15');
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeDisabled();
  expect(requests.apply).toHaveLength(0);
});

test('new appointment conflict resolves an uncertain request and retains preview with useful conflict details', async ({ page }) => {
  await setup(page, async ({ route, kind, requests }) => {
    if (kind !== 'apply') return false;
    if (requests.apply.length === 1) await route.abort('connectionreset');
    else await route.fulfill({ status: 409, json: { error: 'APPOINTMENT_CONFLICT', message: 'توجد مواعيد تتعارض مع التغيير', conflicts: [{ date: '2026-11-09', time: '10:30' }] } });
    return true;
  });
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await page.getByRole('button', { name: 'تطبيق الجدول', exact: true }).click();
  await page.getByRole('button', { name: 'إعادة محاولة الحفظ', exact: true }).click();
  await expect(page.getByRole('region', { name: 'مواعيد تتعارض مع التغيير', exact: true })).toContainText('2026-11-09');
  await expect(page.getByRole('region', { name: 'مواعيد تتعارض مع التغيير', exact: true })).toContainText('10:30');
  await expect(page.getByLabel('الشهر', { exact: true })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'إعادة محاولة الحفظ', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('معاينة الجدول', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.scheduleChangedEvents)).toBe(0);
});

for (const outcome of ['success', 'conflict']) {
  test(`apply ${outcome} preserves viewport and preview geometry`, async ({ page }) => {
    let finish;
    let persisted = false;
    const wait = new Promise(resolve => { finish = resolve; });
    const { requests } = await setup(page, async ({ route, kind, body }) => {
      if (kind === 'state' && outcome === 'success' && body.month === '2026-11') {
        const overrides = persisted ? Object.fromEntries(['2026-11-02', '2026-11-09', '2026-11-16', '2026-11-23', '2026-11-30'].map(date => [date, { times: ['10:15', ...DEFAULT_STARTS.slice(1)], customized: true }])) : { '2026-11-02': { times: ['10:05', ...DEFAULT_STARTS.slice(1)], customized: true } };
        await route.fulfill({ json: savedState(body.month, overrides) }); return true;
      }
      if (kind !== 'apply') return false;
      await wait;
      if (outcome === 'conflict') await route.fulfill({ status: 409, json: { error: 'APPOINTMENT_CONFLICT', conflicts: [{ date: '2026-11-02', time: '10:00' }] } });
      else { persisted = true; await route.fulfill({ json: { success: true, requestId: body.requestId, appliedDates: ['2026-11-02'], summary: preview(body).summary } }); }
      return true;
    });
    await selectMonday(page);
    await page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:15');
    await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
    const apply = page.getByRole('button', { name: 'تطبيق الجدول', exact: true });
    await apply.scrollIntoViewIfNeeded();
    const before = await page.evaluate(() => ({ x: scrollX, y: scrollY, height: document.querySelector('[aria-label="معاينة الجدول"]').getBoundingClientRect().height }));
    await apply.evaluate(button => button.click());
    await expect.poll(() => requests.apply.length).toBe(1);
    finish();
    if (outcome === 'success') await expect(page.getByRole('status')).toContainText('تم تطبيق');
    else await expect(page.getByRole('alert')).toContainText('تتعارض');
    await expect(page.getByLabel('الشهر', { exact: true })).toBeEnabled();
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const after = await page.evaluate(() => ({ x: scrollX, y: scrollY, height: document.querySelector('[aria-label="معاينة الجدول"]').getBoundingClientRect().height }));
    expect(after).toEqual(before);
    if (outcome === 'success') {
      expect(await page.evaluate(() => window.scheduleChangedDetail)).toEqual({ month: '2026-11', appliedDates: ['2026-11-02'] });
      await expect(page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:15');
      expect(requests.state.filter(body => body.month === '2026-11').length).toBeGreaterThan(1);
    }
  });
}

test('a deliberate scroll while saving is retained after confirmation', async ({ page }) => {
  let finish;
  const wait = new Promise(resolve => { finish = resolve; });
  await setup(page, async ({ route, kind, body }) => {
    if (kind !== 'apply') return false;
    await wait;
    await route.fulfill({ json: { success: true, requestId: body.requestId, appliedDates: ['2026-11-02'], summary: preview(body).summary } });
    return true;
  });
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  const apply = page.getByRole('button', { name: 'تطبيق الجدول', exact: true });
  await apply.scrollIntoViewIfNeeded();
  await apply.evaluate(button => button.click());
  await expect(page.getByRole('status')).toContainText('جارٍ التحقق');
  const previous = await page.evaluate(() => scrollY);
  await page.mouse.move(10, 100);
  await page.mouse.wheel(0, -250);
  await expect.poll(() => page.evaluate(() => scrollY)).toBeLessThan(previous);
  const intended = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  finish();
  await expect(page.getByRole('status')).toContainText('تم تطبيق');
  await expect(page.getByLabel('الشهر', { exact: true })).toBeEnabled();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(intended);
});

test('failed saved-state refresh after confirmed apply keeps the draft and viewport through retry', async ({ page }) => {
  let applied = false;
  let failed = false;
  await setup(page, async ({ route, kind, body }) => {
    if (kind === 'apply') {
      applied = true;
      await route.fulfill({ json: { success: true, requestId: body.requestId, appliedDates: ['2026-11-02'], summary: preview(body).summary } });
      return true;
    }
    if (kind === 'state' && applied && !failed) {
      failed = true;
      await route.fulfill({ status: 503, json: { error: 'STATE_FAILED' } });
      return true;
    }
    return false;
  });
  await selectMonday(page);
  await page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:15');
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  const apply = page.getByRole('button', { name: 'تطبيق الجدول', exact: true });
  await apply.scrollIntoViewIfNeeded();
  const before = await page.evaluate(() => ({ x: scrollX, y: scrollY }));
  await apply.evaluate(button => button.click());
  await expect(page.getByRole('alert')).toContainText('تعذر تحميل');
  await expect(page.getByLabel('الشهر', { exact: true })).toBeEnabled();
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  expect(await page.evaluate(() => ({ x: scrollX, y: scrollY }))).toEqual(before);
  await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'إعادة تحميل الجدول', exact: true }).click();
  await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeEnabled();
  await expect(page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:15');
  await expect(page.getByRole('group', { name: 'المجموعة 1', exact: true }).getByRole('button', { name: 'الاثنين', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => window.scheduleChangedEvents)).toBe(1);
});

test('initial apply double clicks produce one write and one refresh only after confirmation', async ({ page }) => {
  let confirm;
  const awaitingConfirmation = new Promise(resolve => { confirm = resolve; });
  const { requests } = await setup(page, async ({ kind, route, body }) => {
    if (kind !== 'apply') return false;
    await awaitingConfirmation;
    await route.fulfill({ json: { success: true, requestId: body.requestId, summary: { apply: 1, skipped: 2, existingAppointments: 1, affectedAppointments: 1 }, appliedDates: ['2026-11-02'] } });
    return true;
  });
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await page.getByRole('button', { name: 'تطبيق الجدول', exact: true }).evaluate(button => { button.click(); button.click(); });
  await expect(page.getByRole('status')).toContainText('جارٍ التحقق');
  expect(requests.apply).toHaveLength(1);
  expect(await page.evaluate(() => window.scheduleChangedEvents)).toBe(0);
  await expect(page.getByLabel('الشهر', { exact: true })).toBeDisabled();
  confirm();
  await expect(page.getByRole('status')).toContainText('تم تطبيق');
  expect(await page.evaluate(() => window.scheduleChangedEvents)).toBe(1);
});

test('existing rows edit and block without row additions or deletion, and closure keeps red locked rows', async ({ page }, testInfo) => {
  const { requests, errors } = await setup(page);
  await selectMonday(page);
  const first = page.getByRole('group', { name: 'المجموعة 1', exact: true });
  await first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:15');
  await first.getByRole('button', { name: 'حظر 10:15', exact: true }).click();
  await first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:20');
  await expect(first.getByRole('button', { name: /حذف وقت البدء|إضافة وقت بدء/ })).toHaveCount(0);
  await expect(page.getByLabel('الأيام المعدلة سابقاً')).toHaveCount(0);
  await expect(first.getByRole('button', { name: 'إلغاء حظر 10:20', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const blockedRow = first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).locator('..').locator('..');
  await expect(blockedRow).toHaveCSS('background-color', 'rgb(254, 242, 242)');
  expect(await first.getByRole('button', { name: 'إلغاء حظر 10:20', exact: true }).evaluate(button => getComputedStyle(button).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
  await expect(first.getByLabel('وقت البدء 20 للمجموعة 1', { exact: true })).toBeVisible();
  const collapse = page.getByRole('button', { name: 'طي تنظيم أوقات الشهر', exact: true });
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await collapse.click();
  const expand = page.getByRole('button', { name: 'توسيع تنظيم أوقات الشهر', exact: true });
  await expect(expand).toHaveAttribute('aria-expanded', 'false');
  await expect(page.getByLabel('الشهر', { exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeHidden();
  await expand.click();
  await expect(collapse).toHaveAttribute('aria-expanded', 'true');
  await expect(first.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true })).toHaveValue('10:20');
  await expect(first.getByRole('button', { name: 'إلغاء حظر 10:20', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(first.getByRole('button', { name: 'الاثنين', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'إضافة مجموعة', exact: true }).click();
  const second = page.getByRole('group', { name: 'المجموعة 2', exact: true });
  await expect(page.getByRole('button', { name: /حذف المجموعة/ })).toHaveCount(0);
  await expect(second.getByRole('button', { name: 'الاثنين', exact: true })).toBeDisabled();
  await second.getByRole('button', { name: 'اختيار الأيام المتبقية', exact: true }).click();
  await second.getByRole('button', { name: 'إغلاق اليوم بالكامل', exact: true }).click();
  await expect(second.locator('input[type="time"]')).toHaveCount(20);
  await expect(second.getByRole('button', { name: 'إلغاء حظر 10:00', exact: true })).toBeDisabled();
  await expect(second.getByRole('button', { name: 'إلغاء حظر 10:00', exact: true })).toHaveCSS('opacity', '1');
  await expect(second.getByLabel('وقت البدء 1 للمجموعة 2', { exact: true }).locator('..').locator('..')).toHaveCSS('background-color', 'rgb(254, 242, 242)');
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeEnabled();
  expect(requests.preview).toHaveLength(1);
  expect(requests.preview[0].groups[0].weekdays).toEqual([1]);
  expect(requests.preview[0].groups[0].times).toContain('10:20');
  expect(requests.preview[0].groups[0].blockedTimes).toEqual(['10:20']);
  expect(requests.preview[0].groups[1]).toEqual({ weekdays: [0, 2, 3, 4, 5, 6], mode: 'closed' });
  expect(requests.preview[0]).not.toHaveProperty('customizedDays');
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('monthly-groups-preview.png'), fullPage: true });
});

test('exclusions and edited starts invalidate approval until refreshed and expose existing appointments', async ({ page }) => {
  const { requests } = await setup(page);
  await selectMonday(page);
  await page.getByRole('button', { name: 'إضافة مجموعة', exact: true }).click();
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByText('مواعيد موجودة', { exact: true })).toBeVisible();
  expect(requests.preview[0].groups).toHaveLength(1);
  expect(requests.preview[0].groups[0].weekdays).toEqual([1]);
  await expect(page.getByText('بيانات تحتاج مراجعة', { exact: true })).toBeVisible();
  await page.getByLabel('استثناء 2026-11-02', { exact: true }).check();
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeEnabled();
  expect(requests.preview[1].excludedDates).toEqual(['2026-11-02']);
  expect(requests.preview[1].groups).toHaveLength(1);
  await page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:05');
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeDisabled();
});

test('empty first group does not block a selected second group or change its preview number', async ({ page }) => {
  const { requests } = await setup(page);
  await page.getByRole('button', { name: 'إضافة مجموعة', exact: true }).click();
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('اختر');
  expect(requests.preview).toHaveLength(0);
  const second = page.getByRole('group', { name: 'المجموعة 2', exact: true });
  await second.getByRole('button', { name: 'الاثنين', exact: true }).click();
  await second.getByLabel('وقت البدء 1 للمجموعة 2', { exact: true }).fill('10:15');
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeEnabled();
  expect(requests.preview).toHaveLength(1);
  expect(requests.preview[0].groups).toHaveLength(1);
  expect(requests.preview[0].groups[0].weekdays).toEqual([1]);
  expect(requests.preview[0].groups[0].times).toContain('10:15');
  const result = page.getByLabel('معاينة الجدول', { exact: true });
  await expect(result.getByText('المجموعة 2', { exact: true })).toHaveCount(3);
  await expect(result.getByText('المجموعة 1', { exact: true })).toHaveCount(0);
});

for (const failure of ['network', 'server']) {
  test(`${failure} uncertainty freezes edits and retries the original request exactly once`, async ({ page }) => {
    const { requests } = await setup(page, async ({ route, kind, body, requests: sent }) => {
      if (kind !== 'apply') return false;
      if (sent.apply.length === 1) {
        if (failure === 'network') await route.abort('connectionreset');
        else await route.fulfill({ status: 503, json: { error: 'SCHEDULE_STORAGE_UNAVAILABLE', message: 'الخدمة غير متاحة' } });
      } else {
        await new Promise(resolve => setTimeout(resolve, 200));
        await route.fulfill({ json: { success: true, requestId: body.requestId, summary: { apply: 1, skipped: 2, existingAppointments: 1, affectedAppointments: 1 }, appliedDates: ['2026-11-02'] } });
      }
      return true;
    });
    await selectMonday(page);
    await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
    await page.getByRole('button', { name: 'تطبيق الجدول', exact: true }).click();
    const retry = page.getByRole('button', { name: 'إعادة محاولة الحفظ', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByRole('alert')).toContainText('لم نتأكد');
    await expect(page.getByLabel('الشهر', { exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'معاينة التغييرات', exact: true })).toBeDisabled();
    await expect(page.getByLabel('استثناء 2026-11-02', { exact: true })).toBeDisabled();
    expect(await page.evaluate(() => window.scheduleChangedEvents)).toBe(0);
    await retry.evaluate(button => { button.click(); button.click(); });
    await expect(page.getByRole('status')).toContainText('تم تطبيق');
    expect(requests.apply).toHaveLength(2);
    expect(requests.apply[1]).toEqual(requests.apply[0]);
    expect(requests.apply[0].requestId).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i);
    expect(await page.evaluate(() => window.scheduleChangedEvents)).toBe(1);
    await expect(page.getByLabel('الشهر', { exact: true })).toBeEnabled();
  });
}

test('stale response requires a fresh preview and creates a new attempt identifier', async ({ page }) => {
  const { requests } = await setup(page, async ({ route, kind, requests: sent }) => {
    if (kind === 'apply' && sent.apply.length === 1) {
      await route.fulfill({ status: 409, json: { error: 'SCHEDULE_CHANGED', message: 'تغير الجدول' } });
      return true;
    }
    return false;
  });
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await page.getByRole('button', { name: 'تطبيق الجدول', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('معاينة');
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeDisabled();
  expect(await page.evaluate(() => window.scheduleChangedEvents)).toBe(0);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await page.getByRole('button', { name: 'تطبيق الجدول', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('تم تطبيق');
  expect(requests.preview).toHaveLength(2);
  expect(requests.apply[1].requestId).not.toBe(requests.apply[0].requestId);
});

test('expired session after uncertain apply retains the same request until authentication recovers', async ({ page }) => {
  const { requests } = await setup(page, async ({ route, kind, requests: sent }) => {
    if (kind !== 'apply' || sent.apply.length > 2) return false;
    if (sent.apply.length === 1) await route.abort('connectionreset');
    else await route.fulfill({ status: 401, json: { error: 'UNAUTHORIZED' } });
    return true;
  });
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await page.getByRole('button', { name: 'تطبيق الجدول', exact: true }).click();
  await page.getByRole('button', { name: 'إعادة محاولة الحفظ', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('تسجيل الدخول');
  await expect(page.getByLabel('الشهر', { exact: true })).toBeDisabled();
  await page.getByRole('button', { name: 'إعادة محاولة الحفظ', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('تم تطبيق');
  expect(requests.apply).toHaveLength(3);
  expect(requests.apply[1]).toEqual(requests.apply[0]);
  expect(requests.apply[2]).toEqual(requests.apply[0]);
});

test('malformed preview response has an Arabic error and never enables apply', async ({ page }) => {
  await setup(page, async ({ route, kind }) => {
    if (kind !== 'preview') return false;
    await route.fulfill({ contentType: 'text/html', body: '<html>upstream error</html>' });
    return true;
  });
  await selectMonday(page);
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('تعذرت');
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeDisabled();
});

test('invalid starts and failed preview display actionable errors without applying', async ({ page }) => {
  const { requests, errors } = await setup(page, async ({ route, kind }) => {
    if (kind !== 'preview') return false;
    await route.fulfill({ status: 500, json: { error: 'PREVIEW_FAILED', message: 'تعذرت المعاينة حالياً' } });
    return true;
  });
  await selectMonday(page);
  await page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('09:00');
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('10:00');
  expect(requests.preview).toHaveLength(0);
  await page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:30');
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('مكرر');
  await page.getByLabel('وقت البدء 1 للمجموعة 1', { exact: true }).fill('10:00');
  await page.getByRole('button', { name: 'معاينة التغييرات', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('تعذرت المعاينة');
  await expect(page.getByRole('button', { name: 'تطبيق الجدول', exact: true })).toBeDisabled();
  expect(requests.apply).toHaveLength(0);
  expect(errors).toEqual([]);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

// Isolated UI check: real component, fake catalogue/API, no Next server or database.
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const { root, resolveRuntime } = require('../e2e/firebaseOtpV2/runtime.cjs');
const { chromium } = require(resolveRuntime('playwright'));
const { expect } = require(resolveRuntime('playwright/test'));

async function main() {
  const esbuild = require(resolveRuntime('esbuild'));
  const postcss = require('postcss');
  const tailwind = require('tailwindcss');
  const built = await esbuild.build({
    absWorkingDir: root, entryPoints: [path.join(__dirname, 'harness.jsx')], bundle: true,
    write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'jsx', setup(build) {
      build.onLoad({ filter: /src[\\/].*\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'jsx' }));
      build.onResolve({ filter: /^(mongodb|twilio|firebase|dotenv|node:)/ }, args => ({ errors: [{ text: `Unexpected backend dependency ${args.path}` }] }));
    } }],
  });
  const css = postcss.parse(fs.readFileSync(path.join(root, 'src/app/globals.css'), 'utf8'));
  css.walkAtRules('import', rule => rule.remove());
  const styles = await postcss([tailwind({ ...require(path.join(root, 'tailwind.config.js')), content: [path.join(root, 'src/app/admin/treatments/page.js')] })]).process(css, { from: undefined });
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(built.outputFiles[0].contents); }
    else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(styles.css); }
    else res.end('<!doctype html><html dir="rtl"><head><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(error => { server.close(); throw error; });
  try {
    for (const mobile of [false, true]) {
      const context = await browser.newContext({ viewport: mobile ? { width: 390, height: 844 } : { width: 1280, height: 1000 }, isMobile: mobile, hasTouch: mobile });
      const page = await context.newPage();
      const rows = [{ _id: '111111111111111111111111', title: 'حجامة', description: 'وصف', services: [{ _id: 's1', title: 'حجامة ١' }, { _id: 's2', title: 'حجامة ٢' }] }, { _id: '222222222222222222222222', title: 'مساج', description: 'وصف', services: [] }];
      const calls = [];
      let failSaves = true;
      await page.route('**/*', async route => {
        const req = route.request();
        const url = new URL(req.url());
        if (url.origin !== origin) return route.abort();
        if (!url.pathname.startsWith('/api/')) return route.continue();
        if (req.method() === 'GET') return route.fulfill({ json: rows, headers: { 'x-treatment-order-owner': 'test-admin' } });
        calls.push({ path: url.pathname, body: req.postDataJSON() });
        if (failSaves) return route.abort('internetdisconnected');
        return route.fulfill({ status: 202, json: { accepted: true } });
      });
      await page.goto(origin);
      const handles = page.getByRole('button', { name: /^ترتيب / });
      await expect(handles).toHaveCount(2);
      await expect(handles.first()).toBeEnabled();
      async function drag(source, target) {
        const a = await source.boundingBox();
        const b = await target.boundingBox();
        if (!mobile) {
          await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
          await page.mouse.down();
          await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2 + 8, { steps: 15 });
          await page.mouse.up();
        } else {
          const session = await context.newCDPSession(page);
          const x = a.x + a.width / 2, startY = a.y + a.height / 2, endY = b.y + b.height / 2 + 8;
          await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: startY }] });
          for (let step = 1; step <= 12; step++) await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: startY + (endY - startY) * step / 12 }] });
          await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
          await session.detach();
        }
      }
      await drag(handles.first(), handles.last());
      await expect(handles.first()).toHaveAttribute('aria-label', 'ترتيب مساج');
      await expect.poll(() => calls.length).toBeGreaterThan(0);
      // Open the cupping category; the moved category retains the correct actions.
      const category = page.getByRole('button', { name: 'ترتيب حجامة', exact: true }).locator('..');
      await category.getByRole('button', { name: '⋮', exact: true }).click();
      await category.getByRole('button', { name: 'عرض', exact: true }).click();
      const subhandles = mobile ? category.getByRole('button', { name: 'Drag', exact: true }) : category.locator('td[role="button"]');
      await expect(subhandles).toHaveCount(2);
      await subhandles.first().scrollIntoViewIfNeeded();
      await drag(subhandles.first(), subhandles.last());
      const subOrder = () => page.evaluate(() => JSON.parse(localStorage.getItem('soul:treatment-order:test-admin')).entries['111111111111111111111111'].payload.order);
      await expect.poll(subOrder).toEqual(['s2', 's1']);
      await expect.poll(() => calls.length, { timeout: 9000 }).toBeGreaterThan(0);
      // Failed saves survive a reload, then reconnect retries both latest orders.
      await page.reload();
      await expect(handles.first()).toHaveAttribute('aria-label', 'ترتيب مساج');
      failSaves = false;
      await page.evaluate(() => window.dispatchEvent(new Event('online')));
      await expect.poll(() => page.evaluate(() => Object.keys(JSON.parse(localStorage.getItem('soul:treatment-order:test-admin')).entries).length), { timeout: 9000 }).toBe(0);
      assert(calls.some(call => call.path.endsWith('/services/reorder') && call.body.order.join() === 's2,s1'));
      assert(calls.some(call => call.path === '/api/admin/treatments/reorder' && call.body.order[0] === rows[1]._id));
      assert(calls.every(call => call.body.clientId && call.body.sequence > 0 && call.body.owner === 'test-admin'));
      console.log(`${mobile ? 'Mobile touch' : 'Desktop'}: instant drag, immediate server handoff, failure/reload/reconnect passed`);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

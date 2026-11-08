// Real date components rendered in an isolated static fixture, with no API/DB.
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
    outdir: path.join(__dirname, 'artifacts/bundle'), write: false, format: 'iife', platform: 'browser', jsx: 'automatic',
    alias: { '@': path.join(root, 'src') }, define: { 'process.env.NODE_ENV': '"development"' },
    plugins: [{ name: 'isolated-ui', setup(build) {
      build.onLoad({ filter: /src[\\/].*\.js$/ }, args => ({ contents: fs.readFileSync(args.path, 'utf8'), loader: 'jsx' }));
      build.onResolve({ filter: /^(mongodb|twilio|firebase|dotenv|node:)/ }, args => ({ errors: [{ text: `Unexpected backend dependency ${args.path}` }] }));
    } }],
  });
  const css = postcss.parse(fs.readFileSync(path.join(root, 'src/app/globals.css'), 'utf8'));
  css.walkAtRules('import', rule => rule.remove());
  const styles = await postcss([tailwind({ ...require(path.join(root, 'tailwind.config.js')), safelist: ['dark'],
    content: [path.join(root, 'src/components/ui/HijriCuppingTable.jsx'), path.join(root, 'src/components/ui/AnimatedCalendar.jsx'), path.join(__dirname, 'harness.jsx')] })]).process(css, { from: undefined });
  const javascript = built.outputFiles.find(file => file.path.endsWith('.js')).contents;
  const moduleCss = built.outputFiles.filter(file => file.path.endsWith('.css')).map(file => file.text).join('\n');
  const server = http.createServer((req, res) => {
    if (req.url === '/app.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(javascript); }
    else if (req.url === '/style.css') { res.setHeader('Content-Type', 'text/css'); res.end(styles.css + '\n' + moduleCss); }
    else res.end('<!doctype html><html class="dark" lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"></head><body><div id="root"></div><script src="/app.js"></script></body></html>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const browser = await chromium.launch({ headless: true, channel: 'chrome' }).catch(error => { server.close(); throw error; });
  const artifactDir = path.join(__dirname, 'artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  try {
    for (const width of [1280, 390]) {
      const context = await browser.newContext({ viewport: { width, height: 1050 }, timezoneId: 'Asia/Jerusalem', hasTouch: width < 500, isMobile: width < 500 });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      await page.clock.setFixedTime(new Date('2026-11-08T12:00:00Z'));
      await page.route('**/*', route => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
      await page.goto(origin);
      assert.equal(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--background').trim()), '160 25% 8%', 'fixture retains the real dark theme tokens');
      const home = page.getByTestId('home-dates');
      const calendar = page.getByTestId('booking-calendar');
      await expect(home.getByText('اليوم', { exact: true })).toBeVisible();
      await expect(home.locator('article')).toHaveCount(3);
      await expect(home.getByRole('button')).toHaveCount(0);
      await expect(home.getByText('الموعد الأقرب', { exact: true })).toBeVisible();
      await expect(page.getByText('التاريخ المختار', { exact: true })).toHaveCount(0);

      const marked = () => calendar.locator('button[data-hijri-cupping="true"]');
      const markedNumbers = () => marked().evaluateAll(elements => elements.map(el => el.textContent.trim()));
      await expect.poll(markedNumbers).toEqual(['1', '27', '29']);
      await expect(marked().first()).toBeDisabled();
      await expect(calendar).toContainText('ايام الحجامة الهجرية : ١•٢٧•٢٩');
      const day27 = marked().filter({ hasText: /^27$/ });
      await day27.click();
      await expect(day27).toHaveAttribute('aria-pressed', 'true');
      await expect(day27).toHaveClass(/bg-primary/);
      await expect(day27.locator('[data-hijri-ring]')).toBeVisible();
      const ringStyle = await day27.locator('[data-hijri-ring]').evaluate(el => ({ radius: getComputedStyle(el).borderRadius, border: getComputedStyle(el).borderTopWidth, opacity: getComputedStyle(el).opacity }));
      assert(Number.parseFloat(ringStyle.border) >= 1, 'selected gold ring has a visible border');
      assert(ringStyle.radius === '50%' || Number.parseFloat(ringStyle.radius) > 20, 'gold marker remains circular');
      assert(Number.parseFloat(ringStyle.opacity) > 0, 'selected gold ring is not hidden');
      await expect(page.getByTestId('selected')).toHaveText('2026-11-27');
      await page.getByTestId('restrict').click();
      await expect(day27).toBeDisabled();
      await expect(marked().filter({ hasText: /^29$/ })).toBeEnabled();
      await page.getByTestId('restrict').click();

      await calendar.getByRole('button', { name: 'الشهر التالي', exact: true }).click();
      await expect(calendar.getByRole('heading', { name: 'December 2026' })).toBeVisible();
      await calendar.getByRole('button', { name: 'الشهر التالي', exact: true }).click();
      await expect(calendar.getByRole('heading', { name: 'January 2027' })).toBeVisible();
      await expect.poll(markedNumbers).toEqual(['25', '27', '29']);
      await expect(calendar).toContainText('ايام الحجامة الهجرية : ٢٥•٢٧•٢٩');
      await marked().first().click();
      await expect(marked().first()).toHaveAttribute('aria-pressed', 'true');
      await expect(marked().first().locator('[data-hijri-ring]')).toBeVisible();
      await expect(page.getByTestId('selected')).toHaveText('2027-1-25');
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'no horizontal overflow');
      await page.screenshot({ path: path.join(artifactDir, `calendar-${width}.png`), fullPage: true });
      if (width === 390) {
        await page.setViewportSize({ width: 320, height: 1050 });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, '320px remains free of overflow');
        await page.screenshot({ path: path.join(artifactDir, 'calendar-320.png'), fullPage: true });
        await page.setViewportSize({ width: 390, height: 1050 });
        await page.evaluate(() => document.documentElement.classList.remove('dark'));
        await expect(marked().first().locator('[data-hijri-ring]')).toBeVisible();
        await page.screenshot({ path: path.join(artifactDir, 'calendar-390-light.png'), fullPage: true });
      }
      assert.deepEqual(errors, [], 'no runtime errors');
      console.log(`${width}px: cards, dynamic markers/legend, selection, disabled dates and layout passed`);
      await context.close();
    }
  } finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
}
main().catch(error => { console.error(error); process.exitCode = 1; });

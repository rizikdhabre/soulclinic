import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { resolveRuntime } = require("../tests/e2e/firebaseOtpV2/runtime.cjs");
const { chromium } = require(resolveRuntime("playwright/test"));
const origin = new URL(process.argv[2]).origin;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ javaScriptEnabled: false });
await context.route("**/*", (route) => route.abort());
const page = await context.newPage();

async function html(path) {
  const response = await fetch(new URL(path, origin));
  assert.equal(response.status, 200, `${path} responds 200`);
  await page.setContent(await response.text(), { waitUntil: "domcontentloaded" });
}

try {
  for (const path of ["/", "/about", "/contact", "/dashboard"]) {
    await html(path);
    for (const target of ["/dashboard", "/about", "/contact"]) {
      assert.ok(await page.locator(`footer a[href="${target}"]`).count(), `${path}: permanent footer link to ${target}`);
    }
  }
  await html("/dashboard");
  const categories = [...new Set(await page.locator('main a[href^="/treatments/"]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href"))))];
  assert.ok(categories.length, "catalogue exposes real treatment links in initial HTML");
  await html("/");
  const featured = await page.locator('main a[href^="/treatments/"]').evaluateAll((anchors) => anchors.map((a) => a.getAttribute("href")));
  assert.ok(featured.length > 0 && featured.length <= 3, "homepage offers a few actual treatment links");
  assert.ok(featured.every((path) => categories.includes(path)), "homepage never invents treatment URLs");
  for (const path of categories) {
    await html(path);
    const nav = page.locator('nav[aria-label="مسار التنقل"]');
    assert.equal(await nav.count(), 1, `${path}: visible breadcrumb navigation`);
    assert.equal(await nav.locator('a[href="/dashboard"]').count(), 1);
    const current = await nav.locator('[aria-current="page"]').textContent();
    const schemas = await page.locator('script[type="application/ld+json"]').evaluateAll((scripts) => scripts.flatMap((script) => {
      const data = JSON.parse(script.textContent);
      return data["@graph"] || [data];
    }));
    const breadcrumbs = schemas.filter((schema) => schema["@type"] === "BreadcrumbList");
    assert.equal(breadcrumbs.length, 1, `${path}: one breadcrumb schema`);
    assert.deepEqual(breadcrumbs[0].itemListElement.map(({ item }) => item), ["https://soulclinc.net/", "https://soulclinc.net/dashboard", `https://soulclinc.net${path}`]);
    assert.equal(breadcrumbs[0].itemListElement.at(-1).name, current);
  }
  console.log(JSON.stringify({ result: "passed", origin, categories: categories.length, featured: featured.length, javascript: "disabled; initial server HTML only" }));
} finally {
  await browser.close();
}

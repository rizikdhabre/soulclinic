import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { MongoClient, ObjectId } from "mongodb";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";

const database = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" }, spawn: { windowsHide: true } });
const uri = database.getUri();
assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
const mongo = new MongoClient(uri);
await mongo.connect();
const db = mongo.db("soul");
const treatments = db.collection("treatments");
const id = new ObjectId();
const fixture = { _id: id, title: "جلسة اختبار محلية", description: "وصف عام محلي", services: [{ title: "خيار محلي", description: "تفاصيل الخيار", price: "200", duration: "30", currency: "ILS", imageUrl: "/logo.PNG" }], privateNotes: "SECRET_NOT_PUBLIC" };
await treatments.insertOne(fixture);
await db.collection("settings").insertOne({ key: "homepage", heroImageUrl: "/LogoSoul.jpeg" });
const probe = createServer();
probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, NODE_ENV: "production", MONGO_URI: uri, JWT_SECRET: "isolated-seo-smoke-secret",
    UPSTASH_REDIS_REST_KV_REST_API_URL: "", UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "" },
});
let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
const failures = [];
async function check(name, run) {
  try { await run(); console.log("PASS", name); }
  catch (error) { failures.push(name); console.error("FAIL", name, error.message, log.slice(-2000)); }
}
async function request(path, options = {}) {
  return fetch(base + path, { redirect: "manual", ...options, signal: AbortSignal.timeout(45000) });
}
try {
  for (let attempt = 0; ; attempt++) {
    try { await request("/robots.txt"); break; } catch {
      if (attempt > 100 || child.exitCode !== null) throw new Error("Server did not start: " + log.slice(-1000));
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  console.log("Isolated production preview:", base);
  for (const path of ["/", "/about", "/contact", "/dashboard", "/treatments/" + id]) {
    await check("SSR and metadata " + path, async () => {
      const res = await request(path); assert.equal(res.status, 200);
      const html = await res.text();
      assert.equal((html.match(/<h1[ >]/g) || []).length, 1);
      assert.ok(html.includes('dir="rtl"'));
      const canonical = html.match(/rel="canonical" href="([^"]+)"/)?.[1];
      assert.equal(new URL(canonical).href, new URL(path, "https://soulclinc.net").href);
      assert.ok(html.includes('property="og:image"'));
      assert.ok(!html.includes("SECRET_NOT_PUBLIC"));
      const entities = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].flatMap((match) => JSON.parse(match[1])["@graph"]);
      assert.equal(entities.filter((entity) => entity["@type"] === "LocalBusiness").length, 1);
      assert.equal(entities.filter((entity) => entity["@type"] === "WebSite").length, path === "/" ? 1 : 0);
      if (path === "/dashboard") assert.ok(html.includes('href="/treatments/' + id + '"'));
    });
  }
  await check("Private-route SEO does not change authentication", async () => {
    for (const path of ["/login", "/appointments", "/userAppointments"]) assert.match(await (await request(path)).text(), /noindex/);
    assert.equal((await request("/admin")).status, 307);
  });
  await check("Robots, sitemap and genuine social assets", async () => {
    assert.match(await (await request("/robots.txt")).text(), /Sitemap: https:\/\/soulclinc.net\/sitemap.xml/);
    const xml = await (await request("/sitemap.xml")).text();
    assert.match(xml, /<urlset/); assert.ok(xml.includes("/dashboard")); assert.ok(xml.includes("/treatments/" + id));
    for (const privatePath of ["/login", "/admin", "/appointments"]) assert.ok(!xml.includes(privatePath));
    assert.ok(!xml.includes("<lastmod>"));
    for (const asset of ["/logo.PNG", "/opengraph-image", "/twitter-image"]) assert.equal((await request(asset)).status, 200);
  });
  await check("Missing records have real 404 responses", async () => {
    for (const key of ["unknown", "000000000000000000000000", "bad%20id"]) {
      for (const ua of ["Mozilla/5.0", "Googlebot", "Twitterbot", "facebookexternalhit", "bingbot"]) {
        assert.equal((await request("/treatments/" + key, { headers: { "User-Agent": ua } })).status, 404);
      }
    }
  });
  await check("Existing database workflow updates SEO without another build", async () => {
    const addedId = new ObjectId();
    await treatments.insertOne({ ...fixture, _id: addedId, title: "خدمة جديدة" });
    const path = "/treatments/" + addedId;
    assert.equal((await request(path)).status, 200);
    assert.ok((await (await request("/dashboard")).text()).includes(path));
    assert.ok((await (await request("/sitemap.xml")).text()).includes(path));
    await treatments.updateOne({ _id: addedId }, { $set: { title: "خدمة محدثة", "services.0.price": "240", "services.0.duration": "40", updatedAt: new Date("2026-10-23T12:00:00Z") } });
    const html = await (await request(path)).text();
    assert.ok(html.includes("خدمة محدثة")); assert.ok(html.includes('"price":240')); assert.ok(html.includes("40"));
    assert.ok((await (await request("/sitemap.xml")).text()).includes("2026-10-23"));
    await treatments.updateOne({ _id: addedId }, { $set: { status: "draft" } });
    assert.equal((await request(path)).status, 404);
    assert.ok(!(await (await request("/sitemap.xml")).text()).includes(path));
    assert.equal((await request("/api/treatment?id=" + addedId)).status, 404);
    await treatments.deleteOne({ _id: addedId }); assert.equal((await request(path)).status, 404);
  });
  if (process.argv.includes("--browser")) {
    await check("Original design, perfume animation and booking links", async () => {
      const require = createRequire(import.meta.url);
      const { resolveRuntime } = require("../tests/e2e/firebaseOtpV2/runtime.cjs");
      const { chromium } = require(resolveRuntime("playwright/test"));
      const browser = await chromium.launch({ headless: true });
      await mkdir("tests/seo/artifacts", { recursive: true });
      try {
        for (const [name, width, height] of [["mobile", 390, 844], ["desktop", 1440, 1000]]) {
          const page = await browser.newPage({ viewport: { width, height } });
          const errors = []; page.on("pageerror", (error) => errors.push(error.message));
          for (const [label, path] of [["home", "/"], ["catalogue", "/dashboard"], ["detail", "/treatments/" + id], ["contact", "/contact"], ["about", "/about"]]) {
            await page.goto(base + path, { waitUntil: "networkidle" });
            assert.equal(await page.locator("h1").count(), 1);
            assert.equal(await page.locator("html").getAttribute("dir"), "rtl");
            if (label === "home") {
              assert.match(await page.locator("h1").innerText(), /اكتشف طريقك إلى\s+السلام الداخلي/);
              const subtitle = page.getByText("عيادة SOUL للحجامة والمساج والإبر الصينية في دير حنا", { exact: true });
              assert.equal(await subtitle.evaluate((node) => getComputedStyle(node).fontSize), "14px");
              assert.ok(await subtitle.isVisible());
              const perfume = page.getByRole("link", { name: "عطور SOUL", exact: true });
              const booking = page.getByRole("link", { name: "احجز موعدك الآن" });
              assert.ok((await perfume.boundingBox()).y > (await booking.boundingBox()).y);
              assert.equal(await perfume.getAttribute("href"), "https://www.soulperfume.co/");
              await page.waitForTimeout(7000);
              assert.ok(await page.getByRole("link", { name: "عطور", exact: true }).isVisible());
              assert.equal(await page.locator('img[alt="SoulClinic Hero"]').evaluate((img) => img.naturalWidth > 0), true);
            }
            if (label === "detail") {
              assert.equal(await page.locator('meta[property="og:image"]').first().getAttribute("content"), "https://soulclinc.net/logo.PNG");
              await page.getByRole("button", { name: "احجز الآن", exact: true }).click();
              await page.waitForURL("**/appointments?**");
              const url = new URL(page.url());
              assert.equal(url.searchParams.get("treatmentId"), String(id));
              assert.equal(url.searchParams.get("price"), "200");
              assert.equal(url.searchParams.get("duration"), "30");
              await page.goto(base + path, { waitUntil: "networkidle" });
            }
            for (let y = 0; y < await page.evaluate(() => document.documentElement.scrollHeight); y += 600) {
              await page.evaluate((top) => window.scrollTo(0, top), y);
              await page.waitForTimeout(100);
            }
            await page.evaluate(() => window.scrollTo(0, 0));
            await page.waitForTimeout(800);
            await page.screenshot({ path: "tests/seo/artifacts/" + name + "-" + label + ".png", fullPage: true });
            assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), "Overflow " + label + " " + name);
          }
          await page.getByRole("button", { name: "Open menu" }).focus(); await page.keyboard.press("Enter");
          await page.getByRole("link", { name: "اتصل بنا", exact: true }).click(); await page.waitForURL(base + "/contact");
          assert.ok(await page.locator('a[href="tel:+972532286019"]').count() > 0);
          assert.ok(await page.locator('a[href="https://wa.me/972532286019"]').count() > 0);
          assert.deepEqual(errors, []); await page.close();
        }
      } finally { await browser.close(); }
    });
  }
  if (process.argv.includes("--serve") && failures.length === 0) {
    const [liveCatalogue, liveHero] = await Promise.all([
      fetch("https://soulclinc.net/api/admin/treatments").then((res) => { assert.equal(res.status, 200); return res.json(); }),
      fetch("https://soulclinc.net/api/admin/upload-hero-image").then((res) => { assert.equal(res.status, 200); return res.json(); }),
    ]);
    assert.ok(Array.isArray(liveCatalogue));
    await treatments.deleteMany({});
    await treatments.insertMany(liveCatalogue.map((record) => ({ ...record, _id: new ObjectId(record._id) })));
    await db.collection("settings").updateOne({ key: "homepage" }, { $set: { heroImageUrl: liveHero.heroImageUrl } });
    console.log("Preview ready with a read-only copy of public content; production is unchanged.");
    await once(process, "SIGINT");
  } else {
    await database.stop();
    await check("Database failures are not empty success or 404", async () => {
      for (const res of await Promise.all(["/dashboard", "/sitemap.xml", "/api/treatments"].map((path) => request(path)))) assert.ok(res.status >= 500);
    });
  }
} finally {
  if (child.exitCode === null && child.signalCode === null) {
    const exited = once(child, "exit"); child.kill(); await exited.catch(() => {});
  }
  await mongo.close(); await database.stop();
}
console.log(JSON.stringify({ failures }));
if (failures.length) process.exitCode = 1;

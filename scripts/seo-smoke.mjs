import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { MongoMemoryServer } from "mongodb-memory-server-core";
import { MongoClient, ObjectId } from "mongodb";
import { createRequire } from "node:module";
import { mkdir } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import jwt from "jsonwebtoken";
import htmlParser from "next/dist/compiled/node-html-parser/index.js";

const require = createRequire(import.meta.url);
const { cleanEnvironment } = require("../tests/e2e/firebaseOtpV2/runtime.cjs");
const adminSecret = randomBytes(32).toString("hex");
const adminCookie = "token=" + jwt.sign({ role: "admin", adminId: "isolated-seo-smoke" }, adminSecret, { expiresIn: "15m" });
// Only a previously installed MongoDB binary may run; never download during this check.
process.env.MONGOMS_RUNTIME_DOWNLOAD = "false";
const database = await MongoMemoryServer.create({ instance: { ip: "127.0.0.1" }, spawn: { windowsHide: true } });
const uri = database.getUri();
assert.match(uri, /^mongodb:\/\/127\.0\.0\.1:/);
const mongo = new MongoClient(uri);
await mongo.connect();
const db = mongo.db("soul");
const treatments = db.collection("treatments");
const id = new ObjectId();
const fixture = { _id: id, title: "جلسة اختبار محلية", description: "وصف عام محلي", services: [{ title: "خيار محلي", description: "تفاصيل الخيار", price: "200", duration: "30", currency: "ILS", imageUrl: "/logo.PNG", imagePath: "PRIVATE_STORAGE_NOT_PUBLIC", internalNote: "SECRET_SERVICE_NOT_PUBLIC" }], privateNotes: "SECRET_NOT_PUBLIC", routeKeys: ["PRIVATE_ALIAS_NOT_PUBLIC"], appointments: [{ note: "PRIVATE_APPOINTMENT_NOT_PUBLIC" }] };
const privateMarkers = ["SECRET_NOT_PUBLIC", "PRIVATE_STORAGE_NOT_PUBLIC", "SECRET_SERVICE_NOT_PUBLIC", "PRIVATE_ALIAS_NOT_PUBLIC", "PRIVATE_APPOINTMENT_NOT_PUBLIC"];
await treatments.insertOne(fixture);
await db.collection("settings").insertOne({ key: "homepage", heroImageUrl: "/LogoSoul.jpeg" });
const probe = createServer();
probe.listen(0, "127.0.0.1"); await once(probe, "listening");
const port = probe.address().port; await new Promise((resolve) => probe.close(resolve));
const base = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(port)], {
  windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
  env: { ...cleanEnvironment(), NODE_ENV: "production", VERCEL_ENV: "production", SITE_NOINDEX: "false",
    MONGO_URI: uri, JWT_SECRET: adminSecret, NEXT_TELEMETRY_DISABLED: "1", REDIS_CACHE_ENABLED: "false",
    UPSTASH_REDIS_REST_KV_REST_API_URL: "", UPSTASH_REDIS_REST_KV_REST_API_TOKEN: "",
    FIREBASE_STORAGE_BUCKET: "", FIREBASE_PROJECT_ID: "", FIREBASE_CLIENT_EMAIL: "", FIREBASE_PRIVATE_KEY: "",
    GOOGLE_APPLICATION_CREDENTIALS: "", TWILIO_ACCOUNT_SID: "", TWILIO_AUTH_TOKEN: "", TWILIO_VERIFY_SERVICE_SID: "",
    FEEDBACK_REQUESTS_ENABLED: "false", RETURN_REMINDERS_ENABLED: "false" },
});
let log = ""; child.stdout.on("data", (d) => { log += d; }); child.stderr.on("data", (d) => { log += d; });
const failures = [];
async function check(name, run) {
  try { await run(); console.log("PASS", name); }
  catch (error) { failures.push(name); console.error("FAIL", name, error.message, log.slice(-2000)); }
}
async function request(path, options = {}) {
  const url = new URL(path, base);
  assert.equal(url.origin, base, "Smoke requests must stay on the disposable loopback server");
  assert.equal(url.hostname, "127.0.0.1");
  assert.equal(url.username + url.password, "");
  return fetch(url, { ...options, redirect: "manual", signal: AbortSignal.timeout(45000) });
}
function assertNoPrivateData(value) {
  for (const marker of privateMarkers) assert.ok(!value.includes(marker), "Public response leaked " + marker);
}
function documentLinks(document) {
  return document.querySelectorAll("a[href]").map((link) => ({
    url: new URL(link.getAttribute("href"), "https://soulclinc.net").href,
    text: link.textContent.trim(),
  }));
}
function assertPublicLink(document, path) {
  const url = new URL(path, "https://soulclinc.net").href;
  assert.ok(documentLinks(document).some((link) => link.url === url && link.text), "Missing initial-HTML anchor to " + path);
}
async function readPage(path) {
  const res = await request(path);
  assert.equal(res.status, 200, "Public page " + path);
  const html = await res.text();
  assertNoPrivateData(html);
  return { html, document: htmlParser.parse(html) };
}
async function readPublicJson(path) {
  const res = await request(path);
  assert.equal(res.status, 200, "Public API " + path);
  assert.match(res.headers.get("X-Robots-Tag") || "", /noindex/i);
  const text = await res.text();
  assertNoPrivateData(text);
  return JSON.parse(text);
}
async function readSitemap() {
  const res = await request("/sitemap.xml");
  assert.equal(res.status, 200);
  const xml = await res.text();
  assertNoPrivateData(xml);
  const document = htmlParser.parse(xml);
  assert.ok(document.querySelector("urlset"), "Missing sitemap urlset");
  const entries = document.querySelectorAll("url").map((entry) => ({
    url: entry.querySelector("loc")?.textContent,
    lastModified: entry.querySelector("lastmod")?.textContent,
  }));
  assert.equal(new Set(entries.map((entry) => entry.url)).size, entries.length, "Duplicate sitemap canonicals");
  for (const entry of entries) assert.equal(new URL(entry.url).origin, "https://soulclinc.net");
  return entries;
}
async function assertSitemapDate(treatmentId, previousDate) {
  const record = await treatments.findOne({ _id: new ObjectId(treatmentId) });
  assert.ok(record.updatedAt instanceof Date, "Admin write must persist updatedAt");
  if (previousDate) assert.ok(record.updatedAt > previousDate, "Admin write did not advance updatedAt / sitemap lastModified");
  const canonical = "https://soulclinc.net/treatments/" + treatmentId;
  const entry = (await readSitemap()).find((item) => item.url === canonical);
  assert.ok(entry, "Admin-created category is missing from sitemap");
  assert.equal(entry.lastModified, record.updatedAt.toISOString(), "Sitemap date must reflect the saved admin edit");
  assert.deepEqual((await readSitemap()).find((item) => item.url === canonical), entry, "Unchanged records must not receive synthetic dates");
}
async function assertPublicCategory(treatmentId, category, services) {
  const path = "/treatments/" + treatmentId;
  const canonical = "https://soulclinc.net" + path;
  const { document } = await readPage(path);
  assert.equal(document.querySelectorAll("h1").length, 1);
  assert.equal(document.querySelector("h1").textContent, category.title);
  assert.ok(document.querySelector("title")?.textContent.includes(category.title), "Title must derive from the category");
  assert.equal(document.querySelector('meta[name="description"]')?.getAttribute("content"), category.description);
  const canonicals = document.querySelectorAll('link[rel="canonical"]');
  assert.equal(canonicals.length, 1);
  assert.equal(canonicals[0].getAttribute("href"), canonical);
  assert.ok(!document.querySelector('meta[name="robots"]')?.getAttribute("content").includes("noindex"));
  for (const prefix of ["og", "twitter"]) {
    const attribute = prefix === "og" ? "property" : "name";
    assert.equal(document.querySelector(`meta[${attribute}="${prefix}:title"]`)?.getAttribute("content"), document.querySelector("title").textContent);
    assert.equal(document.querySelector(`meta[${attribute}="${prefix}:description"]`)?.getAttribute("content"), category.description);
  }
  const entities = document.querySelectorAll('script[type="application/ld+json"]').flatMap((script) => {
    const value = JSON.parse(script.textContent);
    return value["@graph"] || value;
  });
  const schemas = entities.filter((entity) => entity["@type"] === "Service");
  assert.equal(schemas.length, 1);
  assert.equal(schemas[0].url, canonical);
  assert.equal(schemas[0].name, category.title);
  assert.equal(schemas[0].description, category.description);
  assert.deepEqual(schemas[0].hasOfferCatalog.itemListElement.map((offer) => ({
    title: offer.name, description: offer.itemOffered.description, price: offer.price, currency: offer.priceCurrency, url: offer.url,
  })), services.map((service) => ({ title: service.title, description: service.description, price: Number(service.price), currency: service.currency, url: canonical })));
  const visible = htmlParser.parse(document.toString());
  visible.querySelectorAll("script,style,template").forEach((node) => node.remove());
  const text = visible.textContent.replace(/\s+/g, " ");
  for (const service of services) {
    assert.ok(text.includes(service.title), "Service title is missing from initial HTML");
    assert.ok(text.includes(service.description), "Service description is missing from initial HTML");
    assert.ok(text.includes("المدة: " + service.duration), "Service duration is missing from initial HTML");
    assert.ok(text.includes(`السعر: ${service.price} ${service.currency}`), "Service price is missing from initial HTML");
  }
  assertPublicLink((await readPage("/dashboard")).document, path);
  const record = await readPublicJson("/api/treatment?id=" + treatmentId);
  assert.equal(record._id, treatmentId, "Original booking/category ID must be retained");
  assert.equal(record.title, category.title);
  assert.equal(record.description, category.description);
  assert.deepEqual(record.services.map(({ title, description, price, duration, currency }) => ({ title, description, price, duration, currency })),
    services.map(({ title, description, price, duration, currency }) => ({ title, description, price, duration, currency })));
  assert.ok((await readPublicJson("/api/treatments")).some((item) => item._id === treatmentId));
}
async function adminWrite(path, method, body, status = 200) {
  assert.ok(path.startsWith("/api/admin/treatments"));
  // No cloud-backed image paths may enter any mutation or deletion fixture.
  const services = body.services || (body.service ? [body.service] : []);
  assert.ok(services.every((service) => !service.imagePath));
  const res = await request(path, { method, headers: { Cookie: adminCookie, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  assert.equal(res.status, status, method + " " + path);
  return res.json();
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
      assertNoPrivateData(html);
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
  await check("Public discovery uses real initial-HTML anchors and sanitized APIs", async () => {
    assertPublicLink((await readPage("/")).document, "/dashboard");
    const catalogue = (await readPage("/dashboard")).document;
    const records = await readPublicJson("/api/treatments");
    assert.ok(records.some((record) => record._id === String(id)), "The omission check must include the private-field fixture");
    for (const record of records) assertPublicLink(catalogue, "/treatments/" + record._id);
    const detail = await readPublicJson("/api/treatment?id=" + id);
    assert.equal(detail._id, String(id));
    assert.equal(detail.services[0].title, fixture.services[0].title);
    assert.ok(!Object.hasOwn(detail, "privateNotes"));
    assert.ok(!Object.hasOwn(detail.services[0], "imagePath"));
    assert.ok(!Object.hasOwn(detail.services[0], "internalNote"));
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
  await check("Admin HTTP category/service CRUD, reorder and cleanup", async () => {
    const login = await request("/login", { headers: { Cookie: adminCookie } });
    assert.equal(login.status, 307, "Disposable signed admin session must be accepted");
    assert.equal(new URL(login.headers.get("location"), base).pathname, "/admin");
    const category = { title: "Local admin category", description: "Local admin category description" };
    const updatedCategory = { title: "Updated local admin category", description: "Updated local admin description" };
    const first = { title: "Local first service", description: "First local service description", price: "215", duration: "35", currency: "ILS", imageUrl: "/logo.PNG" };
    const second = { title: "Local second service", description: "Second local service description", price: "325", duration: "55", currency: "ILS", imageUrl: "/LogoSoul.jpeg" };
    const updated = { ...first, title: "Updated local first service", description: "Updated first service description", price: "245", duration: "45" };
    const beforeFixture = await treatments.findOne({ _id: id });
    let treatmentId;
    let deleted = false;
    try {
      const created = await adminWrite("/api/admin/treatments", "POST", { ...category, services: [] }, 201);
      assert.match(created.id, /^[a-f\d]{24}$/i);
      treatmentId = created.id;
      await check("Admin-created category is immediately discoverable without publication or rebuild", async () => {
        await assertPublicCategory(treatmentId, category, []);
        await assertSitemapDate(treatmentId);
      });
      for (const service of [first, second]) await adminWrite("/api/admin/treatments/services", "POST", { treatmentId, service }, 201);
      await check("Admin-created services supply initial HTML, metadata and exact offers", async () => {
        await assertPublicCategory(treatmentId, category, [first, second]);
        await assertSitemapDate(treatmentId);
      });
      const beforeCategoryEdit = await treatments.findOne({ _id: new ObjectId(treatmentId) });
      await adminWrite("/api/admin/treatments", "PUT", { id: treatmentId, ...updatedCategory });
      await check("Admin category edits refresh metadata/schema without changing canonical IDs", async () => {
        await assertPublicCategory(treatmentId, updatedCategory, [first, second]);
      });
      await check("Admin category edits advance sitemap lastModified", async () => {
        await assertSitemapDate(treatmentId, beforeCategoryEdit.updatedAt);
      });
      await check("Unchanged category saves preserve sitemap lastModified", async () => {
        const before = await treatments.findOne({ _id: new ObjectId(treatmentId) });
        await adminWrite("/api/admin/treatments", "PUT", { id: treatmentId, ...updatedCategory });
        const after = await treatments.findOne({ _id: new ObjectId(treatmentId) });
        assert.equal(after.updatedAt.toISOString(), before.updatedAt.toISOString());
        await assertSitemapDate(treatmentId);
      });
      const beforeServiceEdit = await treatments.findOne({ _id: new ObjectId(treatmentId) });
      await adminWrite("/api/admin/treatments/services", "PUT", { treatmentId, serviceIndex: 0, service: updated });
      await check("Admin service edits refresh public price/duration/schema and sitemap dates", async () => {
        await assertPublicCategory(treatmentId, updatedCategory, [updated, second]);
        await assertSitemapDate(treatmentId, beforeServiceEdit.updatedAt);
        const { html } = await readPage("/treatments/" + treatmentId);
        assert.ok(!html.includes(first.title), "Old service content survived an admin edit");
      });
      const beforeReorder = await treatments.findOne({ _id: new ObjectId(treatmentId) });
      await adminWrite("/api/admin/treatments/services/reorder", "PUT", { treatmentId, services: [second, updated] });
      await check("Admin reorder preserves service values, category IDs and public order", async () => {
        await assertPublicCategory(treatmentId, updatedCategory, [second, updated]);
        await assertSitemapDate(treatmentId, beforeReorder.updatedAt);
        const { document } = await readPage("/treatments/" + treatmentId);
        assert.equal(document.querySelector('meta[property="og:image"]')?.getAttribute("content"), "https://soulclinc.net/LogoSoul.jpeg");
        const headings = document.querySelectorAll("h2,h3,h4").map((node) => node.textContent);
        assert.ok(headings.indexOf(second.title) >= 0 && headings.indexOf(second.title) < headings.indexOf(updated.title), "Initial HTML must follow the saved service order");
      });
      const beforeServiceDelete = await treatments.findOne({ _id: new ObjectId(treatmentId) });
      await adminWrite("/api/admin/treatments/services", "DELETE", { treatmentId, serviceIndex: 0 });
      await check("Admin service deletion removes public content/offers and retains its category", async () => {
        await assertPublicCategory(treatmentId, updatedCategory, [updated]);
        await assertSitemapDate(treatmentId, beforeServiceDelete.updatedAt);
        for (const path of ["/treatments/" + treatmentId, "/dashboard", "/api/treatments", "/api/treatment?id=" + treatmentId]) {
          const res = await request(path);
          assert.equal(res.status, 200);
          assert.ok(!(await res.text()).includes(second.title), "Deleted service leaked through " + path);
        }
      });
      await adminWrite("/api/admin/treatments", "DELETE", { id: treatmentId });
      deleted = true;
      await check("Admin category deletion removes its URL, links, API data and sitemap entry", async () => {
        assert.equal(await treatments.findOne({ _id: new ObjectId(treatmentId) }), null);
        for (const path of ["/treatments/" + treatmentId, "/api/treatment?id=" + treatmentId]) assert.equal((await request(path)).status, 404);
        assert.ok(!(await readPage("/dashboard")).html.includes(treatmentId));
        assert.ok(!(await readPublicJson("/api/treatments")).some((record) => record._id === treatmentId));
        assert.ok(!(await readSitemap()).some((entry) => entry.url.endsWith("/treatments/" + treatmentId)));
        assert.deepEqual(await treatments.findOne({ _id: id }), beforeFixture, "Admin lifecycle must not alter existing IDs, prices or durations");
      });
    } finally {
      if (treatmentId && !deleted) await adminWrite("/api/admin/treatments", "DELETE", { id: treatmentId });
    }
  });
  await check("Stored draft/hidden/noindex flags respect existing public catalogue boundaries", async () => {
    // These flags have no admin publishing UI. Seed only the existing read-model states.
    const records = [
      { ...fixture, _id: new ObjectId(), title: "DRAFT_CATEGORY_NOT_PUBLIC", status: "draft" },
      { ...fixture, _id: new ObjectId(), title: "HIDDEN_CATEGORY_NOT_PUBLIC", status: "hidden" },
      { ...fixture, _id: new ObjectId(), title: "Local noindex category", status: "published", indexable: false },
      { ...fixture, _id: new ObjectId(), title: "Local published category", status: "published", services: [
        { ...fixture.services[0], title: "DRAFT_SERVICE_NOT_PUBLIC", status: "draft" },
        { ...fixture.services[0], status: "published" },
        { ...fixture.services[0], title: "HIDDEN_SERVICE_NOT_PUBLIC", status: "hidden" },
      ] },
    ];
    await treatments.insertMany(records);
    try {
      const sitemap = await readSitemap();
      const catalogue = await readPage("/dashboard");
      const publicRecords = await readPublicJson("/api/treatments");
      for (const record of records.slice(0, 2)) {
        const key = String(record._id);
        for (const path of ["/treatments/" + key, "/api/treatment?id=" + key]) assert.equal((await request(path)).status, 404);
        assert.ok(!catalogue.html.includes(key));
        assert.ok(!publicRecords.some((item) => item._id === key));
        assert.ok(!sitemap.some((entry) => entry.url.endsWith("/" + key)));
      }
      const noindexId = String(records[2]._id);
      const noindex = await readPage("/treatments/" + noindexId);
      assert.match(noindex.document.querySelector('meta[name="robots"]')?.getAttribute("content") || "", /noindex/);
      assert.equal(noindex.document.querySelector('link[rel="canonical"]')?.getAttribute("href"), "https://soulclinc.net/treatments/" + noindexId);
      assert.ok(!sitemap.some((entry) => entry.url.endsWith("/" + noindexId)));
      assertPublicLink(catalogue.document, "/treatments/" + noindexId);
      assert.equal((await readPublicJson("/api/treatment?id=" + noindexId))._id, noindexId);
      const publishedId = String(records[3]._id);
      await assertPublicCategory(publishedId, records[3], [fixture.services[0]]);
      assert.ok(sitemap.some((entry) => entry.url.endsWith("/" + publishedId)));
      const published = await readPage("/treatments/" + publishedId);
      const api = await readPublicJson("/api/treatment?id=" + publishedId);
      for (const response of [catalogue.html, published.html, JSON.stringify(api), JSON.stringify(publicRecords)]) {
        for (const marker of ["DRAFT_CATEGORY_NOT_PUBLIC", "HIDDEN_CATEGORY_NOT_PUBLIC", "DRAFT_SERVICE_NOT_PUBLIC", "HIDDEN_SERVICE_NOT_PUBLIC"]) {
          assert.ok(!response.includes(marker), "Draft/hidden data leaked: " + marker);
        }
      }
    } finally {
      await treatments.deleteMany({ _id: { $in: records.map((record) => record._id) } });
    }
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

import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { resolve, join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";

// No app imports, environment files, credentials, mutations, or installations.
const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL("../", import.meta.url));
const live = "https://soulclinc.net";
const agents = {
  browser: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36",
  googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
};
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const hash = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const round = (n) => Math.round(n * 100) / 100;

function safeUrl(value) {
  try {
    const url = new URL(value);
    url.username = ""; url.password = "";
    if (!/^https?:$/.test(url.protocol)) return url.protocol + "[omitted]";
    for (const key of [...url.searchParams.keys()]) {
      const val = url.searchParams.get(key);
      url.searchParams.set(key, key === "url" ? safeUrl(new URL(val, live).href) : /^(w|q|alt)$/.test(key) ? val : "REDACTED");
    }
    return url.href;
  } catch { return String(value).slice(0, 200); }
}
function sanitize(value) {
  if (typeof value === "string") return value.replace(/https?:\/\/[^\s"<>]+/g, safeUrl)
    .replace(/eyJ[\w-]+\.[\w-]+\.[\w-]+/g, "[REDACTED_JWT]");
  if (Array.isArray(value)) return value.map(sanitize);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, sanitize(v)]));
  return value;
}
function robotsAllowed(text, agent, path) {
  const groups = []; let group;
  for (const line of text.split(/\r?\n/)) {
    const match = line.replace(/#.*/, "").match(/^\s*([\w-]+)\s*:\s*(.*?)\s*$/);
    if (!match) continue;
    const [, field, value] = match;
    if (field.toLowerCase() === "user-agent") {
      if (!group || group.hasDirective) groups.push(group = { agents: [], rules: [] });
      group.agents.push(value.toLowerCase());
    } else if (group && /^(allow|disallow)$/i.test(field)) {
      group.hasDirective = true;
      if (value) group.rules.push({ allow: /^allow$/i.test(field), value });
    }
  }
  const specific = groups.filter((g) => g.agents.some((a) => a !== "*" && agent.toLowerCase().includes(a)));
  const matches = (specific.length ? specific : groups.filter((g) => g.agents.includes("*"))).flatMap((g) => g.rules).filter((r) => {
    const pattern = r.value.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\\\$$/, "$");
    return new RegExp("^" + pattern).test(path);
  }).sort((a, b) => b.value.length - a.value.length || Number(b.allow) - Number(a.allow));
  return matches[0]?.allow ?? true;
}

async function selfTest() {
  assert.equal(new URL(safeUrl("https://example.com/a?token=private&w=640")).searchParams.get("token"), "REDACTED");
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /private\nAllow: /private/public", "googlebot", "/private/a"), false);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /private\nAllow: /private/public", "googlebot", "/private/public"), true);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /\nUser-agent: Googlebot\nAllow: /", "googlebot", "/"), true);
  assert.equal(robotsAllowed("User-agent: *\nDisallow: /*?secret=$", "bingbot", "/x?secret="), false);
  assert.equal(robotsAllowed("User-agent: *\nDisallow:\nUser-agent: Googlebot\nDisallow: /", "bingbot", "/"), true);
  const old = { labs: [{ path: "/", viewport: "mobile", layout: { core: [{ tag: "H1", text: "Title", box: { x: 0, y: 40, width: 300, height: 60 } }, { tag: "BUTTON", text: "Fixed", box: { x: 10, y: 700, width: 50, height: 50 } }] } }] };
  const shifted = structuredClone(old); shifted.labs[0].layout.core[0].box.y += 30;
  assert.equal(compareReports(shifted, old)[0].items[0].geometryChanged, false);
  assert.equal(compareReports(shifted, old)[0].items[1].geometryChanged, false, "An unchanged fixed control is not a breadcrumb-induced layout regression");
  const { resolveRuntime } = require("../tests/e2e/firebaseOtpV2/runtime.cjs");
  const browser = await require(resolveRuntime("playwright/test")).chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ javaScriptEnabled: false });
    await context.route("**/*", (route) => route.abort());
    const page = await context.newPage();
    const parsed = await page.evaluate(extractDocument, { url: live, html: '<title>Example</title><h1>Heading</h1><script src="/_next/static/chunks/turbopack-runtime.js"></script><script>throw new Error("must not execute")</script><img src="/a.png" srcset="/a.png 1x, /b.png 2x"><a href="/dashboard">Catalogue</a><script type="application/ld+json">{"@type":"Service"}</script>' });
    assert.deepEqual(parsed.h1, ["Heading"]);
    assert.equal(parsed.development, false);
    assert.deepEqual(parsed.schema.types, ["Service"]);
    assert.ok(parsed.images.some((i) => i.url === live + "/b.png"));
    assert.equal(parsed.anchors[0].url, live + "/dashboard");
  } finally { await browser.close(); }
  console.log("PASS redaction, robots, layout comparison and inert SSR DOM parsing self-tests");
}

// Runs in a JS-disabled browser context. DOMParser never executes embedded scripts.
function extractDocument({ html, url }) {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const all = (selector) => [...doc.querySelectorAll(selector)];
  const text = (node) => (node?.textContent || "").replace(/\s+/g, " ").trim();
  const abs = (value) => { try { return new URL(value, url).href; } catch { return value; } };
  const images = [];
  const addImage = (src, source) => { if (src && !/^(data|blob):/.test(src)) images.push({ url: abs(src), source }); };
  for (const node of all("img,source")) {
    addImage(node.getAttribute("src"), node.tagName.toLowerCase());
    // The HTML srcset grammar permits commas within URLs; split on descriptor boundaries.
    for (const match of (node.getAttribute("srcset") || "").matchAll(/(?:^|,\s*)(\S+?)(?:\s+\d+(?:\.\d+)?[wx])?(?=,\s*|$)/g)) addImage(match[1], "srcset");
  }
  for (const node of all('meta[property="og:image"],meta[name="twitter:image"]')) addImage(node.getAttribute("content"), "social");
  for (const node of all('link[rel~="icon"],link[rel="apple-touch-icon"],link[as="image"]')) addImage(node.getAttribute("href"), "link");
  const schema = { scripts: 0, types: [], entities: [], errors: [] };
  const visit = (value) => {
    if (!value || typeof value !== "object") return;
    if (value["@type"]) {
      schema.types.push(...[value["@type"]].flat());
      schema.entities.push({ type: value["@type"], name: value.name, url: value.url, id: value["@id"] });
    }
    if (typeof value.image === "string") addImage(value.image, "schema");
    for (const child of Object.values(value)) if (typeof child === "object") Array.isArray(child) ? child.forEach(visit) : visit(child);
  };
  for (const node of all('script[type="application/ld+json"]')) {
    schema.scripts++;
    try { visit(JSON.parse(node.textContent)); } catch { schema.errors.push("Invalid JSON-LD in script " + schema.scripts); }
  }
  const result = {
    titles: all("title").map(text), h1: all("h1").map(text), lang: doc.documentElement.lang, dir: doc.documentElement.dir,
    canonical: all('link[rel~="canonical"]').map((n) => abs(n.getAttribute("href"))),
    robots: all("meta[name]").filter((n) => /^(robots|googlebot|bingbot)$/i.test(n.name)).map((n) => ({ name: n.name.toLowerCase(), content: n.content })),
    description: all('meta[name="description"]').map((n) => n.content), schema,
    anchors: all("a[href]").map((n) => ({ url: abs(n.getAttribute("href")), text: text(n).slice(0, 200), rel: n.getAttribute("rel") || "" })), images,
    development: /\/_next\/webpack-hmr|__nextjs_original-stack-frame|<nextjs-portal/.test(html),
  };
  all("script,style,template").forEach((n) => n.remove());
  result.bodyText = text(doc.body);
  return result;
}

function observePerformance() {
  const state = window.__seoAudit = { lcp: null, shifts: [], longTasks: [], supported: PerformanceObserver.supportedEntryTypes };
  performance.setResourceTimingBufferSize(3000);
  const rect = (r) => r ? { x: r.x, y: r.y, width: r.width, height: r.height } : null;
  const describe = (n) => n ? { tag: n.tagName, id: n.id, text: (n.innerText || n.alt || "").slice(0, 160) } : null;
  for (const type of ["largest-contentful-paint", "layout-shift", "longtask"]) {
    if (!state.supported.includes(type)) continue;
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (type === "largest-contentful-paint") state.lcp = { ms: e.startTime, size: e.size, url: e.url, element: describe(e.element) };
        if (type === "layout-shift" && !e.hadRecentInput) state.shifts.push({ ms: e.startTime, value: e.value, sources: (e.sources || []).map((s) => ({ element: describe(s.node), previous: rect(s.previousRect), current: rect(s.currentRect) })) });
        if (type === "longtask") state.longTasks.push({ ms: e.startTime, duration: e.duration, name: e.name });
      }
    }).observe({ type, buffered: true });
  }
}

function measureLayout() {
  const excluded = 'nav,header,footer,[role="navigation"],[aria-label*="breadcrumb" i],[class*="breadcrumb" i]';
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: Math.round(r.x), y: Math.round(r.y + scrollY), width: Math.round(r.width), height: Math.round(r.height) }; };
  const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none"; };
  const core = [...document.querySelectorAll("h1,h2,h3,img,button,a[href]")].filter((el) => !el.closest(excluded) && visible(el)).map((el) => {
    const s = getComputedStyle(el);
    return { tag: el.tagName, text: (el.innerText || el.alt || el.getAttribute("aria-label") || "").trim().replace(/\s+/g, " ").slice(0, 200), href: el.getAttribute("href"), box: rect(el), fontSize: s.fontSize, color: s.color, fontFamily: s.fontFamily };
  });
  const images = [...document.images].map((el) => ({ src: el.currentSrc || el.src, alt: el.alt, box: rect(el), complete: el.complete,
    naturalWidth: el.naturalWidth, naturalHeight: el.naturalHeight, loading: el.loading, objectFit: getComputedStyle(el).objectFit,
    visible: visible(el), inViewport: visible(el) && el.getBoundingClientRect().top < innerHeight && el.getBoundingClientRect().bottom > 0,
    core: !el.closest(excluded), broken: el.complete && el.naturalWidth === 0 && !!(el.currentSrc || el.getAttribute("src")) }));
  const backgrounds = [...document.querySelectorAll("body *")].flatMap((el) => [...getComputedStyle(el).backgroundImage.matchAll(/url\(["']?(.*?)["']?\)/g)].map((m) => m[1]));
  const overflow = [...document.querySelectorAll("body *")].filter((el) => visible(el) && (el.getBoundingClientRect().left < -1 || el.getBoundingClientRect().right > innerWidth + 1)).slice(0, 40).map((el) => ({ tag: el.tagName, text: (el.innerText || "").slice(0, 80), box: rect(el) }));
  return { width: innerWidth, height: innerHeight, documentWidth: document.documentElement.scrollWidth, documentHeight: document.documentElement.scrollHeight, dir: document.documentElement.dir, core, images, backgrounds, overflow };
}

export function compareReports(current, baseline) {
  return current.labs.map((now) => {
    const before = baseline.labs.find((item) => item.path === now.path && item.viewport === now.viewport);
    if (!before?.layout || !now.layout) return { path: now.path, viewport: now.viewport, comparable: false };
    const previous = before.layout.core;
    const anchorBefore = previous.find((n) => n.tag === "H1")?.box.y || 0;
    const anchorNow = now.layout.core.find((n) => n.tag === "H1")?.box.y || 0;
    const used = new Set();
    const items = now.layout.core.map((node) => {
      const index = previous.findIndex((n, i) => !used.has(i) && n.tag === node.tag && n.text === node.text);
      const old = previous[index]; if (!old) return { tag: node.tag, text: node.text, added: true };
      used.add(index);
      const delta = { x: node.box.x - old.box.x, yAbsolute: node.box.y - old.box.y, yRelativeToH1: node.box.y - anchorNow - old.box.y + anchorBefore, width: node.box.width - old.box.width, height: node.box.height - old.box.height };
      const geometryChanged = [delta.x, delta.width, delta.height].some((v) => Math.abs(v) > 4) || (Math.abs(delta.yAbsolute) > 4 && Math.abs(delta.yRelativeToH1) > 4);
      return { tag: node.tag, text: node.text, delta, geometryChanged, typographyChanged: node.fontSize !== old.fontSize || node.fontFamily !== old.fontFamily };
    });
    return { path: now.path, viewport: now.viewport, comparable: true, h1VerticalShift: anchorNow - anchorBefore,
      note: "Geometry excludes header/nav/footer/breadcrumb; Y may remain absolute (fixed controls) or move with H1. Small additions are not pixel-diff failures. Review screenshots and added/missing content.",
      items, missing: previous.filter((_, i) => !used.has(i)), metricDelta: Object.fromEntries(["ttfbMs", "lcpMs", "cls", "transferredBytes"].map((key) => [key, now.metrics?.[key] == null || before.metrics?.[key] == null ? null : round(now.metrics[key] - before.metrics[key])])) };
  });
}

async function main() {
  const { values } = parseArgs({ options: { base: { type: "string", default: live }, label: { type: "string", default: "live" }, compare: { type: "string" }, "settle-ms": { type: "string", default: "8000" }, "timeout-ms": { type: "string", default: "20000" }, help: { type: "boolean" } } });
  if (values.help) { console.log("node scripts/seo-browser-audit.mjs [--base https://soulclinc.net] [--label live] [--compare tests/seo/artifacts/live/report.json] [--settle-ms 8000] [--timeout-ms 20000]\nRequires an already-running production server for local previews. GET/HEAD only. No build or install. --self-test runs offline checks."); return; }
  const base = new URL(values.base);
  assert.ok(base.origin === live || (["localhost", "127.0.0.1", "[::1]"].includes(base.hostname) && /^https?:$/.test(base.protocol)), "Only production or a loopback preview is permitted");
  assert.ok(!base.username && !base.password && base.pathname === "/" && !base.search && !base.hash, "Supply an origin without credentials/path/query");
  assert.match(values.label, /^[a-zA-Z0-9_-]{1,60}$/);
  const settle = Number(values["settle-ms"]), timeout = Number(values["timeout-ms"]);
  assert.ok(settle >= 1000 && settle <= 30000 && timeout >= 5000 && timeout <= 60000);
  const output = join(root, "tests/seo/artifacts", values.label);
  execFileSync("git", ["check-ignore", join(output, "report.json")], { cwd: root, windowsHide: true, stdio: "pipe" });
  await mkdir(output, { recursive: true });
  const mapUrl = (value) => { const u = new URL(value, base); if (u.origin === live) { u.host = base.host; u.protocol = base.protocol; } return u.href; };
  const publicPath = (url) => /^\/(?:$|about\/?$|contact\/?$|dashboard\/?$|treatments\/[^/]+\/?$)/.test(new URL(url).pathname) && !new URL(url).search;
  const report = { version: 3, checkedAt: new Date().toISOString(), base: base.origin, command: process.argv.slice(1),
    methodology: { mode: "production browser lab; single cold context per page/viewport; shared Chromium process; unthrottled CPU/network", settleMs: settle, timeoutMs: timeout,
      botEvidence: "Spoofed UA HTTP from this machine only, NOT verified Google/Bing fetches, indexing, or rendering.",
      limits: "Not Lighthouse, field CWV, or INP. Routing disables cache; service workers, websockets, telemetry and non-GET/HEAD requests blocked. No interaction/form submission. Local server production mode must be supplied by parent; dev markers are reported.",
      transfer: "CDP encodedDataLength across finished network requests; resource timing also reported (cross-origin sizes may be zero without Timing-Allow-Origin).",
      references: ["https://playwright.dev/docs/api/class-browsercontext", "https://web.dev/articles/cls", "https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming/transferSize"] },
    requests: 0, sitemaps: [], pages: [], images: [], labs: [], errors: [] };
  const { resolveRuntime } = require("../tests/e2e/firebaseOtpV2/runtime.cjs");
  const { chromium } = require(resolveRuntime("playwright/test"));
  const browser = await chromium.launch({ headless: true });
  report.browser = browser.version();
  const parserContext = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: "block" });
  await parserContext.route("**/*", (route) => route.abort());
  const parser = await parserContext.newPage();
  const referencedImages = new Map();
  const addImages = (items, source) => { for (const item of items) { try { const url = mapUrl(item.url); if (!/^https?:/.test(url)) continue; const refs = referencedImages.get(url) || []; refs.push({ page: source, source: item.source }); referencedImages.set(url, refs); } catch {} } };
  async function request(url, agent = agents.browser, binary = false) {
    await pause(150); report.requests++;
    const started = performance.now();
    try {
      const response = await fetch(url, { headers: { "User-Agent": agent, Accept: binary ? "image/*,*/*;q=0.8" : "text/html,application/xml;q=0.9,*/*;q=0.8" }, redirect: "manual", signal: AbortSignal.timeout(timeout) });
      const chunks = []; let bytes = 0;
      for await (const chunk of response.body || []) { bytes += chunk.length; if (bytes > 12 * 1024 * 1024) throw new Error("Body exceeds 12 MiB audit limit"); chunks.push(chunk); }
      const body = Buffer.concat(chunks);
      return { status: response.status, ms: round(performance.now() - started), bytes, type: response.headers.get("content-type") || "", xRobotsTag: response.headers.get("x-robots-tag"), location: response.headers.get("location"), cacheControl: response.headers.get("cache-control"), body: binary ? body : body.toString("utf8") };
    } catch (e) { return { status: null, error: e.name + ": " + e.message, body: binary ? Buffer.alloc(0) : "" }; }
  }
  async function readDocument(url, agent) {
    const { body, ...http } = await request(url, agent);
    if (!/text\/html/i.test(http.type || "")) return { ...http, seo: null };
    const seo = await parser.evaluate(extractDocument, { html: body, url });
    seo.bodyTextHash = hash(seo.bodyText); seo.bodyTextLength = seo.bodyText.length; delete seo.bodyText;
    return { ...http, seo };
  }
  try {
    const robotsResponse = await request(base.origin + "/robots.txt");
    const robotsText = robotsResponse.status === 200 ? robotsResponse.body : "";
    report.robots = { ...robotsResponse, body: undefined, text: robotsText.slice(0, 20000) };
    if (robotsResponse.status !== 200) report.errors.push("robots.txt returned " + robotsResponse.status + "; robots allowance is unknown");
    const sitemapQueue = [base.origin + "/sitemap.xml"];
    const seen = new Set(), urls = new Set();
    while (sitemapQueue.length) {
      const url = sitemapQueue.shift(); if (seen.has(url)) continue; seen.add(url);
      assert.ok(seen.size <= 50, "Sitemap index exceeds 50 files");
      const { body, ...http } = await request(url);
      const xml = await parser.evaluate((text) => {
        const doc = new DOMParser().parseFromString(text, "application/xml");
        return { root: doc.documentElement.localName, error: !!doc.querySelector("parsererror"), locations: [...doc.getElementsByTagNameNS("*", "loc")].map((n) => n.textContent.trim()) };
      }, body);
      report.sitemaps.push({ url, ...http, ...xml });
      if (http.status !== 200 || xml.error || !["urlset", "sitemapindex"].includes(xml.root)) { report.errors.push("Invalid sitemap " + safeUrl(url)); continue; }
      for (const loc of xml.locations) {
        const target = mapUrl(loc);
        if (new URL(target).origin !== base.origin) { report.errors.push("Off-origin sitemap entry omitted: " + safeUrl(target)); continue; }
        if (xml.root === "sitemapindex") sitemapQueue.push(target); else urls.add(target);
      }
    }
    report.sitemapUrlCount = urls.size;
    for (const url of urls) {
      const path = new URL(url).pathname;
      if (!publicPath(url)) { report.pages.push({ path, url, skipped: "Not a recognized public route; no private route or query navigation" }); continue; }
      const baseline = await readDocument(url, agents.browser);
      const page = { path, url, baseline, bots: {}, issues: [] };
      if (baseline.status !== 200) page.issues.push("HTTP " + baseline.status);
      if (baseline.seo) {
        const seo = baseline.seo;
        if (seo.canonical.length !== 1 || seo.canonical[0] !== new URL(path, live).href) page.issues.push("Canonical missing, duplicate or unexpected");
        if (seo.titles.length !== 1 || !seo.titles[0]) page.issues.push("Title missing or duplicate");
        if (seo.h1.length !== 1) page.issues.push("H1 count " + seo.h1.length);
        if (/noindex|none/i.test(JSON.stringify(seo.robots) + baseline.xRobotsTag)) page.issues.push("Sitemap URL carries noindex");
        if (!seo.schema.scripts || seo.schema.errors.length) page.issues.push("JSON-LD missing or invalid");
        addImages(seo.images, path);
      } else page.issues.push("Response is not HTML");
      for (const bot of ["googlebot", "bingbot"]) {
        const allowed = robotsResponse.status === 200 ? robotsAllowed(robotsText, bot, path) : null;
        if (allowed === false || baseline.status !== 200) { page.bots[bot] = { allowed, skipped: allowed === false ? "robots disallow" : "baseline not 200" }; continue; }
        const result = await readDocument(url, agents[bot]);
        const keys = ["titles", "h1", "canonical", "robots", "schema", "anchors", "bodyTextHash"];
        const differences = keys.filter((key) => hash(result.seo?.[key] ?? null) !== hash(baseline.seo?.[key] ?? null));
        if (result.status !== baseline.status) differences.push("status");
        if (result.xRobotsTag !== baseline.xRobotsTag) differences.push("xRobotsTag");
        page.bots[bot] = { allowed, ...result, differences };
        if (result.seo) addImages(result.seo.images, path + " (" + bot + ")");
      }
      report.pages.push(page);
      console.log("SSR", path, "HTTP", baseline.status, "H1", baseline.seo?.h1.length ?? "n/a", "issues", page.issues.length);
    }
    const sitemapPaths = new Set([...urls].map((u) => new URL(u).pathname));
    report.discovery = [...sitemapPaths].map((path) => ({ path, incomingSsrFrom: report.pages.filter((p) => p.path !== path && p.baseline?.seo?.anchors.some((a) => { try { const u = new URL(a.url); return [base.origin, live].includes(u.origin) && u.pathname === path && !!a.text; } catch { return false; } })).map((p) => p.path) }));
    const firstTreatment = [...urls].find((url) => new URL(url).pathname.startsWith("/treatments/"));
    const labPaths = ["/", "/dashboard", ...(firstTreatment ? [new URL(firstTreatment).pathname] : [])];
    if (!firstTreatment) report.errors.push("No treatment URL found in sitemap; detail lab not run");
    for (const [viewport, width, height] of [["mobile", 390, 844], ["desktop", 1440, 1000]]) {
      for (const path of labPaths) {
        const context = await browser.newContext({ viewport: { width, height }, isMobile: viewport === "mobile", hasTouch: viewport === "mobile", deviceScaleFactor: 1, serviceWorkers: "block", locale: "en-US", timezoneId: "UTC" });
        const lab = { path, viewport, blocked: [], failures: [], pageErrors: [], httpErrors: [] };
        let phase = "initial-load";
        await context.route("**/*", (route) => {
          const req = route.request(), u = new URL(req.url());
          const forbidden = !["GET", "HEAD"].includes(req.method()) || /(?:google-analytics|googletagmanager|doubleclick|analytics\.google|\/collect\b|\/api\/.*(?:logout|delete|reset|send|track)\b)/i.test(u.href) || (req.isNavigationRequest() && ![base.origin, live].includes(u.origin));
          if (forbidden) { lab.blocked.push({ method: req.method(), type: req.resourceType(), url: req.url() }); return route.abort(); }
          return route.continue({ url: mapUrl(req.url()) });
        });
        if (context.routeWebSocket) await context.routeWebSocket("**/*", (socket) => socket.close());
        await context.addInitScript(observePerformance);
        const page = await context.newPage(); page.setDefaultTimeout(timeout);
        page.on("pageerror", (error) => lab.pageErrors.push(error.name + ": " + error.message.slice(0, 400)));
        page.on("requestfailed", (request) => lab.failures.push({ url: request.url(), error: request.failure()?.errorText, type: request.resourceType(), phase }));
        page.on("response", (response) => { if (response.status() >= 400) lab.httpErrors.push({ status: response.status(), url: response.url() }); });
        const cdp = await context.newCDPSession(page); await cdp.send("Network.enable");
        const network = new Map();
        cdp.on("Network.requestWillBeSent", (e) => network.set(e.requestId, { url: e.request.url, type: e.type, started: e.timestamp }));
        cdp.on("Network.responseReceived", (e) => Object.assign(network.get(e.requestId) || {}, { status: e.response.status, mimeType: e.response.mimeType, protocol: e.response.protocol, fromDiskCache: e.response.fromDiskCache }));
        cdp.on("Network.loadingFinished", (e) => Object.assign(network.get(e.requestId) || {}, { transferredBytes: e.encodedDataLength, finished: e.timestamp }));
        cdp.on("Network.loadingFailed", (e) => Object.assign(network.get(e.requestId) || {}, { failed: e.errorText, ended: e.timestamp }));
        try {
          const response = await page.goto(base.origin + path, { waitUntil: "domcontentloaded", timeout });
          lab.status = response?.status();
          await page.waitForTimeout(settle);
          const perf = await page.evaluate(() => ({ ...window.__seoAudit, nav: performance.getEntriesByType("navigation")[0]?.toJSON(), resources: performance.getEntriesByType("resource").map((e) => e.toJSON()), observedUntilMs: performance.now() }));
          let cls = 0, session = 0, start = 0, last = 0;
          for (const shift of perf.shifts) { if (shift.ms - last >= 1000 || shift.ms - start >= 5000) { start = shift.ms; session = 0; } session += shift.value; cls = Math.max(cls, session); last = shift.ms; }
          const resources = [...network.values()].map((r) => ({ ...r, durationMs: r.finished ? round((r.finished - r.started) * 1000) : null }));
          lab.metrics = { ttfbMs: round(perf.nav?.responseStart || 0), serverWaitMs: round((perf.nav?.responseStart || 0) - (perf.nav?.requestStart || 0)), lcpMs: perf.lcp ? round(perf.lcp.ms) : null,
            cls: round(cls * 10000) / 10000, longTasks: perf.longTasks.length, longTaskTotalMs: round(perf.longTasks.reduce((n, t) => n + t.duration, 0)), longTaskBlockingMs: round(perf.longTasks.reduce((n, t) => n + Math.max(0, t.duration - 50), 0)),
            transferredBytes: resources.reduce((n, r) => n + (r.transferredBytes || 0), 0), requestCount: resources.length, unfinishedRequests: resources.filter((r) => !r.finished && !r.failed).length, failedRequests: resources.filter((r) => r.failed).length, observedUntilMs: round(perf.observedUntilMs) };
          lab.performance = perf;
          lab.bottlenecks = { largest: [...resources].sort((a, b) => (b.transferredBytes || 0) - (a.transferredBytes || 0)).slice(0, 12), slowest: [...resources].sort((a, b) => (b.durationMs || 0) - (a.durationMs || 0)).slice(0, 12), longestTasks: [...perf.longTasks].sort((a, b) => b.duration - a.duration).slice(0, 10) };
          lab.layout = await page.evaluate(measureLayout);
          lab.developmentMarkers = await page.evaluate(() => !!document.querySelector('nextjs-portal,script[src*="/_next/webpack-hmr"]'));
          const name = viewport + "-" + (path === "/" ? "home" : path.startsWith("/treatments/") ? "treatment" : "dashboard");
          await page.screenshot({ path: join(output, name + ".png"), timeout });
          // Scroll only after freezing performance data, to load lazy images for the visual record.
          phase = "post-measurement-scroll";
          for (let y = 0; y < Math.min(lab.layout.documentHeight, 20000); y += height) { await page.evaluate((top) => scrollTo(0, top), y); await page.waitForTimeout(180); }
          await page.evaluate(() => scrollTo(0, 0)); await page.waitForTimeout(1000);
          lab.afterScroll = await page.evaluate(measureLayout);
          await page.screenshot({ path: join(output, name + "-full.png"), fullPage: true, timeout });
          lab.screenshots = [name + ".png", name + "-full.png"];
          addImages([...lab.afterScroll.images.map((i) => ({ url: i.src, source: "browser-img" })), ...lab.afterScroll.backgrounds.map((url) => ({ url, source: "browser-background" }))], path);
          console.log("LAB", viewport, path, JSON.stringify(lab.metrics));
        } catch (error) { lab.error = error.name + ": " + error.message.slice(0, 500); console.log("LAB ERROR", viewport, path, sanitize(lab.error)); }
        finally { phase = "context-close"; await context.close(); }
        report.labs.push(lab);
      }
    }
    for (const [url, references] of referencedImages) {
      let target = url, result, redirects = [];
      for (let i = 0; i < 4; i++) {
        result = await request(target, agents.browser, true);
        if (result.status < 300 || result.status >= 400 || !result.location) break;
        target = new URL(result.location, target).href;
        if (!/^https?:/.test(target)) break;
        redirects.push(target);
      }
      const { body, ...http } = result;
      let decoded = null;
      if (http.status === 200 && /^(image\/|application\/octet-stream)/i.test(http.type)) {
        decoded = await parser.evaluate(async ({ data, type }) => {
          const img = new Image(); img.src = "data:" + type.split(";")[0] + ";base64," + data;
          try { await Promise.race([img.decode(), new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 5000))]); return { width: img.naturalWidth, height: img.naturalHeight }; }
          catch { return { error: "Image decode failed or timed out" }; }
        }, { data: body.toString("base64"), type: http.type });
      }
      report.images.push({ url, references, redirects, ...http, decoded, broken: http.status !== 200 || !decoded || !!decoded.error });
      if (report.images.length % 10 === 0) console.log("IMAGES", report.images.length, "of", referencedImages.size);
    }
    if (values.compare) {
      const baseline = JSON.parse(await readFile(resolve(root, values.compare), "utf8"));
      report.comparison = compareReports(report, baseline);
      if (baseline.version === 1) report.methodology.baselineCaveat = "v1 development flags matched production Turbopack bundles and are invalid; ignore those flags. Timings, layout, and SSR comparisons are unaffected. v1 request failures lack lifecycle phase.";
      if (baseline.version < 3) report.methodology.baselineRequestCaveat = "v1/v2 unfinishedRequests counts include aborted requests, not only pending requests. Inspect failures separately.";
    }
  } catch (error) { report.errors.push(error.name + ": " + error.message); }
  finally { await browser.close(); }
  report.finishedAt = new Date().toISOString();
  report.summary = { sitemapUrls: report.sitemapUrlCount, pagesChecked: report.pages.filter((p) => p.baseline).length,
    seoIssues: report.pages.reduce((n, p) => n + (p.issues?.length || 0), 0), botDifferences: report.pages.flatMap((p) => Object.values(p.bots || {})).filter((b) => b.differences?.length).length,
    imagesChecked: report.images.length, brokenImages: report.images.filter((i) => i.broken).length, labsCompleted: report.labs.filter((l) => l.metrics && l.screenshots).length,
    labErrors: report.labs.filter((l) => l.error).length, pageErrors: report.labs.reduce((n, l) => n + l.pageErrors.length, 0), errors: report.errors.length };
  await writeFile(join(output, "report.json"), JSON.stringify(sanitize(report), null, 2) + "\n");
  console.log(JSON.stringify({ report: join(output, "report.json"), ...report.summary }, null, 2));
  if (report.errors.length || report.summary.labErrors || report.summary.pagesChecked !== report.sitemapUrlCount) process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--self-test")) await selfTest();
  else await main().catch((error) => { console.error(sanitize(error.name + ": " + error.message)); process.exitCode = 1; });
}

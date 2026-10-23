# SOUL SEO Implementation Handover

Checked 24 October 2026 (Asia/Jerusalem). Repository: `soulclinic`.
Baseline: `2dceb67cb8c01afccd8156010a11dcc117d27457`, initially clean.
**No commit, push, deployment, migration, production-content edit, credential change or MCP/production-configuration change.**
Website changes are local only. One explicitly authorized Bing sitemap registration was completed.

Local production-mode preview: http://127.0.0.1:46397 (disposable MongoDB populated with a read-only copy of public content; no production writes).

## A. What Was Fixed

| File | Actual change |
| --- | --- |
| `src/components/Footer/page.js` | Permanent Arabic catalogue, About and Contact links in the existing three-column footer. |
| `src/app/page.js` | Server-rendered links to three real indexable categories and the catalogue. |
| `src/components/home/HomeClient.js` | Children slot below existing features; hero, image, perfume and CTA logic untouched. |
| `src/components/seo/TreatmentBreadcrumbs.js` | Small visible breadcrumb and one matching BreadcrumbList using the existing builder. |
| `src/app/treatments/[id]/page.js` | Supplies server breadcrumb. |
| `src/app/treatments/[id]/TreatmentClient.js` | Renders breadcrumb slot; no booking handler, price, duration, ID or image changes. |
| `src/app/api/admin/treatments/route.js` | Real category title/description changes advance persisted updatedAt; identical saves do not. Atomic field comparison keeps sitemap dates truthful. |
| `src/lib/seo/business.js` | Confirmed name SOUL, Deir Hanna and phone retained; unverified street/coordinates removed from SEO configuration. |
| `src/lib/seo/schema.js` | Confirmed locality/country only; no street, geo, map, unconfirmed social identity, hours, qualifications or service-area guesses. |
| `src/app/layout.js` | Shared confirmed brand used in title template. |
| `src/app/contact/page.js` | Search description no longer asserts the unconfirmed street. |
| `tests/seo/catalogue.test.js` | Confirmed-identity/omission regression and synchronized metadata expectation. |
| `scripts/seo-smoke.mjs` | Actual admin HTTP CRUD/reorder, dates/no-op, visibility and private-data regression tests. |
| `scripts/seo-discovery-check.mjs` | JavaScript-disabled initial-HTML links and breadcrumb/schema regression. |
| `scripts/seo-browser-audit.mjs` | Read-only HTTP, images, bot-UA, layout and lab-performance audit. |
| `docs/SEO-MEDICAL-REVIEW.md` | Source-backed proposed Arabic corrections, exact destinations and approvals; not applied. |
| `.gitignore` | Allows the medical review document; generated artifacts remain ignored. |
| `docs/SEO.md` | This handover. |

Local execution ledger: `docs/SEO-IMPLEMENTATION-PLAN.md` (ignored working documentation).
No dependency/lockfile changes. Request-time public reads, force-dynamic sitemap/catalogue/detail routes, original ID URLs, public projections, genuine 404s, private noindex routes, robots and social images retained. React cache here is per request/render, not a new persistent catalogue cache.

## B. Google Search Console

Reporting and inspection work on `sc-domain:soulclinc.net`, with siteOwner property permission.
That is distinct from the OAuth token's read-only API scope.

### All 12 Public URLs

Paths below are relative to `https://soulclinc.net`. Fresh URL Inspection:

| Path | Google state | Last crawl UTC |
| --- | --- | --- |
| `/` | Submitted and indexed; successful fetch | 2026-10-23 16:47:19 |
| `/contact` | Submitted and indexed; successful fetch | 2026-09-19 05:03:34 |
| `/dashboard` | Submitted and indexed; successful fetch | 2026-10-17 03:46:52 |
| `/about` | URL is unknown to Google | Unavailable |
| `/treatments/69dbaf697f07ea94b798a89f` (حجامة نبوية) | Unknown | Unavailable |
| `/treatments/69dbafa07f07ea94b798a8a0` (مساجات علاجية) | Unknown | Unavailable |
| `/treatments/69dbafbb7f07ea94b798a8a1` (ابر صينية) | Unknown | Unavailable |
| `/treatments/69dbafd87f07ea94b798a8a2` (رفلكسولوجي) | Unknown | Unavailable |
| `/treatments/69dbafe87f07ea94b798a8a3` (شموع الهوبي) | Unknown | Unavailable |
| `/treatments/69dbb022c2c6c1fc49bfa7e2` (رزمة VIP) | Unknown | Unavailable |
| `/treatments/69dbb03ac2c6c1fc49bfa7e3` (خدمة المنازل VIP) | Unknown | Unavailable |
| `/treatments/69dbbad4fea92418873da919` (علاجات للرأس والوجه) | Unknown | Unavailable |

Three confirmed indexed URLs in this inspected set is NOT a property-wide index count.
Unknown is not evidence of blocking, exclusion, penalty or "crawled, not indexed."
Contact/catalogue inspections retain old homepage user-canonicals, but Google-selected canonicals are correct.
CURRENT live HTML has correct self-canonicals; older crawl snapshots have not caught up.

### Performance and Impression Loss

Google web search. Latest returned complete daily data ends 21 October.
Dates follow the engine reporting calendar, not the local machine timezone.

| Metric | 24 Sep-21 Oct 2026 | 27 Aug-23 Sep 2026 |
| --- | ---: | ---: |
| Impressions | 978 | 1,807 |
| Clicks | 6 | 6 |
| CTR | 0.61% | 0.33% |
| Average position | 6.64 | 3.98 |
| Israel impressions | 355 | 1,094 |
| Mobile impressions | 898 | 969 |
| Desktop impressions | 75 | 836 |

All six current clicks are Israel/mobile. Current page rows: homepage 963 impressions/6 clicks, catalogue 13/0, Contact 9/0.
Page-impression sums need not equal property aggregates.

| Current disclosed query | Impressions | Clicks | Average position |
| --- | ---: | ---: | ---: |
| soul clinic | 161 | 0 | 8.92 |
| عيادة سول | 94 | 0 | 9.45 |
| سول ان كلينك | 75 | 0 | 7.39 |
| عيادات سول | 43 | 0 | 10.19 |
| مساج | 43 | 0 | 1.49 |
| massage | 35 | 0 | 1.71 |
| massage near me | 26 | 0 | 8.12 |
| עיסוי | 20 | 0 | 3.10 |
| cupping | 6 | 0 | 3.50 |
| مساج كرمئيل | 3 | 0 | 8.00 |
| مساج حجامة | 1 | 0 | 1.00 |

These query rows land on the homepage. No disclosed current rows establish acupuncture, Deir Hanna, Sakhnin or Arraba positions.
Missing rows are not zero positions. The 81 disclosed current queries total 674 impressions and zero clicks; the six property-level clicks have no disclosed query attribution here.

Evidence-supported concentration:
- `best massage near me`: 708 -> 1 impressions, zero clicks both periods; all desktop and homepage. Previous countries: Israel 527, Palestine 177, Lebanon 4. Current: one Palestine impression on 4 October.
- Daily impressions peaked at 65 on 4 September, fell to 1 on 21 September and 2 on 22 September, then nearly disappeared.
- Its 707 lost impressions equal approximately 85.3% of the property's net decline of 829. This is concentration, not a causal diagnosis.
- Disclosed brand-like rows matching `soul|سول|סול`: 402 -> 452 impressions; other disclosed rows: 1,009 -> 222. This heuristic includes ambiguous other-clinic searches, not necessarily actual SOUL demand.
- SearchAppearance grouping returned no rows for either period; no special-result attribution available.

Hypotheses only: loss of transient desktop/local exposure, changing query mix, ambiguous international SOUL searches and weak service-page discovery.
No evidence establishes a penalty, algorithm cause or verified Maps ranking.

## C. Sitemap

Live `https://soulclinc.net/sitemap.xml`: HTTP 200 XML; 12 unique HTTPS apex canonicals, four static pages and eight public categories.
All currently respond 200 with indexable server HTML. No private URLs, duplicate canonicals or synthetic render-time dates.
Robots returns 200, allows crawling and references this exact sitemap.

Google's stored report remains four submitted URLs:
- Submitted: 2026-01-31T13:25:39.745Z.
- Last downloaded: 2026-02-14T12:17:07.423Z.
- Zero reported errors/warnings. Deprecated `indexed: 0` is NOT an index count.
- Historical report differs from current XML; the reason for stale processing is unproven.

One authorized Google submission attempt returned:
> Search Console write access (sitemaps submit/delete, sites add/remove) requires additional authorization (Google scope: https://www.googleapis.com/auth/webmasters).

No retry, deletion, reconnection or scope/configuration change.
Owner action: open [SOUL Search Console Sitemaps](https://search.google.com/search-console/sitemaps?resource_id=sc-domain%3Asoulclinc.net), select the existing property, submit the SAME existing sitemap URL once, then check processing/read dates. Do not create a property or delete the existing record.
[Official submission API](https://developers.google.com/webmaster-tools/v1/sitemaps/submit) requires full webmasters scope.

Bing had no feed records and no alternate SOUL host property in its verified-sites list. One submission succeeded:

| Field | Actual API result |
| --- | --- |
| URL | `https://soulclinc.net/sitemap.xml` |
| Status/type | Success / Sitemap (initially Pending) |
| URL count / file size | 12 / 1,772 bytes |
| Submitted UTC | 2026-10-23T22:05:18.264Z (24 October locally) |
| Last crawled UTC | 2026-10-23T22:05:18Z |

This confirms processing, not 12 indexed pages. No repeat submission.

## D. Bing Webmaster Tools

Verified property and working reads/write capability.
22 Sep-19 Oct 2026: **3 impressions, 0 clicks, 0% CTR**.
Previous 25 Aug-21 Sep: **1 impression, 0 clicks, 0% CTR**.
Aggregate average position unavailable, not zero.

Latest crawl row, 21 October: **2 indexed pages**, zero crawl errors/4xx/5xx/robots blocks.
Latest seven reported days have zero such errors. Historical 28-day data recorded 27 error occurrences over 14 days, not 27 unique URLs.
URL-level GetCrawlIssues returned no rows; affected URLs/cause remain unavailable. Current live requests did not reproduce failures.

Weekly query rows: unrelated `عيادة علاج طبيعي السلمانية` (1 impression, 0 clicks, position 34) and `عياده ساذر لاند للعلاج الطبيعي` (3, 0, position 7), both homepage.
Weekly timestamps are not daily activity dates and were not used for period totals.

Connector caveats: Bing analytics_query ignores requested dates/dimensions; daily comparison and direct read-only calls through the installed authenticated client supplied totals/crawl rows.
Its health helper selects old rows as "recent"; raw rows were sorted. No connector code/configuration was edited.

IndexNow evaluated, not installed: genuine future public changes could use deduplicated, non-blocking notifications after approved key hosting.
Do not make it a booking/publishing dependency or submit private/unchanged URLs.
[Official requirements](https://www.indexnow.org/documentation) distinguish accepted notifications from indexing.

## E. Local SEO

Owner-confirmed: **SOUL; Deir Hanna, Israel; calls and WhatsApp 0532286019**.
Functional destinations consistently use +972532286019. No invented branches, credentials, hours, reviews or service areas.
Existing home-visit services remain unchanged and bookable.

New permanent links join Home, catalogue, About and Contact; the homepage links describe real cupping, massage and acupuncture categories in Deir Hanna.
No duplicate town pages or keyword stuffing. Existing useful service/location metadata retained apart from confirmed brand and unverified Contact street correction.

**High: medical approval required.** [Medical review](SEO-MEDICAL-REVIEW.md) supplies five category and 28 service replacement proposals, exact destinations, authoritative sources and homepage/About concerns.
Prioritize ear-candling risks and unsupported detox/organ-healing/guaranteed-result claims. No medical text or production service was changed.

Still confirm:
1. Exact street/address and clinic map pin.
2. Actual opening hours.
3. Practitioner name and qualifications.
4. Genuine home-visit areas, especially Sakhnin and Arraba.
5. Whether the existing Instagram profile is official.

Existing visible Contact-page street, map and hours were retained pending confirmation, not treated as newly verified facts, and omitted from JSON-LD.
Search Console does not authorize Business Profile editing. No Google Business Profile/Bing Places profile was changed or independently authenticated here.

## F. Design and Booking Safety

Run from repository root:
~~~text
npm run build
npm run test:run -- --maxWorkers=2 --silent
node scripts/seo-smoke.mjs --browser
node scripts/seo-discovery-check.mjs http://127.0.0.1:PORT
node scripts/seo-browser-audit.mjs --label live
node scripts/seo-browser-audit.mjs --base http://127.0.0.1:PORT --label local --compare tests/seo/artifacts/live/report.json
node tests/e2e/firebaseOtpV2/run.cjs
node tests/e2e/monthlySchedule/run.cjs
~~~

Final verification:
- Final production build passed.
- Full suite: 2,145/2,145 in 62 files, including the new confirmed-business test (baseline 2,144).
- Production-mode SEO/admin/browser smoke: 23 checks passed, including identical-save timestamp preservation.
- Booking/OTP browser suite: 204/204 passed on desktop/mobile; provider requests intercepted, no real SMS or bookings.
- Changed-file lint: passed. Audit-script self-tests: passed. Git diff whitespace checks: passed.
- Final rebuilt preview: all 12 pages passed confirmed SOUL name/phone/locality, absent unverified fields, one primary business entity, one H1, canonicals and social site-name checks. All eight category breadcrumb/link checks passed again with JavaScript disabled.
- One earlier high-concurrency run timed out in the existing Firebase runtime 5-second test during build; full reduced-worker rerun passed without auth/test changes.
- Scheduling browser suite: 78/78 passed, desktop/tablet/mobile.
- Full existing lint baseline: six errors in AdminLayoutClient, AppointmentsModal, HijriCuppingTable and useTheme. No unrelated workflow refactor.
- Build also reports outdated Browserslist data; no dependency churn.

Smoke tests use loopback temporary MongoDB, cloud-free fixtures, sanitized environment and disposable signed admin sessions.
Real category/service CRUD/reorder verifies public HTML, metadata/schema, exact prices/durations/IDs, actual lastmod, drafts/noindex/deletions, private-data omission, 404s and database-failure responses.
No production writes or appointment/provider messages.

Observed RED -> GREEN: missing footer links, missing category timestamp, confirmed-business identity.
No-op-save regression failed before atomic comparison and passes in the final-build HTTP checks.
JavaScript-disabled discovery passed all eight category breadcrumbs and three homepage links.

Live/local screenshots inspected at 1440x1000 and 390x844 for home/catalogue/cupping detail.
No core geometry/typography regressions; all 14 core image measurements match, with original sources/crops/sizes.
Treatment content moves down 36px for the allowed breadcrumb. Hero, 14px subtitle, perfume animation and link placement retained.
No page exceptions, broken rendered images or horizontal overflow.
Live/local audits: 12/12 pages, 58 checked image URLs each, no structural metadata/schema flags or spoofed bot-UA differences.
Spoofed Googlebot/Bingbot requests are NOT proof of actual engine fetches; inspections separately confirm three prior successful Google crawls.
Raw reports/screenshots: ignored `tests/seo/artifacts/{live,local}/`.

### Lab Performance, Not Field CWV

PageSpeed MCP remained rate-limited. No field CWV verdict or Lighthouse score is claimed.
Single unthrottled Chromium runs, fresh contexts, roughly eight-second observation on this machine/network; background load and RSC prefetch aborts limit comparability.

| Production page | Mobile LCP | Desktop LCP | Mobile CLS | Desktop CLS |
| --- | ---: | ---: | ---: | ---: |
| Home | 5,012 ms | 1,664 ms | 0.0438 | 0.00357 |
| Catalogue | 1,780 ms | 848 ms | 0 | 0 |
| Cupping detail | 1,440 ms | 1,256 ms | 0 | 0 |

First mobile home navigation: total TTFB 3,077 ms, request-start-to-response ~87 ms, substantial preconnection delay.
Do not blame the full delay on Next.js/MongoDB. Hero is already prioritized/optimized; its image and animation were preserved.
Detail transferred ~9.29 MB; six treatment photos account for 8,981,757 bytes and return PNG content despite .jpg names.
**Medium:** responsive image derivatives are a verified performance opportunity, deferred for explicit visual/quality approval. No source photo or presentation was altered.
Local timings do not prove a production speed improvement.

## G. Remaining Blockers and Decisions

- **High, deployment approval:** link/schema/date changes are local, not visible to engines until deployed.
- **High, Google UI/scope:** reports work; sitemap write needs native owner UI or separately approved full scope.
- **High, medical review:** source-backed corrections need qualified-practitioner and owner approval.
- **Medium, owner facts:** confirm address/map/hours/qualifications/service areas before schema expansion or replacing existing visible claims.
- **Medium, performance:** treatment image transfer needs a visually approved optimization; field CWV unavailable.
- **Low, existing tooling debt:** six unrelated lint errors and stale Browserslist data.
- **Unavailable:** property-wide Google exclusions, manual actions/security reports, verified Maps positions, server/WAF logs and new indexing outcomes.

Final review found the no-op timestamp issue and it was addressed with a failing-then-passing HTTP regression.
Deliberate boundaries: keep existing accurate metadata/caching; no IndexNow publishing hook; no image recompression; no unconfirmed town targeting.
Residual risk: homepage now reads the public catalogue for three links, adding a database dependency/query; current eight-category local timing is measured, not a production scaling guarantee.
CSS-disabled discovery tests prove initial anchors/schema, while separate browser comparisons cover visibility/layout.

## H. Next Steps

1. Review local preview/diff and approve deployment separately. No automatic deployment.
2. Refresh the SAME existing Google sitemap once in its native UI; Bing processing is already successful.
3. After authorized deployment, use URL Inspection **Test Live URL** for About, cupping, massage and acupuncture, then request indexing in that UI where available. Never misuse Google's restricted Indexing API.
4. Approve medical corrections, starting with ear candles, and confirm the short business-information list above.
5. Review responsive treatment-image delivery without changing original source assets/crops, then repeat lab/field checks.
6. Recheck all 12 engine states after crawling and compare Israel/non-brand service performance using consistent reporting windows.

### Official References

- [Google crawlable links](https://developers.google.com/search/docs/crawling-indexing/links-crawlable), [breadcrumbs](https://developers.google.com/search/docs/appearance/structured-data/breadcrumb), [Schema.org BreadcrumbList](https://schema.org/BreadcrumbList).
- [Google sitemap resource](https://developers.google.com/webmaster-tools/v1/sitemaps), [Search Analytics](https://developers.google.com/webmaster-tools/v1/searchanalytics/query).
- [Bing sitemap processing](https://www.bing.com/webmasters/help/sitemaps-3b5cf6ed).
- [Next.js versioned caching guide](https://github.com/vercel/next.js/blob/v16.1.1/docs/01-app/02-guides/caching.mdx). Installed 16.1.4; bundled node_modules/next/dist/docs absent.
- Medical citations accompany each proposal in the separate review.

**Bottom line:** Google visibility is real but small, Bing traffic minimal, and nine sitemap URLs remain unknown to Google.
Local discovery/freshness fixes and successful Bing sitemap processing address concrete weaknesses.
Indexing, rankings, Maps panels and AI recommendations remain search-engine decisions, not guarantees.

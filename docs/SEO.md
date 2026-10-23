# SOUL Clinic SEO handover

Updated 24 October 2026. Latest scope: SEO improvements without redesigning the
site, changing the main image, or changing booking/admin workflows.
Production remains https://soulclinc.net. No commit, deployment, production data
write, profile edit, sitemap submission or indexing notification was performed.

## Preserved design and behavior

- Original homepage headline: اكتشف طريقك إلى السلام الداخلي.
- Original configured hero-image URL, sizing, loader, image transition and refresh.
- Original floating perfume promotion and animation.
- Added the requested عطور SOUL link directly below احجز موعدك الآن.
- Added a visible 14px service/location sentence below the original hero headline.
- Original /dashboard address, heading, grid, card styling, arrows and animations.
- Original treatment detail layout, images, expandable text, prices and buttons.
- Original booking IDs, query parameters, appointment/authentication logic.
- Original About/Contact presentation and copy; Contact's heading is now an H1.
- Original header and footer styling/animation; confirmed phone is consistent.
- Admin editing/mutation code restored. No new publishing controls or slug migration.
- No database copy migration. Existing medical/promotional copy remains unchanged
  and should receive a separate factual review before being expanded or promoted.

## Retained SEO improvements

One business configuration uses the confirmed 0532286019 for calls and WhatsApp.
The existing street/map/Instagram values are preserved, not independently verified.
Opening hours and qualifications are not added to structured data.

Root metadata no longer forces the homepage canonical on every page.
Homepage, About, Contact, dashboard and treatment pages have distinct metadata,
absolute HTTPS canonicals and synchronized social previews.
Public data is server-rendered into the original presentation components.
Catalogue titles now contain real links without changing card appearance.

LocalBusiness, WebSite, Service and catalogue ItemList data use stable identifiers,
public data and escaped JSON-LD. The logo uses the real /logo.PNG asset.
Social image routes use the existing logo. No fake reviews or ratings.

robots.txt references the sitemap. The sitemap includes current public content
and persisted modification dates, omitting dates when unknown. No private routes.
Private pages have noindex metadata; existing authentication is unchanged.
Missing treatment IDs return real 404s; database failures are not converted to
successful empty pages or missing records.

## Route policy

| Route | Canonical / sitemap | Behavior |
| --- | --- | --- |
| /, /about, /contact | Self / included | Public 200 |
| /dashboard | Self / included | Original public catalogue, 200 |
| /treatments/[id] | Existing ID / included when indexable | Public 200, unknown 404 |
| /login, /appointments, /userAppointments, /admin/** | Excluded / noindex | Existing authentication and workflows |
| /feedback/[token], /reminders/unsubscribe/[token] | Excluded / existing noindex | Existing token controls |
| /api/treatment, /api/treatments | Excluded / noindex response header | Public field projection |

No /dashboard redirect or new /treatments hub remains. No existing URL migration.
Adding or updating records through the existing workflow updates SSR metadata,
catalogue links and sitemap on the next server request, without a rebuild.
React cache only deduplicates within a request; no shared public ISR/Redis cache.
Existing records without publication fields retain their public visibility.
Explicit draft records are excluded by the public read layer, but this change
does not introduce a new admin publication workflow.

## Baseline and external dependencies

Read-only live checks on 23 October 2026 at 21:01 UTC confirmed inherited
homepage metadata on About/Contact/catalogue/treatment pages, no initial H1 on
Contact/treatment details, and robots.txt returning 404. logo.PNG returned 200;
logo.png returned 404. Reproduce using node scripts/seo-live-check.mjs.

The connector lists Google owner access to sc-domain:soulclinc.net and verified
Bing https://soulclinc.net/. Actual analytics, sitemap and inspection requests
are blocked by its site allowlist. No external account configuration was changed.
Requested periods were 2026-09-23 through 2026-10-20 and 2026-08-26 through
2026-09-22. No metrics, volumes or rankings are invented.

No Business Profile/Places management connection was available. Webmaster access
does not establish local-profile access. PageSpeed returned a quota error; no
production field Core Web Vitals pass is claimed.

## Verification

Run:
- npm run build
- npm run test:run
- node scripts/seo-smoke.mjs --browser
- npm run lint -- --quiet

The smoke runner uses disposable loopback MongoDB and a production Next server.
It checks SSR, canonical/social/schema output, real 404s across five user agents,
sitemap updates after database edits, private noindex, failures, responsive RTL,
the restored hero title, small subtitle, perfume animation/link placement and
unchanged booking selection parameters.

Screenshots are ignored under tests/seo/artifacts. With --serve, the preview uses
a read-only copy of public production catalogue/image data in the disposable DB.
It never writes to production. Do not use the isolated preview for real bookings.

Final production build passed. The fresh full unit/integration run passed all
2,144 tests in 62 files. The preceding run timed out in the existing concurrent
OTP fallback test while other checks were running; the fresh full run passed.
Production SSR/metadata/lifecycle/outage checks and desktop/mobile restoration
checks passed, including the perfume animation and unchanged booking parameters.
Focused lint on the public presentation changes passed. Full lint still reports
six existing errors: two nested-component errors in the unchanged admin layout
(now moved to AdminLayoutClient.js), two effect/setState errors in
AppointmentsModal.jsx, one in HijriCuppingTable.jsx and one in useTheme.js.
These unrelated original behaviors were preserved, not refactored.
The earlier booking/OTP suite passed 203 of 204 tests; the remaining desktop
scroll-animation timing case passed alone. It was not a clean first-pass suite.
No booking-source change remains.

## Remaining owner facts and SEO work

Confirm the exact business name, address/map pin, hours, practitioner credentials
and actual home-visit towns. Do not infer branches in Sakhnin or Arraba.
The current medical/qualification claims were preserved at the owner's request;
they are not established by this technical SEO work.

Prioritize one page per actual service family, not one page per spelling/town:
cupping, massage, acupuncture, reflexology, packages, head/face care and genuine
home visits. The existing categories remain the landing pages.

Restore connector report access, reconcile the real Google Business Profile,
and verify regional Bing listing availability. Seek genuine reviews neutrally,
accurate reputable directory entries and relevant local references. Do not use
paid reviews, keyword-stuffed business names or mass-generated town pages.

At 30 days, establish complete reporting periods and check crawl/canonical health.
At 60 days, review service-page queries, CTR and qualified enquiries.
At 90 days, improve pages based on measured demand and conversion quality.
No new analytics tracker was added; future event collection must omit patient
data, health details, treatment selections and appointment identifiers.

Only after separately authorized deployment: verify live metadata, robots,
sitemap, images, real 404s and booking. Review existing sitemap status before any
submission. No deployment instructions or infrastructure were introduced here.

Google determines rankings, business panels, autocomplete and AI-answer inclusion.
Technical SEO improves clarity and crawlability; it cannot guarantee those results.

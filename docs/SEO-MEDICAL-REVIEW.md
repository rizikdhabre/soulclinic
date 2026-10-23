# SOUL Clinic Medical Copy Review

Review date and source access date: **24 October 2026**.

**PROPOSED ONLY. NOT APPLIED. Every replacement below requires both qualified-practitioner review and owner approval, followed by separate authorization to implement.** This document is not clinical approval, a treatment protocol, or permission to change services.

## Scope and Evidence

- Read-only `GET https://soulclinc.net/api/treatments` returned HTTP 200: **8 categories and 31 services**. Arabic text was read as UTF-8. Category IDs and service titles below identify that public snapshot, not an independently verified clinical offering.
- Follow [SEO handover constraints](SEO.md): preserve production data, prices, durations, services, qualifications, design, images, existing routes, booking parameters and admin workflows. No product code, configuration, database, external account, commit or deployment change is authorized here.
- No `.env`, credentials, private patient data or secrets were read. Only this Markdown document is written.
- These are editorial proposals grounded in the sources below, not a systematic review of every medical claim. An unsupported claim is not automatically a disproven claim. General research does not establish the effectiveness, safety or credentials of this clinic.
- `services[n]` uses the **zero-based public API order**. The projection in `src/lib/catalogue/model.js:19` filters services and omits service IDs. Before any later approved edit, re-fetch and match category ID plus exact service title; never treat a public array index as a durable database identifier.

## Where the Copy Appears

| Source field or code | Observed destination | Proposed destination after approval only |
| --- | --- | --- |
| Category `description` | `src/app/dashboard/DashboardClient.js:35` passes it to `src/components/TreatmentCard/page.js:56`; `src/app/treatments/[id]/TreatmentClient.js:41` displays it below the category title. | Replace the approved category field at its source, preserving both existing presentations. |
| Category `seoDescription` or fallback `description` | `src/app/treatments/[id]/page.js:17`; `src/lib/seo/metadata.js:9` and its Open Graph/Twitter descriptions. All eight live `seoDescription` values were empty. | Keep future approved metadata consistent with visible copy; do not hide the medical correction in SEO-only text. |
| Category `description` | `src/lib/seo/schema.js:23`, top-level `Service.description`. | Same approved category wording. `seoDescription` alone does not correct this schema field. |
| `services[n].description` | `src/app/treatments/[id]/TreatmentClient.js:76`; `src/lib/seo/schema.js:28`, `hasOfferCatalog.itemListElement[n].itemOffered.description`. | Same approved service wording in visible cards and structured data. Do not manually create a divergent schema description. |
| Category `details` | Present in the public projection, empty for all eight categories; not rendered by the inspected treatment component. | Do not place the only safety correction here: it would not reach the inspected visible copy or schema. |

The service paragraph is initially `line-clamp-3` (`TreatmentClient.js:73`). Put ear-candling warning text **first**, including in packages; do not bury it behind promotional wording or “عرض المزيد”. Later approval must include checking the collapsed mobile/desktop display without redesigning the page. No rendering change is made here.

## Shared Proposed Arabic Text

Labels below are document shorthand, **not new application fields**. A table entry such as `E1 + ...` means the full E1 text followed by the stated Arabic sentence. These proposals replace the offending wording; they are not disclaimers to append while retaining contradictory promises.

| Label | Proposed Arabic wording | Evidence boundary |
| --- | --- | --- |
| **C1** | الحجامة ممارسة تستخدم الشفط على الجلد. قد تساعد في تخفيف بعض الألم، لكن الأدلة محدودة ولا تثبت أنها تنقي الجسم من السموم. قد تسبب آثارا جلدية وحروقا وعدوى. | [NCCIH cupping][cupping]: weak pain evidence and documented harms; no basis here for detoxification or guaranteed healing. |
| **M1** | قد يساعد التدليك في تخفيف بعض آلام الظهر والرقبة لفترة قصيرة، لكن الأدلة محدودة والاستجابة تختلف. لا يضمن الشفاء أو التعافي من الإصابات. | [NCCIH massage][massage]: benefits depend on condition, may be short term, and evidence quality varies. |
| **A1** | الوخز بالإبر يستخدم إبرا دقيقة تدخل الجلد، وقد يساعد في بعض حالات الألم. تختلف النتائج ولا يعد بديلا عن التقييم الطبي. قد تحدث مضاعفات، خصوصا عند استخدام إبر غير معقمة أو تطبيق غير سليم. | [NCCIH acupuncture][acupuncture]: condition-specific evidence, uncertain mechanisms and potential serious harms; not an unconditional “safe and effective” alternative to medicines. |
| **R1** | الرفلكسولوجي ممارسة تعتمد على الضغط على نقاط في القدمين. لم يثبت أن هذه النقاط تعالج أعضاء الجسم الداخلية أو تحفز شفاءها. | [NCCIH reflexology][reflexology]: the claimed correspondence and healing effects are unproven. |
| **E1** | لا توجد فوائد طبية مثبتة لشموع الأذن (الهوبي)، وليست طريقة مثبتة لإزالة شمع الأذن. قد تسبب حروقا وانسداد قناة الأذن وثقب طبلة الأذن وفقدانا مؤقتا للسمع. | [Health Canada ear candling][ear]: no proven medical benefits; injury risks. Do not reframe candles as harmless relaxation, cleansing, suction or sinus treatment. |

Health Canada also advises avoiding ear candling. **Escalate all five candle-containing services for practitioner and owner safety review before further promotion.** Deciding whether to retain or withdraw them is outside this document's authority; nothing is removed or disabled here. The Canadian source is medical evidence, not a determination of local law.

## Exact Category and Service Proposals

Each row below is **proposed, pending both approvals, not applied**. Existing excerpts are locator evidence, not endorsed statements. Titles, prices, duration fields, cup-count fields and booking identifiers must remain unchanged under the present scope. Existing numeric details retained in draft prose below come from the live record; no new session length or price is proposed.

### 69dbaf697f07ea94b798a89f | حجامة نبوية

Evidence: [cupping][cupping] and, for the combined session, [massage][massage]. More cups, body size, enthusiasm, a first visit or a one-year gap are not established suitability rules in these sources.

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `description` | “تنقية الجسم من السموم” and “تجديد طاقة جسمك” | **C1** |
| `services[0].description` / `حجامة 1` | “اذا كنت اول مرة” / “اكثر من سنة” establishes automatic suitability and a follow-up progression. | عدد الكاسات: 1-14 كاسة. جلسة حجامة للظهر. تحتاج ملاءمتها إلى تقييم فردي، ولا يكفي كونها الجلسة الأولى أو مرور سنة على الجلسة السابقة لتحديد ذلك. |
| `services[1].description` / `حجامة 2` | Regular attendance justifies additional cups; unqualified pain/spasm relief. | عدد الكاسات: 15-19 كاسة. جلسة حجامة؛ فائدة الحجامة للألم غير مؤكدة، وملاءمة الجلسة تحتاج إلى تقييم فردي. |
| `services[2].description` / `حجامة 3` | “بُنية اجسادهم ضخمة فهذه الجلسة المناسبة لك” | عدد الكاسات: 19-24. جلسة حجامة؛ لا تتحدد ملاءمتها بحجم الجسم أو الرغبة في عدد أكبر من الكاسات وحدهما. |
| `services[3].description` / `حجامة + 10 د مساج` | “لتنشيط الدورة الدموية” and first-visit superiority. | عدد الكاسات: 1-14. تبدأ الجلسة بعشر دقائق من التدليك، تليها الحجامة. ملاءمة الجمع بينهما تحتاج إلى تقييم فردي، ولا توجد نتيجة مضمونة. |
| `services[4].description` / `حجامة جافه` | Unqualified pain relief and circulation activation. | الحجامة الجافة تستخدم الشفط دون تشريط الجلد. الأدلة على فائدتها للألم محدودة، وقد تحدث آثار جلدية أو مضاعفات. |

`services[5]` / `حجامة VIP` has promotional exclusivity language, but no specific medical benefit claim identified in its description. No medical replacement proposed for that field; its eligibility wording remains an owner clarification, not a verified clinical criterion.

### 69dbafa07f07ea94b798a8a0 | مساجات علاجية

Evidence: [NCCIH massage][massage]. General massage evidence does not establish bamboo superiority, metabolic activation, guaranteed recovery or the effectiveness of this clinic's specific methods. Rare serious adverse effects are reported, including with vigorous massage; “آمنة” must not mean risk-free.

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `description` | “علاج حقيقي” / “يخلصه من الآلام” / sports-injury recovery implications. | جلسات تدليك للجسم. **M1** |
| `services[0].description` / `مساج علاجي` | “ايصال كميات كبيرة من الدم الى كل العضلات” and rapid relief. | جلسة تدليك تركز على مناطق الانزعاج العضلي. **M1** |
| `services[1].description` / `مساج علاجي عميق` | “الاستشفاء العميق وتنشيط الدورة الدموية” | جلسة تدليك تركز على مناطق الانزعاج العضلي، بهدف الراحة دون ضمان التعافي. |
| `services[2].description` / `مساج علاجي مكثف` | “فك التشنجات العضلية المزمنة” / “استعادة التوازن الطبيعي للجسم” | جلسة تدليك تتضمن الضغط على الأنسجة العضلية، دون ضمان زوال التشنجات المزمنة. |
| `services[3].description` / `مساج علاجي VIP` | “تفكيك العقد العضلية العميقة” / “التعافي” | ساعة من تدليك الجسم بهدف الراحة، دون ضمان الشفاء أو التعافي. |
| `services[4].description` / `مساج البامبوك` | “بفعالية لا يحققها المساج اليدوي التقليدي” | تدليك باستخدام عصي الخيزران. لا يقدم هذا الوصف ضمانا بأنه أكثر فعالية من التدليك اليدوي. |
| `services[5].description` / `احجار ساخنة` | “تنشيط الايض” and definite deep-muscle effects. | جلسة تستخدم أحجار البازلت الدافئة بهدف الراحة، دون وعد بتنشيط الأيض أو علاج مرض. |
| `services[6].description` / `احجار ساخنة VIP` | “الارتخاء الكامل” attributed to prolonged heat absorption. | جلسة تستخدم أحجار البازلت الدافئة قبل التدليك بهدف الراحة؛ يختلف الشعور بالاسترخاء بين الأشخاص. |

### 69dbafbb7f07ea94b798a8a1 | ابر صينية

Evidence: [NCCIH acupuncture][acupuncture]. The live service explicitly mentions electrical stimulation; that is recorded copy, not verification of equipment or qualifications. Do not equate acupuncture and dry needling or silently change the offered procedure.

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `description` | “إعادة التوازن الداخلي للأعضاء” / “حل آمن وفعال بعيداً عن الأدوية” | **A1** |
| `services[0].description` / `ابر صينية` | “مسارات الطاقة الحيوية” / “تقليل الالتهابات” / “نتائج علاجية عميقة وسريعة” | جلسة وخز بالإبر تتضمن تحفيزا يدويا وكهربائيا. قد يساعد الوخز في بعض حالات الألم، لكن لا يضمن نتائج سريعة أو تقليل الالتهابات، وتحتاج ملاءمته إلى تقييم فردي. |

### 69dbafd87f07ea94b798a8a2 | رفلكسولوجي

Evidence: [NCCIH reflexology][reflexology]. Do not turn a traditional organ-map explanation into established anatomy or a promise to treat anxiety, insomnia or internal organs.

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `description` | “تحفيز الشفاء الذاتي، تحسين وظائف الأعضاء” | **R1** |
| `services[0].description` / `رفلكسولوجي` | Organ-linked points, circulation activation and guaranteed rapid vitality. | جلسة ضغط على نقاط في القدمين لمدة 20 دقيقة، بهدف الراحة دون ضمان تأثير علاجي على أعضاء الجسم. |
| `services[1].description` / `رفلكسولوجي VIP` | “مراكز الطاقة” / “تحسين جودة النوم، تقليل القلق” / “التشافي الذاتي” | جلسة ضغط على نقاط في القدمين لمدة 30 دقيقة مع زيوت دافئة، بهدف الراحة؛ لا تقدم بوصفها علاجا مثبتا للقلق أو اضطرابات النوم أو أعضاء الجسم. |

### 69dbafe87f07ea94b798a8a3 | شموع الهوبي

**Highest-priority factual correction.** Evidence: [Health Canada][ear]. Safety warning wording must survive any shortened metadata or card excerpt.

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `description` | Headache/migraine, ear inflammation, tinnitus and wax-reduction claims. | **E1** |
| `services[0].description` / `شموع الهوبي` | “السحب اللطيف لتنقية الأذنين وتخفيف ضغط الجيوب الأنفية” | **E1** |
| `services[1].description` / `شموع الهوبي VIP` | “فوائد شموع الهوبي لتطهير الاُذنين و الجيوب الأنفية والام الرأس” | **E1** + يتضمن الوصف الحالي أيضا تدليك الوجه والفكين بزيوت عطرية؛ وجود التدليك لا يلغي مخاطر شموع الأذن. |

### 69dbb022c2c6c1fc49bfa7e2 | رزمة VIP

Exact API category title in JSON notation: `"رزمة VIP\uD83D\uDC51"`. The category description is promotional, with no specific clinical outcome identified; no replacement proposed for that category field. Evidence for the services: [cupping][cupping], [massage][massage], [ear candling][ear]. Do not infer a combined-package benefit from studies of one component.

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `services[0].description` / `حجامة 1 +مساج` | “تنقية الجسم من السموم عبر الحجامة الوقائية” | رزمة مدتها 50 دقيقة تجمع التدليك والحجامة، دون وعد بتنقية الجسم من السموم أو الوقاية من الأمراض. |
| `services[1].description` / `حجامة + مساج + شموع الهوبي` | Candles “تعمل على سحب الضغط والتوتر من الرأس والأذنين”. | **E1** + تتضمن هذه الرزمة أيضا الحجامة والتدليك؛ الجمع بينها لا يثبت فائدة لشموع الأذن ولا يلغي مخاطرها. |
| `services[2].description` / `حجامه 1 + علاج للوجه ` | “تضمن لك الحجامة تنقية دورتك الدموية” and immediate skin results. | رزمة تجمع الحجامة والعناية بالوجه، دون ضمان تنقية الدم أو نتائج فورية للبشرة. |
| `services[3].description` / `حجامة + مساج + مساج للوجه` | “الاستشفاء العضلي والدموي” / “شد البشرة وتنشيط الكولاجين” | رزمة مدتها 60 دقيقة تجمع الحجامة وتدليك الجسم والوجه، دون ضمان الشفاء أو شد البشرة أو زيادة الكولاجين. |
| `services[4].description` / `مساج + شموع الهوبي + مساج للوجه` | “مثالية للتخلص من الأرق، الصداع” and gentle-heat framing of candles. | **E1** + تتضمن هذه الرزمة أيضا تدليك الجسم والوجه، ولا تقدم بوصفها علاجا مثبتا للأرق أو الصداع. |

The service title at index 2 has a trailing space in the API; retain the stored title and booking identity. The reviewed sources do not establish the package's collagen or skin-tightening claim; this is an evidence gap, not proof that every facial intervention is ineffective. “الأكثر طلباً” also needs business records before reuse.

### 69dbb03ac2c6c1fc49bfa7e3 | خدمة المنازل VIP

No specific medical outcome was identified in the category description. No replacement proposed for that field, and **no towns or service radius are inferred**. Evidence: [cupping][cupping], [massage][massage], [ear candling][ear].

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `services[0].description` / `حجامة + 10 د مساج` | Automatic first-visit/one-year-gap recommendation, blood-flow and maximum-benefit claims. | جلسة منزلية تبدأ بعشر دقائق من التدليك تليها الحجامة. تحتاج ملاءمتها إلى تقييم فردي، دون افتراض أنها الأنسب لكل زيارة أولى. |
| `services[1].description` / `حجامة + 30د مساج` | “لتخليص الجسم من السموم والشوائب” / “تعيد ترتيب طاقة جسدك” | جلسة منزلية تتضمن 30 دقيقة من التدليك تليها الحجامة، دون وعد بإزالة السموم أو الشفاء. |
| `services[2].description` / `حجامة + 30د مساج + شموع الهوبي` | “سحب الضغوط وتطهير الأذنين والجيوب الأنفية” | **E1** + تتضمن هذه الجلسة المنزلية أيضا الحجامة والتدليك؛ وجودهما لا يلغي مخاطر شموع الأذن. |
| `services[3].description` / `مساج علاجي` | Guaranteed restoration of lost flexibility and body balance. | جلسة تدليك منزلية مدتها 50 دقيقة بهدف الراحة؛ تختلف الاستجابة ولا تضمن استعادة المرونة أو التعافي. |

### 69dbbad4fea92418873da919 | علاجات للرأس والوجه

Exact API category title in JSON notation: `"علاجات للرأس والوجه \uD83D\uDE0C"`. No specific clinical outcome was identified in the category description. Evidence: [NCCIH massage][massage] for inconsistent headache findings and [American Academy of Dermatology][skin] for exfoliation suitability and irritation risk. Neither source validates this clinic's facial protocol or collagen claims.

| Exact field / current service title | Existing wording needing review | Proposed replacement |
| --- | --- | --- |
| `services[0].description` / `مساج لفروة الرأس والوجه` | “تحفيز الدورة الدموية” / “يُخفف من الام الراس والصُداع والافكار السلبية وتفتيح الوجه” | تدليك لفروة الرأس والوجه بهدف الراحة، دون وعد بعلاج الصداع أو الأفكار السلبية أو تفتيح البشرة. |
| `services[1].description` / `علاج للبشرة` | “بتعقيم الوجه” / steam “تفتيح مسامات الوجه” / “انتاج الكولاجين” / headache relief. | جلسة عناية بالوجه تشمل التنظيف والتقشير والبخار وإزالة الزيوان، يليها تدليك فروة الرأس والوجه والدقن. قد يسبب التقشير تهيجا؛ لا تتضمن الجلسة ضمانا لزيادة الكولاجين أو علاج الصداع. |

The procedure list in the second draft comes from the existing service, not an endorsement; a qualified practitioner must verify its actual steps, product suitability and scope before approval. “التنظيف” avoids claiming sterilization. “الأول في المنطقة” in index 0 requires independent business evidence before reuse. No additional medical replacement is proposed for `services[2]` (`"علاج للبشرة جلسة الانتعاش\uD83D\uDC51"`) or `services[3]` (`"\uD83D\uDC51 الجلسة المُميزة\uD83D\uDC51"`): their descriptions are cosmetic/relaxation promotion, not the specific disease/mechanism claims above. This is not blanket clinical approval of either service.

## Proposed UI Text Destinations

**Documentation only; all source strings and layouts remain unchanged.** Line numbers identify the inspected local source, not proof that the same revision is deployed. These drafts avoid unverified credentials and outcome guarantees. Evidence boundaries are the same [cupping][cupping], [massage][massage], [acupuncture][acupuncture] and [reflexology][reflexology] sources; business claims require owner documents, not medical citations.

| Source destination | Existing concern | Proposed Arabic text in that same text slot |
| --- | --- | --- |
| `src/app/dashboard/DashboardClient.js:18`, introductory paragraph | Blanket “علاجية آمنة وفعّالة” and body/psychological balance. | تعرّف على الجلسات المتاحة وتفاصيلها. تختلف الأدلة والمخاطر بحسب نوع الجلسة والحالة الفردية، ولا توجد نتيجة مضمونة. |
| `src/components/home/HomeClient.js:279`, first feature title/description | All treatments organic/sustainable and “شفاء نقي”. | Title: العناية والراحة. Description: تعرّف على تفاصيل كل جلسة ومكوناتها قبل الحجز. |
| `src/components/home/HomeClient.js:285`, second feature title/description | “أخصائيين مختصين” / “ممارسونا المعتمدون” without verified credentials or team count. | Title: مقدّم الجلسة. Description: للاستفسار عن مؤهلات وخبرة مقدّم الجلسة، تواصل معنا قبل الحجز. |
| `src/components/home/HomeClient.js:291`, third feature title/description | “نتائج مُغيِّرة للحياة” / “فوائد دائمة”. | Title: تجربة فردية. Description: تختلف الاستجابة للجلسات بين الأشخاص، ولا توجد نتائج مضمونة. |
| `src/app/about/AboutClient.js:19`, introduction | Self-healing, energy balance, unverified “أكثر من 3 سنوات”, and dry needling not matched to the API's acupuncture terminology. | يعرّف هذا الموقع بخدمات SOUL والجلسات المتاحة. يمكن الاستفسار عن تفاصيل الجلسة ومقدّمها قبل الحجز. |
| `src/app/about/AboutClient.js:40`, mission paragraph | “طبيعية وآمنة” / “فعّالة” / “شفاء حقيقي ومستدام”. | هدفنا الاهتمام براحة كل مراجع واحترام احتياجاته، مع عرض حدود النتائج المتوقعة دون ضمان الشفاء. |
| `src/app/about/AboutClient.js:60`, mission caption | “الشفاء بهدف”. | الاهتمام براحتك |
| `src/app/about/AboutClient.js:89`, values introduction | Unqualified safety, highest-quality and healing framing. | نحرص على الصدق واحترام خصوصية كل مراجع والإصغاء إلى احتياجاته، دون وعود بنتائج علاجية مضمونة. |
| `src/app/about/AboutClient.js:110`, excellence feature description | “لضمان أفضل النتائج الممكنة”. | نسعى إلى تقديم الخدمة باهتمام ومسؤولية، مع توضيح حدود النتائج المتوقعة. |
| `src/app/about/AboutClient.js:161`, team paragraph | Unverified accreditation, professional certificates and customer-satisfaction record. | للاستفسار عن هوية مقدّم الجلسة ومؤهلاته وخبرته، تواصل معنا قبل الحجز. |
| `src/components/Footer/page.js:41`, brand tagline | “شفاء الجسد”. | العناية والراحة والاهتمام بك |
| `src/app/contact/ContactClient.js:44`, welcome paragraph | “راحتكم وشفائكم”. | نرحّب بتواصلكم للتعرّف على خدماتنا وتفاصيل الجلسات قبل الحجز. |

The traditional-calendar label at `src/components/ui/HijriCuppingTable.jsx:73` is not itself a clinical-efficacy claim. Leave it and the existing hero headline unchanged; do not expand calendar dates into medically superior timing or a treatment schedule without appropriate evidence and separate approval.

## Unknown Owner Facts

| Fact awaiting owner verification | Current evidence and constraint |
| --- | --- |
| Exact business/public name | `src/lib/seo/business.js:2` contains SOUL Clinic / عيادة SOUL; confirm preferred official spelling before changing profiles or identity fields. |
| Exact address and map pin | `business.js:7` and `src/app/contact/ContactClient.js:12` contain شارع القدس / دير حنا, with existing coordinates/map links. These are inherited site values, not independently verified. Obtain exact address, building/unit information if applicable and correct map pin. Do not infer branches in Sakhnin or Arraba. |
| Opening hours | `ContactClient.js:18` currently displays `السبت – الاثنين: 9:00 - 20:00`; `business.openingHours` is empty. The displayed text is not owner confirmation of a weekly schedule. Confirm each operating day, appointment-only arrangements and exceptions before adding hours to structured data. |
| Practitioner identity, qualifications and scope | Home/About copy asserts accreditation, certificates and experience, but no issuing body, qualification, scope or supporting verification was established. Confirm actual practitioner(s), certificate names, issuers, dates, relevant registration if applicable and experience start date. Do not invent credentials or treat this reviewer's requested qualification as an existing clinic credential. |
| Home-visit area | Live category `69dbb03ac2c6c1fc49bfa7e3` exists, but `business.homeVisitAreas` is empty. Obtain actual towns/radius and conditions; no assumed nearby towns, branches or coverage. |
| Exact procedures and product claims | Resolve acupuncture/electroacupuncture versus About's dry needling; verify actual package contents, oils, facial steps and any “organic/sustainable” statements. Do not convert this clarification into new services, eligibility rules, durations, prices or guarantees. |

## Approval and Later Verification

| Gate | Status |
| --- | --- |
| Qualified practitioner checks evidence, Arabic accuracy, safety framing and actual scope of practice | **Pending** |
| Owner confirms facts and approves each exact field/UI replacement | **Pending** |
| Separate authorization for implementation or service changes | **Not granted by this document** |
| Production copy, code, schema, metadata, prices, services, qualifications and design changes | **Not applied by this task** |

For a later authorized implementation only: re-fetch the catalogue; reconcile changed titles/order and preserve commercial/booking fields; replace approved claims at their source; verify visible descriptions, collapsed candle warnings, metadata/social descriptions and JSON-LD agree. A generic disclaimer does not make an unsupported claim acceptable. Do not add practitioner approval names/dates until approval actually occurs.

## Primary Sources

All sources below were accessed **24 October 2026**. This is the retrieval date, not a claim that each publication was updated that day. Government/professional guidance is used directly; it does not endorse SOUL Clinic.

| Source | Relevant scope | Accessed |
| --- | --- | --- |
| [Health Canada: Ear candling][ear] | Lack of proven medical benefit, unsupported suction mechanism, injury risks and recommendation to avoid. | 24 October 2026 |
| [NCCIH: Cupping][cupping] | Limited pain evidence and adverse effects; not proof of toxin removal or a dose/suitability rule. | 24 October 2026 |
| [NCCIH: Acupuncture, Effectiveness and Safety][acupuncture] | Evidence varies by condition; mechanisms are not fully understood; improper technique/nonsterile needles can cause serious harm. | 24 October 2026 |
| [NCCIH: Massage Therapy, What You Need To Know][massage] | Limited/short-term evidence for some pain conditions; inconsistent headache findings; not risk-free. | 24 October 2026 |
| [NCCIH: Reflexology][reflexology] | Claimed healing of corresponding organs is unproven. | 24 October 2026 |
| [American Academy of Dermatology: How to safely exfoliate at home][skin] | Exfoliation is not suitable for everyone and can irritate/damage skin; not validation of the clinic's facial procedure. No home-treatment instructions are reproduced. | 24 October 2026 |
| [SOUL public treatment API](https://soulclinc.net/api/treatments) | Existing category IDs, titles and wording only; not medical evidence. | 24 October 2026 |

[ear]: https://www.canada.ca/en/health-canada/services/medical-procedures/ear-candling.html
[cupping]: https://www.nccih.nih.gov/health/cupping
[acupuncture]: https://www.nccih.nih.gov/health/acupuncture-effectiveness-and-safety
[massage]: https://www.nccih.nih.gov/health/massage-therapy-what-you-need-to-know
[reflexology]: https://www.nccih.nih.gov/health/reflexology
[skin]: https://www.aad.org/public/everyday-care/skin-care-secrets/routine/safely-exfoliate-at-home

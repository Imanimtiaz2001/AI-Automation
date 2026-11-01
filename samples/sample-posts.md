# Sample output: posts generated from real PlacidWay pages

Each sample is based on a live, public PlacidWay page (facts captured 2026-10-28, one page at a time, listed under each sample). The three variants per page were prepared offline, without API calls, following the workflow's exact generation prompt. The workflow's own code (`src/lib/guardrails.js`, the same code inlined into the n8n Code nodes) then assembled each post and ran the layer-1 rule checks shown below. In a live run the variants come from the configured model and the survivors also pass the layer-2 LLM judge; `npm run samples:live` regenerates them with an API key.

> **Control variants.** Variant 2 of every sample is a deliberately non-compliant draft (outcome promises, invented prices, superlatives) that we inject to show what the rules catch. It is not something the prompt tends to produce.

Regenerate after a live run: the run log (`pw_run_log.post_text`, `details.guardrails`) and the dashboard hold the real output of every run. `npm run samples` re-checks these files.

## 1. What is the Cost of Shoulder Replacement in Guadalajara?

- **Source URL:** https://www.placidway.com/answer-detail/29/How-Much-Does-Shoulder-Replacement-Cost-in-Guadalajara-Mexico
- **Content type:** answer
- **Featured image:** [og:image, 1200×630](https://www.placidway.com/cdn-cgi/image/quality=50,fit=pad,width=1200,height=630/https://placidwaycdn.s3.amazonaws.com/images/questions/1787057262Shoulder-Replacement-Cost-in-Guadalajara-(2).png)
- **Selected:** variant 1 (“practical takeaway”), 390 characters before the link (limit 500)

```text
Planning a shoulder replacement in Guadalajara, Mexico?

Typical estimates run $8,500 to $11,500, depending on the implant, hospital and package.
Travel, accommodation and physical therapy may be billed separately, so ask for an itemized bill.
Plan for roughly 10 to 14 days in the area and get your surgeon's travel clearance before flying.

Read the full answer before you request quotes.

👉 https://www.placidway.com/answer-detail/29/How-Much-Does-Shoulder-Replacement-Cost-in-Guadalajara-Mexico

#MedicalTourism #Guadalajara #ShoulderReplacement #OrthopedicCare
General information only, not medical advice.
```

| Variant | Angle | Chars before link | Layer-1 rules | Findings |
|---|---|---|---|---|
| 1 | practical takeaway | 390 | ✅ pass | — |
| 2 | too salesy | 149 | ❌ blocked | ❌ outcome_promise: "guaranteed" (guarantee)<br>❌ medical_claim: "Cure" (cure)<br>❌ outcome_promise: "pain-free" (painless)<br>❌ pressure: "Book today" (pressure)<br>❌ ungrounded_number: not found in source: 70<br>⚠️ evidence_missing: model cited no evidence |
| 3 | question-led | 275 | ✅ pass | — |

<details><summary>Facts captured from the page (grounding set)</summary>

- Page heading: How Much Does Shoulder Replacement Cost in Guadalajara, Mexico?
- A typical shoulder replacement in Guadalajara is estimated at $8,500 to $11,500.
- The price depends on the procedure type, the surgeon, the hospital, the implant and what the package includes.
- Reverse shoulder replacement pricing varies by provider.
- Travel, accommodation, physical therapy and other services may be billed separately; the page recommends requesting an itemized bill.
- Cost factors include prosthetic design, implant brand, hospital tier and whether post-operative physical therapy is included.
- Patients should plan for roughly 10 to 14 days in the area before flying home, which requires the surgeon's travel clearance.
- Preoperative testing includes imaging, blood panels, a cardiac assessment including an ECG, and an orthopedic exam.
- Risks listed include infection, blood clots, component loosening, instability, nerve irritation and stiffness.
- Patients are advised to arrange a local orthopedic specialist or physical therapist at home before travelling and to have medical records translated.
- Initial inpatient therapy is usually included; outpatient therapy often is not. The surgery takes about one to two hours.

</details>

## 2. Facelift Package in Seoul, South Korea by VG Clinic

- **Source URL:** https://www.placidway.com/package/6950/Facelift-Package-in-Seoul-South-Korea-by-VG-Plastic-Surgery
- **Content type:** package
- **Featured image:** [og:image, 1200×630](https://www.placidway.com/cdn-cgi/image/quality=85,fit=pad,width=1200,height=630/https://placidwaycdn.s3.amazonaws.com/images/package/1787230787PKG-6950-_-Facelift-_-Seoul-VG-(2).png)
- **Selected:** variant 1 (“what the package lists”), 368 characters before the link (limit 500)

```text
Comparing facelift packages in Seoul?

This VG Plastic Surgery package in Gangnam is listed from $5,100.
It lists consultation, anesthesia, preoperative tests, postoperative reviews and interpreter coordination.
Airfare, visas and accommodation are extra, and the page suggests planning about 10-14 days in Seoul.

Check the full inclusions before you request a quote.

👉 https://www.placidway.com/package/6950/Facelift-Package-in-Seoul-South-Korea-by-VG-Plastic-Surgery

#MedicalTourism #Seoul #FaceliftAbroad #SouthKorea
General information only, not medical advice.
```

| Variant | Angle | Chars before link | Layer-1 rules | Findings |
|---|---|---|---|---|
| 1 | what the package lists | 368 | ✅ pass | — |
| 2 | too salesy | 126 | ❌ blocked | ❌ outcome_promise: "Guaranteed" (guarantee)<br>❌ outcome_promise: "100%" (100%)<br>❌ unverifiable_superlative: "best" (superlative)<br>❌ outcome_promise: "100% safe" (absolute safety)<br>❌ pressure: "Hurry" (pressure)<br>❌ unsupported_credential: "JCI" is not stated in the source<br>❌ ungrounded_number: not found in source: 100, 3,999<br>⚠️ evidence_missing: model cited no evidence |
| 3 | planning checklist | 309 | ✅ pass | — |

<details><summary>Facts captured from the page (grounding set)</summary>

- Facelift package at VG Plastic Surgery, Gangnam-gu, Seoul, starting at $5,100.
- The procedure targets jowls, lower-face sagging and loose neck skin.
- The final quote depends on the surgeon's assessment and the written inclusions.
- Planned stay: about 10-14 days in Seoul, subject to surgeon advice and flight clearance.
- Listed inclusions, to be confirmed in writing: consultation, surgery and any planned neck work, anesthesia, facility charges, preoperative tests, dressings and routine medication, postoperative reviews, drain or suture removal, interpreter coordination.
- Not automatically covered: airfare, visas, travel insurance, accommodation, meals, transport, extra testing, additional procedures, complication treatment or revision, home aftercare.
- Bruising typically lasts about two weeks.
- The page notes the surgeon's licence and the clinic's accreditation were not independently verified.

</details>

## 3. Full Mouth Restoration in Bogota, Colombia: Costs & Safety

- **Source URL:** https://www.placidway.com/article/4617/Why-Canadians-Are-Choosing-Full-Mouth-Restoration-in-Colombia-Over-the-USA-or-Mexico
- **Content type:** article
- **Featured image:** [og:image, 1200×630](https://www.placidway.com/cdn-cgi/image/quality=85,fit=pad,width=1200,height=630/https://placidwaycdn.s3.amazonaws.com/images/article_thumb/1790689111Full-mouth-restoration-in-Bogota,-Colombia-(2).jpg)
- **Selected:** variant 1 (“cost comparison”), 359 characters before the link (limit 500)

```text
Why are Canadians looking at Bogota for full mouth restoration?

Full mouth implants are listed at $10,000-$16,000 in Bogota vs $35,000-$60,000 in the US/Canada.
Treatment usually takes two trips, with 3-6 months of healing at home in between.
Check MinSalud licensing and ReTHUS registration, and ask for a 3D CBCT scan.

Read the full cost and safety guide.

👉 https://www.placidway.com/article/4617/Why-Canadians-Are-Choosing-Full-Mouth-Restoration-in-Colombia-Over-the-USA-or-Mexico

#DentalTourism #Bogota #FullMouthRestoration #DentalImplants
General information only, not medical advice.
```

| Variant | Angle | Chars before link | Layer-1 rules | Findings |
|---|---|---|---|---|
| 1 | cost comparison | 359 | ✅ pass | — |
| 2 | too salesy | 124 | ❌ blocked | ❌ outcome_promise: "guaranteed" (guarantee)<br>❌ outcome_promise: "zero risk" (risk-free)<br>❌ outcome_promise: "Permanent results" (permanent results)<br>❌ unverifiable_superlative: "Cheapest" (superlative)<br>❌ pressure: "Act now" (pressure)<br>⚠️ evidence_missing: model cited no evidence |
| 3 | timeline | 263 | ✅ pass | — |

<details><summary>Facts captured from the page (grounding set)</summary>

- Page heading: Why Canadians Are Choosing Full Mouth Restoration in Colombia Over the USA or Mexico
- Full mouth restoration often uses implants, bridges or crowns.
- Complete upper and lower jaw rehabilitation in Bogota is about $8,000-$16,000 USD.
- Single jaw All-on-4 (acrylic): $4,500-$6,500 in Bogota versus $15,000-$24,000 in the US/Canada.
- Full mouth implants (upper and lower): $10,000-$16,000 in Bogota versus $35,000-$60,000 in the US/Canada.
- The article cites savings of 50-70% abroad.
- Credentials to check: MinSalud licensing, ReTHUS registration and FOC membership.
- Treatment follows a two-trip timeline: an initial surgical stay of 7-10 days, 3-6 months of healing at home, then a restoration visit of 7-14 days.
- Patients are advised to request a 3D CBCT scan during the first consultation.
- Recommended dental checkups every 6 months; permanent prostheses typically last 10-15 years.

</details>

## 4. Hair Transplant in Turkey vs the UK: Hidden Costs Checked Line by Line

- **Source URL:** https://www.placidway.com/article/9809/Hair-Transplant-in-Turkey-vs-the-UK-Hidden-Costs-Checked-Line-by-Line
- **Content type:** article
- **Featured image:** [og:image, 1200×630](https://www.placidway.com/cdn-cgi/image/quality=85,fit=pad,width=1200,height=630/https://placidwaycdn.s3.amazonaws.com/images/article_thumb/1792685940Hair-transplant-in-Turkey-vs.-the-UK-(2).jpg)
- **Selected:** variant 1 (“hidden costs”), 388 characters before the link (limit 500)

```text
Is a hair transplant in Turkey really cheaper than in the UK?

UK private quotes of £8,000 to £15,000 are common; Istanbul packages run about $1,500-$3,500.
Turkish packages often bundle hotel, transfers and aftercare, but flights are almost never included.
Add flights, specialist travel insurance and time off before you compare.

See the line-by-line checklist and 10 questions to ask.

👉 https://www.placidway.com/article/9809/Hair-Transplant-in-Turkey-vs-the-UK-Hidden-Costs-Checked-Line-by-Line

#HairTransplant #Turkey #MedicalTourism #HairLoss
General information only, not medical advice.
```

| Variant | Angle | Chars before link | Layer-1 rules | Findings |
|---|---|---|---|---|
| 1 | hidden costs | 388 | ✅ pass | — |
| 2 | too salesy | 155 | ❌ blocked | ❌ outcome_promise: "guaranteed" (guarantee)<br>❌ medical_claim: "Cure" (cure)<br>❌ outcome_promise: "Painless" (painless)<br>❌ outcome_promise: "no downtime" (no side effects)<br>❌ unverifiable_superlative: "best" (superlative)<br>❌ pressure: "Book now" (pressure)<br>❌ ungrounded_number: not found in source: 80, 3<br>⚠️ evidence_missing: model cited no evidence<br>⚠️ unverified_names: FUE |
| 3 | questions to ask | 270 | ✅ pass | — |

<details><summary>Facts captured from the page (grounding set)</summary>

- UK private hair transplant quotes of £8,000 to £15,000 are common at established clinics.
- Istanbul packages are about $1,500-$3,500 (roughly £1,150-£2,750).
- Turkish packages often include hotel nights, airport transfers, a translator, pre-op blood tests, an aftercare kit and a first wash; flights are almost never included.
- UK quotes may charge separately for the consultation, extra grafts, PRP, medication and later reviews.
- Costs of going abroad include return flights of about £120-£400 from UK airports, specialist travel insurance, a companion, extra nights and currency risk.
- The GHIC does not work in Turkey because it is not in the EU.
- Desk workers often return to work after about 7-10 days.
- Growth takes about a year to judge; most surgeons judge the final result at 12-18 months.
- The article lists ten questions to ask, including every included and excluded item, whether the graft count is fixed, who the surgeon is, and follow-up in the UK.
- The article says no clinic can guarantee a result and that 'all-inclusive' is a marketing term, not a legal one.

</details>

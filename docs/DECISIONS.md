# Design decisions and trade-offs

Short, decision-record style notes: what was chosen, what else was considered, and why. These are the points I expect to discuss in the walkthrough.

## D1. n8n (self-hosted) over Make.com
**Chosen:** n8n 2.x in Docker with Postgres.
**Why:** Code nodes let the logic that matters (extraction, guardrails, selection) be real, unit-tested code instead of long expression chains; Wait-node webhooks give a native "pause until a human clicks" approval flow; the workflow is a JSON file that can be diffed, reviewed and rebuilt from source; self-hosting keeps API keys and the content log in our own database, and has no per-operation pricing (a daily run is ~25 operations, Make would charge per module run).
**Trade-off:** we own hosting/upgrades. Mitigated by a pinned version, a one-command bootstrap and a compose file that also runs the recommended external task runner.

## D2. Listing pages as the "feed", not sitemap/RSS/headless
**Chosen:** robots.txt → 3 listing pages ordered by modified date → 1–2 detail pages, plain HTTP + parsing.
**Alternatives:** RSS (none for this content), sitemaps (HTML, 1,000+ rows, no dates), headless browser (pages are server-rendered; 10× heavier and more load on the site).
**Why:** cheapest correct signal of "what is new", ~6 requests/day, easy to keep under 1 req/s.
**Risk:** markup/URL changes. Mitigated by URL-pattern matching (not CSS classes), Open Graph as primary data source, and loud `PARSER_BROKEN` / `NO_VALID_CONTENT` failures.

## D3. Content key from the URL id, atomic claim in Postgres
**Chosen:** `content_key = type:id` (e.g. `package:6950`) + `UNIQUE(url)`; claim with `INSERT … ON CONFLICT DO UPDATE … WHERE status='failed' AND attempts < max`.
**Why:** the brief's hard rule is "never post the same URL twice". Slugs change, PlacidWay canonicalises some packages to `gangnam.placidway.com`, and two runs can overlap (manual + schedule). The id survives all of that, and the claim makes "check then post" a single atomic step.
**Alternatives:** n8n workflow static data (not persisted for manual runs, invisible, no concurrency control), Google Sheets (no atomic upsert, rate limits), n8n Data Tables (simple, but no conditional upsert and harder to query for a dashboard).

## D4. LLM writes parts, code assembles the post
**Why:** "hook, 2–4 lines, CTA, link, 3–5 hashtags, < 500 chars before the link" is a *format contract*. Asking the model to also format and count characters makes the contract probabilistic. Structured JSON + deterministic assembly makes it exact, and lets the rules check each part separately.

## D5. Best-of-3 variants instead of generate → check → regenerate loop
**Why:** one generation call + one judge call is predictable in cost and latency (~2 LLM calls/day), avoids loop control flow in n8n (harder to read and to reason about paired items), and still gives a fallback when one variant fails. The cost of the extra variants is a few hundred tokens.
**Trade-off:** if all three fail, the item is blocked instead of repaired. Acceptable: a blocked item is a signal worth a human look, and the retry slot picks another item the same day.

## D6. Two-layer guardrails, fail-closed
**Layer 1 (rules):** deterministic, explainable, cheap; the hard guarantees (no invented numbers/prices, no banned claim words, no credentials not in the source, format).
**Layer 2 (judge):** semantic: paraphrased medical claims, unsupported facts that contain no numbers, implied promises.
**Why both:** rules alone miss meaning; a judge alone is probabilistic and can be argued with by the generator's wording. The rules also make the judge's job smaller (only rule-passing drafts are judged).
**Fail-closed:** judge unavailable/unparseable → no publish (blocked), LLM outage → failed and retried later, never "publish anyway".
**Known limitation:** grounding is lexical for numbers and semantic (LLM) for everything else; approval mode is the human backstop and is recommended for the first weeks.

## D7. Approval through signed links + Wait node
**Chosen:** Telegram message with Approve/Reject links → n8n Wait node (`resume on webhook`).
**Why:** native n8n, no extra bot server, works from any phone, the execution keeps all context (no re-generation after approval), channel-agnostic (the same links can go to email/Slack).
**Hardening:** n8n-signed resume URL + per-draft random token; `ignoreBots` so Telegram's link-preview crawler cannot approve (verified in the e2e test); timeout → `review_expired`.
**Trade-off:** n8n must be reachable at `WEBHOOK_URL` from the reviewer's phone.

## D8. Retries chosen per operation
Idempotent GETs and LLM calls: node retries. Dead detail pages: candidate fallback instead of retries. Facebook POST: **no automatic retry** (not idempotent; a timeout after a successful create would double-post). Whole-run outages: 11:00/14:00 retry slots guarded by "posted today?". Items: attempts budget.

## D9. One outcome tail for every path
Every terminal state builds an Outcome object → finalize DB → notify → re-raise if failed. Logging and alerting become structural rather than something each branch must remember. The workflow is also its own Error Workflow for crashes outside handled paths, and handled errors are tagged `[HANDLED]` so they are not alerted twice.

## D10. Secrets only in n8n credentials
API keys/tokens are never in `.env`, workflow JSON, run logs or Telegram messages. `bootstrap.sh` passes them only to the one-off `import:credentials` command; n8n stores them encrypted with `N8N_ENCRYPTION_KEY`. Run configuration (`PW_*`) is non-secret and lives in the environment so the same workflow file runs in dry-run, staging or live mode without edits.

## D11. Images
Use the page's `og:image` (already curated for social), normalised to the site's own 1200×630 rendition, logos/SVG/generic banners rejected. Photo post for reach; automatic link-post fallback if Facebook cannot fetch/process the image. AI image generation when no image exists was deliberately skipped: for a medical brand, a generated "clinic" or "patient" image is a misrepresentation risk; the link preview is the honest fallback.

## Cost and load (per day, defaults)
| Resource | Usage |
|---|---|
| PlacidWay requests | 6 (robots + 3 listings + ≤ 2 detail pages), ≥ 1.5 s apart |
| LLM calls | 2 (≈ 3–5k tokens total with `gpt-4.1-mini`: a fraction of a cent) |
| Graph API calls | 3–4 (preflight, publish, permalink, optional IG) + 2 per post every 6 h for engagement |
| n8n executions | 3 schedule slots (2 exit immediately once posted) + 4 engagement syncs |

# Testing

Three layers, from fast to realistic. All results below are from the final build of this repository.

## 1. Unit tests (29) and SQL tests (8): `npm test`

No network, no n8n, ~1 s. Requires Node ≥ 20 (`npm install` once for PGlite).

- **Unit** (`test/lib.test.js`): config validation, RFC 9309 robots semantics, URL parsing *with the `URL` global removed* (n8n's Code sandbox does not provide it), listing parsing (pattern-based, nav ignored, dedupe), category classification, selection (rotation, cooldown, retry budget, robots), extraction from fixtures (Open Graph, product price meta, JSON-LD, **sidebar prices excluded from facts**, 404/thin pages), image normalisation, every guardrail rule (claims, invented prices/numbers, credentials, structure, length, evidence), the rules + judge decision (fail-closed), prompt shapes, DST-aware scheduling, publish plans (photo/link/schedule/Instagram), Graph API error classification (by code, including n8n-wrapped errors), outcomes and failure classification.
- **SQL** (`test/sql.test.js`): the real schema and every workflow query on an in-process Postgres (PGlite): idempotent schema, atomic claim under contention, retry budget, approval states, finalize by execution id, late failures cannot overwrite a published post, dry-run isolation, engagement snapshots, dashboard aggregate.

```
$ npm test
# tests 37
# pass 37
# fail 0
```

## 2. End-to-end (15 scenarios): `npm run test:e2e`

The **committed workflow JSON** imported into a real **n8n 2.45.5** (Postgres-backed, JS task runner), executed through the n8n CLI, with every external system replaced by `test/e2e/mock-server.js` (PlacidWay pages from fixtures, OpenAI-compatible LLM, Facebook Graph API, Telegram Bot API; failure modes switchable at runtime). Assertions read Postgres and the mock's recorded requests.

```
PASS   15.9s  dry run: robots + 3 listings + fallback past a 404 detail page, ≥1 s between requests, simulated post
PASS   15.7s  live auto-publish: photo post with image, permalink stored
PASS   15.8s  never posts the same URL twice: second run picks a different item
PASS   15.5s  Facebook rejects the image -> automatic link-post fallback
PASS   21.0s  Instagram cross-post from the same pipeline (container -> publish), JPEG image
PASS   15.5s  scheduled publishing: published=false + scheduled_publish_time at next 18:00 local
PASS   15.0s  guardrails: judge finds unsupported claims -> blocked, nothing published, alert sent
PASS    6.7s  site down (robots.txt 503) -> SITE_DOWN alert, run marked failed
PASS   10.0s  expired Facebook token -> caught by preflight before any content is claimed
PASS   25.3s  LLM auth error (401, retried 3x) -> LLM_AUTH alert; item released for retry
PASS   15.0s  LLM returns non-JSON -> LLM_BAD_OUTPUT alert
PASS   20.6s  approval mode: link previews (bots) cannot approve; reviewer approval publishes
PASS   17.2s  approval mode: reviewer rejects -> nothing published
PASS   21.3s  engagement sync stores reactions/comments/shares/clicks + snapshot
PASS    0.2s  dashboard webhook renders HTML with posts and run log

15/15 scenarios passed
```

Measured request spacing to the (mock) site in the dry-run scenario: robots → +1.7 s → +1.5 s → +1.5 s → +1.8 s → +1.5 s, all with the configured User-Agent.

### Running the e2e suite yourself
1. Postgres with two databases (`n8n`, `placidway`) and `db/init/01-schema.sql` applied to `placidway`.
2. `node test/e2e/mock-server.js` (port 8787).
3. n8n 2.x with these environment variables (plus the usual `DB_*` for its own database):
   ```
   PW_BASE_URL=http://127.0.0.1:8787  PW_LLM_BASE_URL=http://127.0.0.1:8787/v1  PW_FB_GRAPH_BASE=http://127.0.0.1:8787/v23.0
   TELEGRAM_API_BASE_URL=http://127.0.0.1:8787  PW_TELEGRAM_CHAT_ID=4242  N8N_BLOCK_ENV_ACCESS_IN_NODE=false
   PW_DB_HOST=… PW_DB_USER=… PW_DB_PASSWORD=…  LLM_API_KEY=x FB_PAGE_ACCESS_TOKEN=x TELEGRAM_BOT_TOKEN=x
   ```
4. `node scripts/credentials-from-env.js > creds.json && n8n import:credentials --input=creds.json && n8n import:workflow --separate --input=workflows`
5. `n8n start` (needed to resume approval waits), then in a second shell with the same env plus `N8N_RUNNERS_BROKER_PORT=5689 N8N_PORT=5699`:
   `N8N_CLI=n8n PW_DB_*=… DASHBOARD_URL=http://127.0.0.1:5678/webhook/placidway-dashboard npm run test:e2e`

`PW_FB_GRAPH_BASE` exists only to point the workflow at a mock; leave it unset in real deployments.

## 3. Live checks with real services

- `npm run samples:live` runs the same pipeline code (robots → fetch → extract → LLM variants → rules → judge) against live PlacidWay pages from the command line, without n8n or Facebook, and writes `samples/live/*.json`. Useful for prompt iteration with your own model.
- Live Facebook posting is shown in the screen recording (test Page, `PW_DRY_RUN=false`).

## Bugs the tests caught during development
- n8n's Code-node sandbox has **no `URL` global**: URL handling silently returned `null` inside n8n while working in Node. Replaced with a small, tested parser.
- `$('Node').first()` resolves to the output branch that connects to the current node; on error branches that is the empty error output. All references now use `.first(0)` explicitly.
- Facebook returns `type: "OAuthException"` for many errors that are not token problems (e.g. `#324` image errors). Classification now uses the error code first.
- `isbot` treats a bare `Mozilla/5.0` user agent as a bot; approval links must be opened from a real browser (Telegram's in-app browser is fine).

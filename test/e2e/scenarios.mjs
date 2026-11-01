#!/usr/bin/env node
/**
 * End-to-end scenarios: runs the REAL exported workflows inside a real n8n instance against
 * test/e2e/mock-server.js (PlacidWay + LLM + Facebook Graph + Telegram) and a real Postgres.
 *
 * Prerequisites (see docs/TESTING.md):
 *   - Postgres with db/init/01-schema.sql applied        -> PW_DB_* env vars
 *   - mock server running:  node test/e2e/mock-server.js  -> http://127.0.0.1:8787
 *   - n8n with credentials + workflows imported, and `n8n start` running (needed for approval resumes)
 *   - N8N_CLI: command used to execute a workflow, e.g. "n8n" (second process: set N8N_RUNNERS_BROKER_PORT/N8N_PORT)
 *   - n8n env pointing PW_BASE_URL / PW_LLM_BASE_URL / PW_FB_GRAPH_BASE / TELEGRAM_API_BASE_URL at the mock
 */
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const pg = require(process.env.PG_MODULE || 'pg'); // dev dependency
const MOCK = process.env.MOCK_URL || 'http://127.0.0.1:8787';
const N8N_CLI = (process.env.N8N_CLI || 'n8n').split(' ');
const DAILY = 'pwDailyPost00001';
const ENGAGEMENT = 'pwEngagement0001';
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

const db = new pg.Client({
  host: process.env.PW_DB_HOST || '127.0.0.1', port: Number(process.env.PW_DB_PORT || 5432),
  user: process.env.PW_DB_USER, password: process.env.PW_DB_PASSWORD, database: process.env.PW_DB_NAME || 'placidway',
});
await db.connect();
const rows = async (sql) => (await db.query(sql)).rows;
const mock = async (path, body) => (await fetch(`${MOCK}${path}`, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json', connection: 'close' }, body: body ? JSON.stringify(body) : undefined })).json();

async function reset(mode = {}) {
  await db.query('TRUNCATE pw_engagement_snapshots, pw_posts, pw_run_log RESTART IDENTITY CASCADE');
  await mock('/__mock/reset', {});
  await mock('/__mock/mode', mode);
}

function execute(id, env = {}) {
  try {
    execFileSync(N8N_CLI[0], [...N8N_CLI.slice(1), 'execute', `--id=${id}`, '--rawOutput'], {
      env: { ...process.env, PW_DRY_RUN: 'true', PW_REVIEW_MODE: 'auto', PW_PUBLISH_STRATEGY: 'now', ...env },
      stdio: 'pipe', timeout: 180000,
    });
  } catch (e) { /* handled failures intentionally end the execution with an error */ }
}

const live = { PW_DRY_RUN: 'false', PW_FB_PAGE_ID: '123456' };
const results = [];
async function scenario(name, fn) {
  if (process.env.ONLY && !name.includes(process.env.ONLY)) return;
  const t = Date.now();
  try { await fn(); results.push([name, 'PASS', Date.now() - t]); console.log(`✔ ${name}`); }
  catch (e) { results.push([name, "FAIL", Date.now() - t]); console.log(`✘ ${name}\n  ${e.message}\n${(e.cause && e.cause.message) || ""}\n${String(e.stack).split("\n").slice(1, 4).join("\n")}`); }
}
const run = async () => (await rows('SELECT * FROM pw_run_log ORDER BY id DESC LIMIT 1'))[0];
const post = async () => (await rows('SELECT * FROM pw_posts ORDER BY id DESC LIMIT 1'))[0];

await scenario('dry run: robots + 3 listings + fallback past a 404 detail page, ≥1 s between requests, simulated post', async () => {
  await reset();
  execute(DAILY);
  const r = await run();
  assert.equal(r.status, 'dry_run');
  assert.equal(r.content_key, 'answer:29');
  const s = await mock('/__mock/state');
  const site = s.requests.filter((q) => !/^\/(v1|v23|bot|__)/.test(q.path));
  assert.equal(site[0].path, '/robots.txt');
  assert.equal(site.length, 6);
  for (let i = 1; i < site.length; i++) assert.ok(site[i].t - site[i - 1].t >= 1000, `requests ${i - 1}->${i} only ${site[i].t - site[i - 1].t}ms apart`);
  assert.ok(site.every((q) => /PlacidWayContentDemoBot/.test(q.ua)));
  assert.equal(s.fbPosts.length, 0);
  assert.match(s.telegram[0].text, /post generated/);
  const p = await post();
  assert.ok(p.post_text.indexOf('👉') > 0);
  assert.equal(p.guardrail_report.variants[0].rules_passed, false, 'the deliberately bad variant is rejected by the rules');
});

await scenario('live auto-publish: photo post with image, permalink stored', async () => {
  await reset();
  execute(DAILY, live);
  const r = await run();
  assert.equal(r.status, 'published');
  const s = await mock('/__mock/state');
  assert.equal(s.fbPosts[0].edge, 'photos');
  assert.match(s.fbPosts[0].body.url, /cdn-cgi\/image\/.*1200,height=630/);
  assert.equal((await post()).fb_permalink, 'https://www.facebook.com/123456_700001');
});

await scenario('never posts the same URL twice: second run picks a different item', async () => {
  execute(DAILY, live);
  const keys = (await rows("SELECT content_key FROM pw_posts WHERE status='published'")).map((x) => x.content_key);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
});

await scenario('Facebook rejects the image -> automatic link-post fallback', async () => {
  await reset({ fb: 'image_error' });
  execute(DAILY, live);
  assert.equal((await run()).status, 'published');
  assert.equal((await mock('/__mock/state')).fbPosts[0].edge, 'feed');
});

await scenario('Instagram cross-post from the same pipeline (container -> publish), JPEG image', async () => {
  await reset();
  execute(DAILY, { ...live, PW_IG_USER_ID: '1784' });
  assert.equal((await run()).status, 'published');
  const s = await mock('/__mock/state');
  assert.deepEqual(s.igPosts.map((x) => x.step), ['container', 'publish']);
  assert.match(s.igPosts[0].body.image_url, /format=jpeg/);
  assert.equal(s.igPosts[1].body.creation_id, 'ig_container_1');
  assert.match(s.telegram[0].text, /Instagram:<\/b> published/);
});

await scenario('scheduled publishing: published=false + scheduled_publish_time at next 18:00 local', async () => {
  await reset();
  execute(DAILY, { ...live, PW_PUBLISH_STRATEGY: 'schedule', PW_SCHEDULE_TIME: '18:00' });
  assert.equal((await run()).status, 'scheduled');
  const b = (await mock('/__mock/state')).fbPosts[0].body;
  assert.equal(b.published, false);
  assert.ok(b.scheduled_publish_time * 1000 > Date.now() + 10 * 60000);
});

await scenario('guardrails: judge finds unsupported claims -> blocked, nothing published, alert sent', async () => {
  await reset({ judge: 'fail' });
  execute(DAILY, live);
  assert.equal((await run()).status, 'blocked');
  assert.equal((await post()).status, 'blocked');
  const s = await mock('/__mock/state');
  assert.equal(s.fbPosts.length, 0);
  assert.match(s.telegram[0].text, /blocked by guardrails/);
});

await scenario('site down (robots.txt 503) -> SITE_DOWN alert, run marked failed', async () => {
  await reset({ site: 'down' });
  execute(DAILY, live);
  const r = await run();
  assert.equal(r.status, 'failed');
  assert.equal(r.error_code, 'SITE_DOWN');
  assert.match((await mock('/__mock/state')).telegram[0].text, /FAILED/);
});

await scenario('expired Facebook token -> caught by preflight before any content is claimed', async () => {
  await reset({ fb: 'token_expired' });
  execute(DAILY, live);
  const r = await run();
  assert.equal(r.error_code, 'FB_TOKEN_EXPIRED');
  assert.equal((await rows('SELECT count(*)::int n FROM pw_posts'))[0].n, 0);
});

await scenario('LLM auth error (401, retried 3x) -> LLM_AUTH alert; item released for retry', async () => {
  await reset({ llm: 'fail401' });
  execute(DAILY);
  assert.equal((await run()).error_code, 'LLM_AUTH');
  assert.equal((await post()).status, 'failed');
});

await scenario('LLM returns non-JSON -> LLM_BAD_OUTPUT alert', async () => {
  await reset({ llm: 'garbage' });
  execute(DAILY);
  assert.equal((await run()).error_code, 'LLM_BAD_OUTPUT');
});

async function click(url, ua) {
  // the browser click; retried once because the paused execution may still be persisting
  for (let i = 0; i < 3; i++) {
    try { return await fetch(url, { headers: { 'user-agent': ua } }); } catch (e) { await new Promise((r) => setTimeout(r, 2000)); }
  }
  throw new Error(`could not reach ${url}`);
}

async function approvalLink(kind) {
  // search every message: a late notification from the previous scenario may arrive after reset()
  for (let i = 0; i < 10; i++) {
    const s = await mock('/__mock/state');
    for (const t of s.telegram) {
      const m = t.text.match(new RegExp(`href="([^"]+decision=${kind}[^"]+)"`));
      if (m) return m[1].replace(/&amp;/g, '&');
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('no review message with approval links was sent');
}

await scenario('approval mode: link previews (bots) cannot approve; reviewer approval publishes', async () => {
  await reset();
  execute(DAILY, { ...live, PW_REVIEW_MODE: 'approval' });
  assert.equal((await post()).status, 'pending_review');
  const url = await approvalLink('approve');
  await click(url, 'TelegramBot (like TwitterBot)');
  await new Promise((r) => setTimeout(r, 3000));
  assert.equal((await post()).status, 'pending_review', 'bot request must not resume the execution');
  await click(url, BROWSER_UA);
  for (let i = 0; i < 20 && (await post()).status !== 'published'; i++) await new Promise((r) => setTimeout(r, 1000));
  assert.equal((await post()).status, 'published');
  for (let i = 0; i < 10 && (await mock('/__mock/state')).telegram.length < 2; i++) await new Promise((r) => setTimeout(r, 1000));
});

await scenario('approval mode: reviewer rejects -> nothing published', async () => {
  await reset();
  execute(DAILY, { ...live, PW_REVIEW_MODE: 'approval' });
  await click(await approvalLink('reject'), BROWSER_UA);
  for (let i = 0; i < 20 && (await post()).status !== 'rejected'; i++) await new Promise((r) => setTimeout(r, 1000));
  assert.equal((await post()).status, 'rejected');
  assert.equal((await mock('/__mock/state')).fbPosts.length, 0);
});

await scenario('engagement sync stores reactions/comments/shares/clicks + snapshot', async () => {
  await reset();
  execute(DAILY, live);
  execute(ENGAGEMENT, live);
  const p = await post();
  assert.deepEqual([p.reactions, p.comments, p.shares, p.clicks], [12, 3, 2, 7]);
  assert.equal((await rows('SELECT count(*)::int n FROM pw_engagement_snapshots'))[0].n, 1);
});

if (process.env.DASHBOARD_URL) {
  await scenario('dashboard webhook renders HTML with posts and run log', async () => {
    const res = await fetch(process.env.DASHBOARD_URL, { headers: { connection: 'close' } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /PlacidWay → Facebook autopost/);
    assert.match(html, /Run log/);
  });
}

await db.end();
console.log('\n' + results.map(([n, s, ms]) => `${s}  ${(ms / 1000).toFixed(1).padStart(5)}s  ${n}`).join('\n'));
const failed = results.filter((r) => r[1] === 'FAIL').length;
console.log(`\n${results.length - failed}/${results.length} scenarios passed`);
process.exit(failed ? 1 : 0);

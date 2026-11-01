'use strict';
/** Runs the real schema and every workflow query against an in-process Postgres (PGlite). */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const Q = require('../src/sql/queries');
const { toB64Json } = require('../src/lib/util');

let db;
const q = async (sql, obj) => (await db.query(sql, obj === undefined ? [] : [toB64Json(obj)])).rows;

test.before(async () => {
  const { PGlite } = await import('@electric-sql/pglite');
  db = new PGlite();
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'init', '01-schema.sql'), 'utf8'));
  // schema must be idempotent
  await db.exec(fs.readFileSync(path.join(__dirname, '..', 'db', 'init', '01-schema.sql'), 'utf8'));
});

const runStart = (id) => q(Q.RUN_START, {
  execution_id: id, trigger_mode: 'manual', review_mode: 'auto', dry_run: false, timezone: 'America/Denver',
  counted_statuses: ['published', 'scheduled', 'pending_review', 'approved'], config: { a: 1 },
});
const claim = (id, key, extra = {}) => q(Q.CLAIM, {
  execution_id: id, content_key: key, url: `https://www.placidway.com/${key.replace(':', '/')}/x`, type: key.split(':')[0],
  category: 'dental', title: 'T, with "quotes" & emoji 👉', summary: 's', image_url: null, selection_reason: 'r',
  source: { len: 1 }, selection: { s: 1 }, max_attempts: 3, dry_run: false, ...extra,
});
const finalize = (obj) => q(Q.FINALIZE, obj);

test('run start logs the run and counts today\'s posts', async () => {
  const [r] = await runStart('e1');
  assert.ok(r.run_id);
  assert.equal(r.posts_today, 0);
  const [again] = await runStart('e1');
  assert.equal(again.run_id, r.run_id, 'idempotent per execution');
});

test('claim is atomic: a second claim of the same item returns null', async () => {
  const [c1] = await claim('e1', 'article:1');
  assert.ok(c1.post_id);
  assert.equal(c1.logged, 1);
  await runStart('e2');
  const [c2] = await claim('e2', 'article:1');
  assert.equal(c2.post_id, null);
  const [title] = (await db.query("SELECT title FROM pw_posts WHERE content_key='article:1'")).rows;
  assert.equal(title.title, 'T, with "quotes" & emoji 👉');
});

test('finalize success publishes and the item is counted for today', async () => {
  const [f] = await finalize({ execution_id: 'e1', run_status: 'published', post_status: 'published', post_id: null,
    post_text: 'hello', fb_post_id: '1_2', fb_permalink: 'https://facebook.com/1_2', details: { guardrails: { reason: 'ok' } } });
  assert.deepEqual(f, { runs_updated: 1, posts_updated: 1 });
  const [row] = (await db.query("SELECT status, fb_post_id, published_at, guardrail_report FROM pw_posts WHERE content_key='article:1'")).rows;
  assert.equal(row.status, 'published');
  assert.ok(row.published_at);
  assert.equal(row.guardrail_report.reason, 'ok');
  const [log] = (await db.query("SELECT status, duration_ms, content_key FROM pw_run_log WHERE execution_id='e1'")).rows;
  assert.equal(log.status, 'published');
  assert.equal(log.content_key, 'article:1');
  assert.ok(log.duration_ms >= 0);
  const [r] = await runStart('e3');
  assert.equal(r.posts_today, 1);
});

test('published items can never be re-claimed; failed ones retry until max_attempts', async () => {
  const [again] = await claim('e3', 'article:1');
  assert.equal(again.post_id, null);
  // a failing item
  const [c] = await claim('e3', 'package:7');
  await finalize({ execution_id: 'e3', run_status: 'failed', post_status: 'failed', post_id: c.post_id, error_code: 'FB_UNAVAILABLE', error_message: 'boom' });
  await runStart('e4');
  const [c2] = await claim('e4', 'package:7');
  assert.equal(c2.post_id, c.post_id);
  assert.equal(c2.attempt, 2);
  await finalize({ execution_id: 'e4', run_status: 'failed', post_status: 'failed', post_id: c.post_id, error_message: 'boom' });
  await runStart('e5');
  const [c3] = await claim('e5', 'package:7');
  assert.equal(c3.attempt, 3);
  await finalize({ execution_id: 'e5', run_status: 'failed', post_status: 'failed', post_id: c.post_id, error_message: 'boom' });
  const [c4] = await claim('e6', 'package:7');
  assert.equal(c4.post_id, null, 'gives up after max_attempts');
});

test('approval flow: draft -> approved -> scheduled', async () => {
  await runStart('e7');
  const [c] = await claim('e7', 'answer:29');
  const [d] = await q(Q.SAVE_DRAFT, { execution_id: 'e7', post_id: c.post_id, post_text: 'draft, text', angle: 'q', guardrails: { reason: 'x' }, review_token: 'tok', llm_usage: { total_tokens: 10 } });
  assert.equal(d.post_id, c.post_id);
  const [rt] = (await db.query("SELECT status FROM pw_run_log WHERE execution_id='e7'")).rows;
  assert.equal(rt.status, 'pending_review');
  const [a] = await q(Q.MARK_APPROVED, { post_id: c.post_id });
  assert.equal(a.post_id, c.post_id);
  await finalize({ execution_id: 'e7', run_status: 'scheduled', post_status: 'scheduled', post_id: c.post_id, fb_post_id: '9_9', scheduled_for: '2026-10-29T00:00:00Z' });
  const [row] = (await db.query("SELECT status, scheduled_for FROM pw_posts WHERE id=$1", [c.post_id])).rows;
  assert.equal(row.status, 'scheduled');
  assert.ok(row.scheduled_for);
});

test('finalize by execution id (error trigger path) and runs that failed before logging', async () => {
  await runStart('e8');
  await claim('e8', 'article:55');
  const [f] = await finalize({ execution_id: 'e8', run_status: 'failed', post_status: 'failed', post_id: null, error_code: 'UNEXPECTED', error_message: 'x' });
  assert.deepEqual(f, { runs_updated: 1, posts_updated: 1 });
  const [g] = await finalize({ execution_id: 'never-started', run_status: 'failed', post_status: 'failed', post_id: null, error_code: 'CONFIG_INVALID', error_message: 'x' });
  assert.deepEqual(g, { runs_updated: 1, posts_updated: 0 });
  // a terminal post is never overwritten by a late failure
  const [h] = await finalize({ execution_id: 'e1', run_status: 'failed', post_status: 'failed', post_id: null, error_message: 'late' });
  assert.equal(h.posts_updated, 0);
});

test('dry-run rows do not block live posting', async () => {
  await runStart('e9');
  const [c] = await claim('e9', 'article:77', { dry_run: true });
  await finalize({ execution_id: 'e9', run_status: 'dry_run', post_status: 'dry_run', post_id: c.post_id });
  const [stillDry] = await claim('e10', 'article:77', { dry_run: true });
  assert.equal(stillDry.post_id, null);
  const [live] = await claim('e10', 'article:77', { dry_run: false });
  assert.equal(live.post_id, c.post_id);
  assert.equal(live.attempt, 1);
});

test('history, engagement and dashboard queries', async () => {
  const [h] = (await db.query(Q.HISTORY)).rows;
  assert.ok(Array.isArray(h.history) && h.history.length >= 4);
  assert.ok(h.history[0].content_key);
  const targets = (await db.query(Q.ENGAGEMENT_TARGETS)).rows;
  assert.ok(targets.some((t) => t.fb_post_id === '1_2'));
  const pid = targets.find((t) => t.fb_post_id === '1_2').post_id;
  const [u] = await q(Q.ENGAGEMENT_SAVE, { post_id: pid, reactions: 5, comments: 2, shares: 1, clicks: 9, permalink: null, is_published: true });
  assert.equal(u.updated, 1);
  const snaps = (await db.query('SELECT count(*)::int AS n FROM pw_engagement_snapshots')).rows[0].n;
  assert.equal(snaps, 1);
  const [d] = (await db.query(Q.DASHBOARD)).rows;
  assert.equal(d.data.stats.published, 1);
  assert.equal(d.data.stats.reactions, 5);
  assert.ok(d.data.runs.length >= 5);
});

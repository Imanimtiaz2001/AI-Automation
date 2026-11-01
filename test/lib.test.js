'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const util = require('../src/lib/util');
const { buildConfig } = require('../src/lib/config');
const robots = require('../src/lib/robots');
const { parseListing } = require('../src/lib/listing');
const select = require('../src/lib/select');
const extract = require('../src/lib/extract');
const guard = require('../src/lib/guardrails');
const publish = require('../src/lib/publish');
const { buildOutcome, classifyFailure } = require('../src/lib/outcome');
const { buildGenerationRequest, buildJudgeRequest } = require('../src/lib/prompt');

const fx = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name), 'utf8');
const cfg = buildConfig({ PW_TELEGRAM_CHAT_ID: '123' });

// ---------------------------------------------------------------- util / config
test('normalizeUrl strips query, fragment, trailing slash and lowercases host', () => {
  assert.equal(util.normalizeUrl('HTTP://WWW.PlacidWay.com/article/1/Abc/?x=1#y'), 'https://www.placidway.com/article/1/Abc');
  assert.equal(util.normalizeUrl('/package/5/X', 'https://www.placidway.com/a'), 'https://www.placidway.com/package/5/X');
  assert.equal(util.normalizeUrl('javascript:alert(1)'), null);
});

test('contentKeyFromUrl is stable across slugs and subdomains, rejects other domains', () => {
  assert.equal(util.contentKeyFromUrl('https://www.placidway.com/package/6950/Facelift').key, 'package:6950');
  assert.equal(util.contentKeyFromUrl('https://gangnam.placidway.com/package/6950/Other-Slug').key, 'package:6950');
  assert.equal(util.contentKeyFromUrl('https://www.placidway.com/answer-detail/29/x').key, 'answer:29');
  assert.equal(util.contentKeyFromUrl('https://evil.com/article/1/x'), null);
  assert.equal(util.contentKeyFromUrl('https://www.placidway.com/about-us'), null);
});

test('parseUrl resolves like WHATWG URL, without needing the URL global (absent in n8n Code sandbox)', () => {
  const saved = globalThis.URL;
  try {
    globalThis.URL = undefined;
    const cases = [
      ['https://www.placidway.com/article/1/x?y=1#z', undefined],
      ['/package/5/Y', 'https://www.placidway.com/search-medical-packages/All/All/1'],
      ['../answer-detail/29/q', 'https://www.placidway.com/a/b/c'],
      ['//cdn.example.com/i.png', 'https://www.placidway.com/'],
      ['detail', 'http://127.0.0.1:8787/list/page'],
      ['HTTPS://WWW.PlacidWay.com:443/Path', undefined],
    ];
    const got = cases.map(([u, b]) => util.parseUrl(u, b).href);
    globalThis.URL = saved;
    assert.deepEqual(got, cases.map(([u, b]) => new URL(u, b).href));
    assert.equal(util.parseUrl('mailto:a@b.com'), null);
    assert.equal(util.parseUrl('relative/only'), null);
    globalThis.URL = undefined;
    assert.equal(util.normalizeUrl('/x/1/', 'http://127.0.0.1:8787/a'), 'http://127.0.0.1:8787/x/1');
    assert.equal(parseListing('<a href="/article/9/T">Some article title</a>', 'https://www.placidway.com/l', 'article')[0].content_key, 'article:9');
    assert.equal(robots.isAllowed(robots.parseRobots('User-agent: *\nDisallow: /a'), 'x', 'https://www.placidway.com/a/b'), false);
  } finally { globalThis.URL = saved; }
});

test('decodeEntities and htmlToText', () => {
  assert.equal(util.htmlToText('<p>Tom&rsquo;s &amp; <b>Jerry</b>&nbsp;&#36;5&#x2C;100</p>'), 'Tom’s & Jerry $5,100');
});

test('toB64Json round-trips unicode and commas', () => {
  const obj = { text: 'Hello, “world” 👉 $5,100' };
  assert.deepEqual(JSON.parse(Buffer.from(util.toB64Json(obj), 'base64').toString('utf8')), obj);
});

test('config: defaults are safe (dry run) and env is validated', () => {
  const c = buildConfig({});
  assert.equal(c.dry_run, true);
  assert.equal(c.review_mode, 'auto');
  assert.throws(() => buildConfig({ PW_REVIEW_MODE: 'approval' }), /PW_TELEGRAM_CHAT_ID is required/);
  assert.equal(buildConfig({ PW_REVIEW_MODE: 'approval', PW_TELEGRAM_CHAT_ID: '1' }).review_mode, 'approval');
  assert.throws(() => buildConfig({ PW_REVIEW_MODE: 'yolo' }), /CONFIG_INVALID/);
  assert.throws(() => buildConfig({ PW_DRY_RUN: 'false' }), /PW_FB_PAGE_ID is required/);
  const live = buildConfig({ PW_DRY_RUN: 'false', PW_FB_PAGE_ID: '42', PW_ROTATION: 'any,any,any,any,any,any,package' });
  assert.equal(live.fb_graph_base, 'https://graph.facebook.com/v23.0');
  assert.equal(live.rotation[6], 'package');
});

// ---------------------------------------------------------------- robots
test('robots: longest match wins, allow wins ties, wildcards and specific agents', () => {
  const parsed = robots.parseRobots(fx('robots.txt'));
  const ua = cfg.user_agent;
  assert.equal(robots.isAllowed(parsed, ua, 'https://www.placidway.com/article/1/x'), true);
  assert.equal(robots.isAllowed(parsed, ua, '/Medical-Tourism-Patients/Login'), false);
  assert.equal(robots.isAllowed(parsed, ua, '/search?search=knee'), false);
  assert.equal(robots.isAllowed(parsed, 'BadBot/2.0', '/article/1/x'), false);
  const p2 = robots.parseRobots('User-agent: *\nDisallow: /article/\nAllow: /article/9\n');
  assert.equal(robots.isAllowed(p2, ua, '/article/9809/x'), true);
  assert.equal(robots.isAllowed(p2, ua, '/article/1/x'), false);
});

test('robots: HTTP status semantics follow RFC 9309', () => {
  assert.equal(robots.robotsPolicyFromResponse(404, '').mode, 'allow_all');
  assert.equal(robots.robotsPolicyFromResponse(503, '').mode, 'disallow_all');
  const p = robots.robotsPolicyFromResponse(200, 'User-agent: *\nDisallow: /x\n');
  assert.equal(robots.policyAllows(p, 'bot', '/x/y'), false);
  assert.equal(robots.policyAllows(JSON.parse(JSON.stringify(p)), 'bot', '/y'), true, 'policy survives JSON serialisation between nodes');
});

// ---------------------------------------------------------------- listing & selection
test('parseListing: pattern-based, deduped, ordered, ignores nav and other types', () => {
  const items = parseListing(fx('listing-articles.html'), 'https://www.placidway.com/search-medical-articles/All/All/1', 'article');
  assert.deepEqual(items.map((i) => i.content_key), ['article:9809', 'article:4617', 'article:9808']);
  assert.equal(items[0].title_hint, 'Hair Transplant in Turkey vs the UK: Hidden Costs Checked Line by Line');
  assert.equal(items[1].url, 'https://www.placidway.com/article/4617/Why-Canadians-Are-Choosing-Full-Mouth-Restoration-in-Colombia-Over-the-USA-or-Mexico');
});

test('classifyCategory', () => {
  assert.equal(select.classifyCategory('Stem Cell Therapy for Knee Osteoarthritis'), 'stem-cell');
  assert.equal(select.classifyCategory('Heart Transplantation in Saudi Arabia'), 'transplant');
  assert.equal(select.classifyCategory('Hair-Transplant-in-Turkey-vs-the-UK'), 'hair');
  assert.equal(select.classifyCategory('Full-Mouth-Restoration-in-Colombia'), 'dental');
  assert.equal(select.classifyCategory('Facelift Package in Seoul'), 'cosmetic');
  assert.equal(select.classifyCategory('something else'), 'general');
});

test('selectCandidates: rotation, dedupe, retry rules, category variety', () => {
  const candidates = [
    { content_key: 'article:1', type: 'article', slug: 'Dental-Implants', title_hint: 'Dental implants', position: 0, url: 'u1' },
    { content_key: 'article:2', type: 'article', slug: 'Hair-Transplant-Turkey', title_hint: 'Hair', position: 1, url: 'u2' },
    { content_key: 'package:3', type: 'package', slug: 'Facelift-Seoul', title_hint: 'Facelift', position: 0, url: 'u3' },
    { content_key: 'answer:4', type: 'answer', slug: 'Shoulder-Cost', title_hint: 'Shoulder', position: 0, url: 'u4', robots_allowed: false },
  ];
  const history = [
    { content_key: 'article:9', status: 'published', category: 'dental', created_at: '2026-10-27' },
  ];
  // Monday => article preferred; dental was used last => hair article wins
  let r = select.selectCandidates({ candidates, history, cfg, weekdayIndex: 0, limit: 2 });
  assert.equal(r.selected[0].content_key, 'article:2');
  assert.equal(r.selected[1].content_key, 'article:1');
  assert.equal(r.rejected.robots, 1);
  // Tuesday => package preferred
  r = select.selectCandidates({ candidates, history, cfg, weekdayIndex: 1, limit: 1 });
  assert.equal(r.selected[0].content_key, 'package:3');
  // already published / blocked items are never selected again; failed ones are retried until max_attempts
  const h2 = [
    { content_key: 'article:1', status: 'published' },
    { content_key: 'article:2', status: 'failed', attempts: 1 },
    { content_key: 'package:3', status: 'failed', attempts: 3 },
  ];
  r = select.selectCandidates({ candidates, history: h2, cfg, weekdayIndex: 0, limit: 5 });
  assert.deepEqual(r.selected.map((s) => s.content_key), ['article:2']);
  assert.equal(r.rejected.already_used, 2);
});

test('isEligible: dry-run rows block re-use only while still in dry-run', () => {
  assert.equal(select.isEligible({ status: 'dry_run' }, { ...cfg, dry_run: true }), false);
  assert.equal(select.isEligible({ status: 'dry_run' }, { ...cfg, dry_run: false }), true);
  assert.equal(select.isEligible({ status: 'pending_review' }, cfg), false);
  assert.equal(select.isEligible({ status: 'blocked' }, cfg), false);
});

test('weekdayIndexFor respects timezone', () => {
  // 2026-10-26 03:00 UTC is still Sunday evening in Denver
  assert.equal(select.weekdayIndexFor('2026-10-26T03:00:00Z', 'America/Denver'), 6);
  assert.equal(select.weekdayIndexFor('2026-10-26T03:00:00Z', 'Asia/Karachi'), 0);
});

// ---------------------------------------------------------------- extraction
test('extractPage: package page uses og/meta, scopes body and excludes sidebar prices', () => {
  const c = extract.extractPage(fx('package-6950.html'), { url: 'https://www.placidway.com/package/6950/Facelift-Package-in-Seoul-South-Korea-by-VG-Plastic-Surgery', type: 'package' });
  assert.equal(c.content_key, 'package:6950');
  assert.equal(c.title, 'Facelift Package in Seoul, South Korea by VG Clinic');
  assert.match(c.image_url, /cdn-cgi\/image\/.*width=1200,height=630/);
  assert.deepEqual(c.price, { amount: 5100, currency: 'USD' });
  assert.match(c.body_text, /10–14 days in Seoul/);
  assert.match(c.body_text, /United States \| \$11,395/);
  assert.doesNotMatch(c.body_text, /2,900|1,700|cookies|All rights reserved/);
  assert.ok(c.source_numbers.includes('5100'));
  assert.ok(!c.source_numbers.includes('2900'));
  assert.deepEqual(extract.validateContent(c, { statusCode: 200, minBodyChars: 400 }), []);
});

test('extractPage: answer page and thin/404 page validation', () => {
  const c = extract.extractPage(fx('answer-29.html'), { url: 'https://www.placidway.com/answer-detail/29/How-Much', type: 'answer' });
  assert.equal(c.type, 'answer');
  assert.match(c.summary, /Guadalajara/);
  assert.match(c.body_text, /\$8,500 to \$11,500/);
  const thin = extract.extractPage(fx('thin-page.html'), { url: 'https://www.placidway.com/article/1/x', type: 'article' });
  const problems = extract.validateContent(thin, { statusCode: 404, minBodyChars: 400 });
  assert.ok(problems.includes('HTTP 404'));
  assert.ok(problems.some((p) => /body too short/.test(p)));
  assert.equal(thin.image_url, null);
});

test('facebookSizedImage rewrites raw S3 images to the 1200x630 rendition; rejects logos/svg', () => {
  assert.equal(
    extract.facebookSizedImage('https://placidwaycdn.s3.amazonaws.com/images/a.jpg', 'https://www.placidway.com'),
    'https://www.placidway.com/cdn-cgi/image/quality=85,fit=pad,width=1200,height=630/https://placidwaycdn.s3.amazonaws.com/images/a.jpg'
  );
  assert.equal(extract.isUsableImage('https://www.placidway.com/frontend/images/logo.svg'), false);
  assert.equal(extract.isUsableImage('http://x.com/a.jpg'), false);
});

test('llmContext truncates to budget', () => {
  const c = extract.extractPage(fx('package-6950.html'), { url: 'https://www.placidway.com/package/6950/x', type: 'package' });
  const ctx = extract.llmContext({ ...c, body_text: c.body_text.repeat(50) }, 3000);
  assert.ok(ctx.length < 3100);
  assert.match(ctx, /LISTED PRICE: from \$5,100/);
});

// ---------------------------------------------------------------- guardrails
const pkg = extract.extractPage(fx('package-6950.html'), { url: 'https://www.placidway.com/package/6950/Facelift-Package-in-Seoul-South-Korea-by-VG-Plastic-Surgery', type: 'package' });
const SOURCE = extract.llmContext(pkg, 7000);
const goodVariant = {
  angle: 'planning checklist',
  hook: 'Thinking about a facelift in Seoul? Here is what this package lists.',
  lines: [
    'Listed from $5,100 at VG Plastic Surgery in Gangnam.',
    'Inclusions cover consultation, anesthesia, preoperative tests and interpreter coordination.',
    'Plan for about 10–14 days in Seoul, subject to your surgeon\'s clearance to fly.',
  ],
  cta: 'Ask for the written list of inclusions before you book.',
  hashtags: ['#MedicalTourism', '#Seoul', '#FaceliftAbroad', '#PlacidWay'],
  evidence: ['starts at $5,100', 'Plan for about 10–14 days in Seoul'],
};

test('guardrails: a grounded, compliant post passes', () => {
  const post = guard.assemblePost(goodVariant, pkg, cfg);
  const r = guard.checkPost(post, SOURCE, cfg);
  assert.deepEqual(r.errors, []);
  assert.ok(post.chars_before_link < 500);
  assert.ok(post.text.indexOf(post.link) > post.text.indexOf(post.cta));
  assert.ok(post.text.endsWith(cfg.disclaimer));
});

function violations(patch) {
  const post = guard.assemblePost({ ...goodVariant, ...patch }, pkg, cfg);
  return guard.checkPost(post, SOURCE, cfg).errors.map((e) => e.rule);
}

test('guardrails: medical claims and outcome promises are blocked', () => {
  assert.ok(violations({ hook: 'A guaranteed younger look in Seoul!' }).includes('outcome_promise'));
  assert.ok(violations({ cta: 'You will look 10 years younger.' }).includes('outcome_promise'));
  assert.ok(violations({ hook: 'This facelift cures sagging skin.' }).includes('medical_claim'));
  assert.ok(violations({ hook: 'The safest facelift in Korea.' }).includes('outcome_promise'));
  assert.ok(violations({ hook: 'The best facelift clinic in Seoul.' }).includes('unverifiable_superlative'));
  assert.ok(violations({ hook: 'Painless recovery in Seoul.' }).includes('outcome_promise'));
  assert.ok(violations({ cta: 'Act now, limited time offer!' }).includes('pressure'));
});

test('guardrails: invented prices, numbers and credentials are blocked', () => {
  assert.ok(violations({ lines: ['Now only $3,999 in Seoul.', 'Includes interpreter coordination.'] }).includes('ungrounded_number'));
  assert.ok(violations({ lines: ['Save 70% compared with home.', 'Includes interpreter coordination.'] }).includes('ungrounded_number'));
  assert.ok(violations({ lines: ['Recovery takes just 5 days.', 'Includes interpreter coordination.'] }).includes('ungrounded_number'));
  assert.ok(violations({ lines: ['A JCI accredited clinic.', 'Includes interpreter coordination.'] }).includes('unsupported_credential'));
  // small counting words are style, not facts
  assert.deepEqual(violations({ hook: '3 questions to ask before a facelift in Seoul.' }), []);
});

test('guardrails: structure, length, hashtags, URLs, evidence', () => {
  assert.ok(violations({ lines: ['Only one line.'] }).includes('structure'));
  assert.ok(violations({ hashtags: ['#One', '#Two'] }).includes('hashtags'));
  assert.ok(violations({ hashtags: ['#One', '#Two', '#Bad Tag!', '#Four'] }).includes('hashtags'));
  assert.ok(violations({ hook: 'x'.repeat(150), lines: ['y'.repeat(130), 'z'.repeat(130), 'w'.repeat(130)] }).includes('length'));
  assert.ok(violations({ cta: 'Visit www.example.com now.' }).includes('structure'));
  assert.ok(violations({ evidence: ['totally made up quote about lasers'] }).includes('evidence_not_found'));
});

test('finalDecision: requires rules AND judge, picks best quality, fails closed', () => {
  const p1 = { ...guard.assemblePost(goodVariant, pkg, cfg), index: 1 };
  p1.rules = guard.checkPost(p1, SOURCE, cfg);
  const p2 = { ...guard.assemblePost({ ...goodVariant, angle: 'question' }, pkg, cfg), index: 2 };
  p2.rules = guard.checkPost(p2, SOURCE, cfg);
  const p3 = { ...guard.assemblePost({ ...goodVariant, hook: 'Guaranteed results!' }, pkg, cfg), index: 3 };
  p3.rules = guard.checkPost(p3, SOURCE, cfg);
  const judge = { results: [
    { variant: 1, verdict: 'pass', quality: 3, claims: [{ claim: 'from $5,100', supported: true }], violations: [] },
    { variant: 2, verdict: 'pass', quality: 5, claims: [{ claim: 'x', supported: true }], violations: [] },
    { variant: 3, verdict: 'fail', quality: 5, claims: [], violations: [{ type: 'outcome_promise' }] },
  ] };
  const d = guard.finalDecision([p1, p2, p3], judge);
  assert.equal(d.passed, true);
  assert.equal(d.chosen_index, 2);
  // judge says pass but lists an unsupported claim -> fail
  const d2 = guard.finalDecision([p1], { results: [{ variant: 1, verdict: 'pass', quality: 5, claims: [{ claim: 'x', supported: false }], violations: [] }] });
  assert.equal(d2.passed, false);
  // judge unavailable -> fail closed
  const d3 = guard.finalDecision([p1], null);
  assert.equal(d3.passed, false);
  assert.match(d3.reason, /fail-closed/);
});

test('prompt builders produce OpenAI-compatible JSON-mode requests', () => {
  const g = buildGenerationRequest(pkg, SOURCE, cfg);
  assert.equal(g.response_format.type, 'json_object');
  assert.equal(g.messages.length, 2);
  assert.match(g.messages[1].content, /<SOURCE>/);
  const j = buildJudgeRequest(SOURCE, [{ index: 1, text_before_link: 'hello' }], cfg);
  assert.equal(j.temperature, 0);
  assert.match(j.messages[1].content, /DRAFT 1/);
});

// ---------------------------------------------------------------- publishing
test('nextScheduleTime: next local HH:MM with >= 15 min lead, DST-aware', () => {
  // 2026-10-28 15:00 UTC = 09:00 in Denver (MDT, UTC-6). 18:00 local = 00:00 UTC next day.
  assert.equal(publish.nextScheduleTime('2026-10-28T15:00:00Z', '18:00', 'America/Denver').toISOString(), '2026-10-29T00:00:00.000Z');
  // After 18:00 local -> tomorrow
  assert.equal(publish.nextScheduleTime('2026-10-29T01:00:00Z', '18:00', 'America/Denver').toISOString(), '2026-10-30T00:00:00.000Z');
  // Across DST end (Nov 1 2026): 18:00 MST = 01:00 UTC
  assert.equal(publish.nextScheduleTime('2026-11-01T20:00:00Z', '18:00', 'America/Denver').toISOString(), '2026-11-02T01:00:00.000Z');
  // Karachi has no DST
  assert.equal(publish.nextScheduleTime('2026-10-28T10:00:00Z', '18:00', 'Asia/Karachi').toISOString(), '2026-10-28T13:00:00.000Z');
});

test('buildPublishPlan: photo post with link fallback, scheduling fields', () => {
  const post = guard.assemblePost(goodVariant, pkg, cfg);
  const live = { ...cfg, dry_run: false, fb_page_id: '123', fb_graph_base: 'https://graph.facebook.com/v23.0' };
  const now = publish.buildPublishPlan({ post, content: pkg, cfg: live, nowIso: '2026-10-28T15:00:00Z' });
  assert.equal(now.primary.url, 'https://graph.facebook.com/v23.0/123/photos');
  assert.equal(now.primary.body.url, pkg.image_url);
  assert.equal(now.primary.body.published, true);
  assert.equal(now.fallback.endpoint, 'feed');
  const sched = publish.buildPublishPlan({ post, content: pkg, cfg: { ...live, publish_strategy: 'schedule' }, nowIso: '2026-10-28T15:00:00Z' });
  assert.equal(sched.primary.body.published, false);
  assert.equal(sched.primary.body.scheduled_publish_time, Date.parse("2026-10-29T00:00:00Z") / 1000);
  const noImg = publish.buildPublishPlan({ post, content: { ...pkg, image_url: null }, cfg: live, nowIso: '2026-10-28T15:00:00Z' });
  assert.equal(noImg.primary.endpoint, 'feed');
  assert.equal(noImg.fallback, null);
});

test('Instagram cross-post plan: JPEG rendition, caption without a dead link', () => {
  const post = guard.assemblePost(goodVariant, pkg, cfg);
  const plan = publish.buildPublishPlan({ post, content: pkg, cfg: { ...cfg, ig_user_id: '1784', fb_graph_base: 'https://graph.facebook.com/v23.0' }, nowIso: '2026-10-28T15:00:00Z' });
  assert.equal(plan.instagram.create_url, 'https://graph.facebook.com/v23.0/1784/media');
  assert.match(plan.instagram.body.image_url, /cdn-cgi\/image\/quality=85,fit=pad,width=1200,height=630,format=jpeg\//);
  assert.doesNotMatch(plan.instagram.body.caption, /https?:\/\//);
  assert.equal(publish.buildPublishPlan({ post, content: pkg, cfg, nowIso: '2026-10-28T15:00:00Z' }).instagram, null);
});

test('Graph API error classification', () => {
  assert.equal(publish.classifyGraphError({ error: { message: 'Error validating access token: Session has expired', type: 'OAuthException', code: 190 } }).code, 'FB_TOKEN_EXPIRED');
  assert.equal(publish.classifyGraphError({ error: { message: '(#200) requires pages_manage_posts', code: 200 } }).code, 'FB_PERMISSION');
  assert.equal(publish.classifyGraphError({ error: { message: 'Application request limit reached', code: 4 } }).code, 'FB_RATE_LIMIT');
  assert.equal(publish.classifyGraphError({ error: { message: '(#324) Requires upload file', type: 'OAuthException', code: 324 } }).code, 'FB_IMAGE_ERROR', 'OAuthException type alone does not mean an expired token');
  const wrapped = publish.classifyGraphError({ message: '400 - "{\\"error\\":{\\"message\\":\\"Error validating access token: Session has expired\\",\\"type\\":\\"OAuthException\\",\\"code\\":190,\\"error_subcode\\":463}}"', httpCode: '400' });
  assert.equal(wrapped.code, 'FB_TOKEN_EXPIRED');
  assert.equal(wrapped.message, 'Error validating access token: Session has expired');
  assert.equal(publish.classifyGraphError({ message: 'connect ECONNREFUSED 1.2.3.4:443' }).code, 'FB_UNAVAILABLE');
  assert.equal(publish.classifyGraphError({ error: { message: 'An unexpected error has occurred', code: 2 } }).code, 'FB_UNAVAILABLE');
  // n8n error objects carry the body as a string inside description
  assert.equal(publish.classifyGraphError({ message: '400 - bad request', description: '{"error":{"code":190,"type":"OAuthException"}}' }).code, 'FB_TOKEN_EXPIRED');
  const ok = publish.interpretGraphResponse(200, { id: '999', post_id: '123_456' });
  assert.deepEqual(ok, { ok: true, post_id: '123_456', photo_id: '999' });
  assert.equal(publish.interpretGraphResponse(200, '{"id":"123_789"}').post_id, '123_789');
  assert.equal(publish.interpretGraphResponse(400, { error: { code: 190 } }).error.code, 'FB_TOKEN_EXPIRED');
});

// ---------------------------------------------------------------- outcomes
test('outcomes: failures raise and alert; success can be silenced; payload is base64 JSON', () => {
  const f = buildOutcome('failed', { cfg, execution_id: 7, stage: 'Fetch listing pages', error: { message: 'ETIMEDOUT' } });
  assert.equal(f.error_code, 'SITE_DOWN');
  assert.equal(f.raise, true);
  assert.equal(f.notify, true);
  const payload = JSON.parse(Buffer.from(f.db_payload_b64, 'base64').toString('utf8'));
  assert.equal(payload.run_status, 'failed');
  const s = buildOutcome('success', { cfg: { ...cfg, notify_on_success: false }, execution_id: 8, post_text: 'x' });
  assert.equal(s.notify, false);
  assert.equal(s.run_status, 'dry_run');
  const silent = buildOutcome('failed', { cfg: { ...cfg, telegram_chat_id: '' }, execution_id: 9, stage: 'x', error: 'boom' });
  assert.equal(silent.notify, false, 'no chat configured -> no Telegram call, but the run still raises');
  assert.equal(silent.raise, true);
  assert.match(f.text, /&lt;|SITE_DOWN/);
});

test('classifyFailure: LLM auth vs rate limit, Facebook token', () => {
  assert.equal(classifyFailure('LLM: generate variants', { message: '401 - Incorrect API key provided' }).code, 'LLM_AUTH');
  const wrapped = classifyFailure('Facebook: preflight token check', { message: '400 - "{\\"error\\":{\\"message\\":\\"Error validating access token\\",\\"code\\":190}}"' });
  assert.equal(wrapped.code, 'FB_TOKEN_EXPIRED');
  assert.equal(wrapped.message, 'HTTP 400: Error validating access token');
  assert.equal(classifyFailure('LLM: compliance judge', { message: '500 - "{\\"error\\":{\\"message\\":\\"server overloaded\\"}}"' }).code, 'LLM_ERROR');
  assert.equal(classifyFailure('LLM: judge', { message: '429 - insufficient_quota' }).code, 'LLM_RATE_LIMIT');
  assert.equal(classifyFailure('Facebook: preflight', { description: '{"error":{"code":190}}' }).code, 'FB_TOKEN_EXPIRED');
  assert.equal(classifyFailure('Config', { message: 'CONFIG_INVALID: x' }).code, 'CONFIG_INVALID');
  const c = classifyFailure('Check publish result', 'FB_TOKEN_EXPIRED: Error validating access token');
  assert.equal(c.code, 'FB_TOKEN_EXPIRED');
  assert.equal(c.message, 'Error validating access token');
});

'use strict';
/**
 * Builds workflows/*.json from src/. Run: npm run build
 *   01-placidway-daily-facebook-post.json   main pipeline (schedule + manual, approval, guardrails, publish, logging, alerts)
 *   02-placidway-engagement-sync.json       stretch: reactions/comments/shares/clicks read-back every 6h
 *   03-placidway-dashboard.json             stretch: HTML dashboard of scheduled/published posts and the run log
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { WorkflowBuilder, CREDENTIALS, stableId } = require('./n8n-builder');
const Q = require('../src/sql/queries');

const OUT = path.resolve(__dirname, '..', 'workflows');
const DAILY_ID = 'pwDailyPost00001';
const ENGAGEMENT_ID = 'pwEngagement0001';
const DASHBOARD_ID = 'pwDashboard00001';
const TZ = 'America/Denver';

const CFG = "$('Config').first(0).json.cfg";
const UA_HEADERS = {
  parameters: [
    { name: 'User-Agent', value: `={{ ${CFG}.user_agent }}` },
    { name: 'Accept', value: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8' },
  ],
};
const RETRY = { retryOnFail: true, maxTries: 3, waitBetweenTries: 5000 };


// ------------------------------------------------------------------------------------------------
// Canvas layout for the daily workflow: [column, y]. Columns are 220 px apart; rows: approval lane -60/100,
// main lane 300, alternate lane 480/620, failure lane 820. Sticky notes are drawn as stage backgrounds.
const COL = 220;
const DAILY_LAYOUT = {
  'Daily schedule': [0, 220], 'Manual run': [0, 400], 'Config': [1, 300], 'DB: run start': [2, 300],
  'Already posted today?': [3, 300], 'Outcome: already posted': [4, 100], 'Dry run?': [4, 300], 'Facebook: preflight token check': [5, 480],
  'Fetch robots.txt': [6.4, 300], 'Plan listing requests': [7.4, 300], 'Polite delay (listings)': [8.4, 300], 'Fetch listing pages': [9.4, 300],
  'DB: posting history': [10.8, 300], 'Select candidates': [11.8, 300], 'Have candidates?': [12.8, 300], 'Outcome: no content': [13.8, 100],
  'Polite delay (details)': [13.8, 300], 'Fetch detail pages': [14.8, 300], 'Extract & validate content': [15.8, 300], 'DB: claim item': [16.8, 300],
  'Claimed?': [17.8, 300], 'Outcome: claimed elsewhere': [18.8, 100],
  'Build generation request': [19.2, 300], 'LLM: generate variants': [20.2, 300], 'Guardrails: rule checks': [21.2, 300], 'Any draft passed rules?': [22.2, 300],
  'LLM: compliance judge': [23.2, 160], 'Guardrails: final decision': [24.2, 300], 'Passed guardrails?': [25.2, 300], 'Outcome: blocked': [26.2, 480],
  'Approval required?': [26.2, 300], 'Prepare review request': [27.2, -60], 'DB: save draft': [28.2, -60], 'Telegram: send for review': [29.2, -60],
  'Wait for reviewer': [30.2, -60], 'Review decision': [31.2, -60], 'Approved?': [32.2, -60], 'Outcome: rejected': [33.2, -220], 'DB: mark approved': [33.2, -60],
  'Build publish plan': [34.4, 300], 'Dry run? (publish)': [35.4, 300], 'Simulate publish': [36.4, 120], 'Facebook: publish post': [36.4, 460],
  'Check publish result': [37.4, 460], 'Use link fallback?': [38.4, 460], 'Facebook: publish link post (fallback)': [39.4, 620], 'Check fallback result': [40.4, 620],
  'Facebook: get permalink': [41.4, 460], 'Cross-post to Instagram?': [42.4, 460], 'Instagram: create container': [43.4, 620],
  'Wait for Instagram processing': [44.4, 620], 'Instagram: publish': [45.4, 620], 'Outcome: success': [46.4, 300],
  'Outcome: failed': [33, 820], 'On workflow error': [45.6, 820], 'Outcome: unexpected error': [46.6, 820],
  'Outcome': [47.8, 560], 'DB: finalize run': [48.8, 560], 'Notify?': [49.8, 560], 'Telegram: notify': [50.8, 440], 'Raise error?': [51.8, 560], 'Mark execution failed': [52.8, 540],
};
// [firstCol, lastCol, top, bottom, color]
const DAILY_STICKIES = {
  'Note: trigger': [0, 5, -200, 640, 5],
  'Note: extract': [6.4, 9.4, -200, 640, 4],
  'Note: select': [10.8, 18.8, -200, 640, 6],
  'Note: generate': [19.2, 26.2, 0, 640, 3],
  'Note: review': [26.9, 33.2, -420, -20, 2],
  'Note: publish': [34.4, 46.4, -200, 760, 4],
  'Note: tail': [45.6, 52.8, 380, 980, 7],
};
function applyLayout(wf, nodes, stickies) {
  for (const n of wf.nodes) {
    if (nodes[n.name]) n.position = [Math.round(nodes[n.name][0] * COL), nodes[n.name][1]];
    if (stickies[n.name]) {
      const [a, b, top, bottom, color] = stickies[n.name];
      n.position = [Math.round(a * COL) - 50, top];
      n.parameters.width = Math.round((b - a) * COL) + 190;
      n.parameters.height = bottom - top;
      n.parameters.color = color;
    }
  }
  const missing = wf.nodes.filter((n) => n.type !== 'n8n-nodes-base.stickyNote' && !nodes[n.name]).map((n) => n.name);
  if (missing.length) throw new Error(`layout missing for: ${missing.join(', ')}`);
  return wf;
}

// ------------------------------------------------------------------------------------------------
function daily() {
  const w = new WorkflowBuilder({
    id: DAILY_ID,
    name: 'PlacidWay → Facebook: daily post',
    settings: {
      executionOrder: 'v1', timezone: TZ, errorWorkflow: DAILY_ID, saveManualExecutions: true,
      saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all', saveExecutionProgress: true, callerPolicy: 'workflowsFromSameOwner',
    },
  });
  const X = (c) => c * 240;

  // ---- notes (self-documenting canvas)
  w.sticky('Note: trigger', '## 1 · Trigger & daily guard\nRuns at **09:00**, with retry slots at **11:00** and **14:00** (workflow timezone). A slot stops as soon as today already has a post, so a site/API outage at 09:00 heals itself. **Manual run** always proceeds (demo/testing).\n\nConfig comes from `PW_*` env vars (see README). Defaults are safe: dry run.', [X(-0.2), -60], 700, 300, 5);
  w.sticky('Note: extract', '## 2 · Extract (polite)\n`robots.txt` is fetched and enforced first (RFC 9309: 5xx = stop). Listing pages sorted by *modified date* act as the feed for **articles, packages and Q&A**. Max ~6 requests per run, ≥1.5 s apart (≤1 req/s). Links are parsed by URL pattern, not CSS classes.', [X(4.8), -60], 1200, 300, 4);
  w.sticky('Note: select', '## 3 · Select & dedupe\nSkips everything already posted / in review / blocked (Postgres, keyed by `article:4617`). Weekday rotation (article → package → Q&A) + avoids repeating a treatment category. Top 2 detail pages fetched; first usable one is **claimed atomically** (no double posts, even with concurrent runs).', [X(9.8), -60], 1200, 300, 6);
  w.sticky('Note: generate', '## 4 · Generate + guardrails (fail-closed)\nLLM writes **3 variants** as JSON (hook, 2–4 lines, CTA, 3–5 hashtags + verbatim evidence). Post is assembled in code (<500 chars before the link). **Layer 1 rules:** banned claims, every number/price must exist in the source, credentials, evidence check. **Layer 2:** LLM judge verifies each claim against the page. Publish only if both pass.', [X(15.8), -60], 1450, 300, 3);
  w.sticky('Note: review', '## 5 · Approval mode (`PW_REVIEW_MODE=approval`)\nDraft + guardrail evidence go to Telegram with signed **Approve / Reject** links. The execution pauses (Wait node, link previews ignored) until a click or the timeout.', [X(23), -360], 1450, 260, 2);
  w.sticky('Note: publish', '## 6 · Publish\nPhoto post (featured image + caption) → falls back to a link post if Facebook rejects the image. `PW_PUBLISH_STRATEGY=schedule` creates a Facebook scheduled post. **Dry run** shows the exact Graph API request without sending it. No automatic retry of the POST (not idempotent: avoids double posts). Optional **Instagram cross-post** (`PW_IG_USER_ID`): JPEG rendition + caption; an IG failure never undoes the Facebook post.', [X(32.8), -60], 2600, 300, 4);
  w.sticky('Note: tail', '## 7 · One exit for every run\nEvery path ends in an **Outcome** → `pw_run_log` + `pw_posts` updated → Telegram alert/notification → handled failures re-raised so the execution shows as failed. Crashes anywhere else reach the **Error Trigger** (this workflow is its own error workflow).', [X(40.4), 760], 1400, 260, 7);

  // ---- triggers & guard
  w.add({ name: 'Daily schedule', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [X(0), 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '0 9,11,14 * * *' }] } } });
  w.add({ name: 'Manual run', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [X(0), 500], parameters: {} });
  w.code('Config', 'daily/config.js', [X(1), 400], { onError: 'continueErrorOutput' });
  w.pg('DB: run start', Q.RUN_START, [X(2), 380]);
  w.iff('Already posted today?', "$json.posts_today > 0 && !$('Config').first(0).json.run.force", [X(3), 380]);
  w.code('Outcome: already posted', 'daily/outcome-skipped.js', [X(4), 160]);
  w.iff('Dry run?', `${CFG}.dry_run`, [X(4), 400]);
  w.http('Facebook: preflight token check', [X(5), 560], {
    url: `={{ ${CFG}.fb_graph_base }}/{{ ${CFG}.fb_page_id }}`,
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'id,name' }] },
    options: { timeout: 20000 },
  }, { credentials: CREDENTIALS.facebook, retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueErrorOutput' });

  // ---- extract
  w.http('Fetch robots.txt', [X(6), 400], {
    url: `={{ ${CFG}.base_url }}/robots.txt`,
    sendHeaders: true, headerParameters: UA_HEADERS,
    options: { timeout: 20000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'text', outputPropertyName: 'data' } } },
  }, { ...RETRY, onError: 'continueErrorOutput' });
  w.code('Plan listing requests', 'daily/plan-listings.js', [X(7), 400], { onError: 'continueErrorOutput' });
  w.delay('Polite delay (listings)', "$('Plan listing requests').first(0).json.interval_ms / 1000", [X(8), 400]);
  w.http('Fetch listing pages', [X(9), 400], {
    url: '={{ $json.url }}',
    sendHeaders: true, headerParameters: UA_HEADERS,
    options: {
      batching: { batch: { batchSize: 1, batchInterval: "={{ $('Plan listing requests').first(0).json.interval_ms }}" } },
      timeout: 30000, response: { response: { responseFormat: 'text', outputPropertyName: 'html' } },
    },
  }, { ...RETRY, onError: 'continueRegularOutput' });

  // ---- select
  w.pg('DB: posting history', Q.HISTORY, [X(10), 400], { payload: false, executeOnce: true });
  w.code('Select candidates', 'daily/select.js', [X(11), 400], { onError: 'continueErrorOutput' });
  w.iff('Have candidates?', '$json.has_candidates', [X(12), 400]);
  w.code('Outcome: no content', 'daily/outcome-no-content.js', [X(13), 160]);
  w.delay('Polite delay (details)', "$('Plan listing requests').first(0).json.interval_ms / 1000", [X(13), 400]);
  w.http('Fetch detail pages', [X(14), 400], {
    url: '={{ $json.candidate.url }}',
    sendHeaders: true, headerParameters: UA_HEADERS,
    options: {
      batching: { batch: { batchSize: 1, batchInterval: "={{ $('Plan listing requests').first(0).json.interval_ms }}" } },
      timeout: 30000, response: { response: { responseFormat: 'text', outputPropertyName: 'html' } },
    },
  }, { onError: 'continueRegularOutput' }); // no retry: a dead page falls back to the next candidate instead
  w.code('Extract & validate content', 'daily/extract.js', [X(15), 400], { onError: 'continueErrorOutput' });
  w.pg('DB: claim item', Q.CLAIM, [X(16), 400], { payload: '={{ $json.claim_payload_b64 }}' });
  w.iff('Claimed?', '$json.post_id !== null && $json.post_id !== undefined', [X(17), 400]);
  w.code('Outcome: claimed elsewhere', 'daily/outcome-skipped.js', [X(18), 160]);

  // ---- generate & guardrails
  w.code('Build generation request', 'daily/build-generation.js', [X(18), 400]);
  w.http('LLM: generate variants', [X(19), 400], {
    method: 'POST', url: `={{ ${CFG}.llm_base_url }}/chat/completions`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.request) }}',
    options: { timeout: 120000 },
  }, { credentials: CREDENTIALS.llm, ...RETRY, onError: 'continueErrorOutput' });
  w.code('Guardrails: rule checks', 'daily/rule-checks.js', [X(20), 400], { onError: 'continueErrorOutput' });
  w.iff('Any draft passed rules?', '$json.any_passed', [X(21), 400]);
  w.http('LLM: compliance judge', [X(22), 280], {
    method: 'POST', url: `={{ ${CFG}.llm_base_url }}/chat/completions`,
    authentication: 'genericCredentialType', genericAuthType: 'httpHeaderAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.judge_request) }}',
    options: { timeout: 120000 },
  }, { credentials: CREDENTIALS.llm, ...RETRY, onError: 'continueErrorOutput' });
  w.code('Guardrails: final decision', 'daily/final-decision.js', [X(23), 400]);
  w.iff('Passed guardrails?', '$json.passed', [X(24), 400]);
  w.code('Outcome: blocked', 'daily/outcome-blocked.js', [X(25), 620]);

  // ---- approval
  w.iff('Approval required?', `${CFG}.review_mode === 'approval'`, [X(25), 400]);
  w.code('Prepare review request', 'daily/prepare-review.js', [X(26), 140]);
  w.pg('DB: save draft', Q.SAVE_DRAFT, [X(27), 140]);
  w.telegram('Telegram: send for review', `${CFG}.telegram_chat_id`, "$('Prepare review request').first(0).json.message", [X(28), 140], { onError: 'continueErrorOutput' });
  w.add({
    name: 'Wait for reviewer', type: 'n8n-nodes-base.wait', typeVersion: 1.1, position: [X(29), 120], webhookId: stableId('review-webhook'),
    parameters: {
      resume: 'webhook', httpMethod: 'GET', responseMode: 'onReceived',
      limitWaitTime: true, limitType: 'afterTimeInterval', resumeAmount: `={{ ${CFG}.review_timeout_hours }}`, resumeUnit: 'hours',
      options: { responseData: 'Thanks, your decision was recorded. You can close this tab.', ignoreBots: true },
    },
  });
  w.code('Review decision', 'daily/review-decision.js', [X(30), 120]);
  w.iff('Approved?', '$json.approved', [X(31), 120]);
  w.code('Outcome: rejected', 'daily/outcome-rejected.js', [X(32), -60]);
  w.pg('DB: mark approved', Q.MARK_APPROVED, [X(32), 140], { payload: "={{ $('Prepare review request').first(0).json.db_payload_b64 }}" });

  // ---- publish
  w.code('Build publish plan', 'daily/build-publish.js', [X(33), 400]);
  w.iff('Dry run? (publish)', '$json.dry_run', [X(34), 400]);
  w.code('Simulate publish', 'daily/simulate-publish.js', [X(35), 240]);
  w.http('Facebook: publish post', [X(35), 520], {
    method: 'POST', url: '={{ $json.plan.primary.url }}',
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.plan.primary.body) }}',
    options: { timeout: 60000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
  }, { credentials: CREDENTIALS.facebook, onError: 'continueErrorOutput' });
  w.code('Check publish result', 'daily/check-publish.js', [X(36), 520], { onError: 'continueErrorOutput' });
  w.iff('Use link fallback?', '$json.use_fallback', [X(37), 520]);
  w.http('Facebook: publish link post (fallback)', [X(38), 680], {
    method: 'POST', url: '={{ $json.fallback.url }}',
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendBody: true, specifyBody: 'json', jsonBody: '={{ JSON.stringify($json.fallback.body) }}',
    options: { timeout: 60000, response: { response: { fullResponse: true, neverError: true, responseFormat: 'json' } } },
  }, { credentials: CREDENTIALS.facebook, onError: 'continueErrorOutput' });
  w.code('Check fallback result', 'daily/check-fallback.js', [X(39), 680], { onError: 'continueErrorOutput' });
  w.http('Facebook: get permalink', [X(40), 520], {
    url: `={{ ${CFG}.fb_graph_base }}/{{ $json.post_id }}`,
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'permalink_url' }] },
    options: { timeout: 20000 },
  }, { credentials: CREDENTIALS.facebook, onError: 'continueRegularOutput' });
  w.iff('Cross-post to Instagram?', "!!$('Build publish plan').first(0).json.plan.instagram", [X(41), 520]);
  w.http('Instagram: create container', [X(42), 680], {
    method: 'POST', url: "={{ $('Build publish plan').first(0).json.plan.instagram.create_url }}",
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify($('Build publish plan').first(0).json.plan.instagram.body) }}",
    options: { timeout: 60000 },
  }, { credentials: CREDENTIALS.facebook, retryOnFail: true, maxTries: 2, waitBetweenTries: 5000, onError: 'continueRegularOutput' });
  w.delay('Wait for Instagram processing', '5', [X(43), 680]);
  w.http('Instagram: publish', [X(44), 680], {
    method: 'POST', url: "={{ $('Build publish plan').first(0).json.plan.instagram.publish_url }}",
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendBody: true, specifyBody: 'json', jsonBody: "={{ JSON.stringify({ creation_id: $('Instagram: create container').first(0).json.id }) }}",
    options: { timeout: 60000 },
  }, { credentials: CREDENTIALS.facebook, onError: 'continueRegularOutput' });
  w.code('Outcome: success', 'daily/outcome-success.js', [X(45), 400]);

  // ---- failures, error trigger, single exit
  w.code('Outcome: failed', 'daily/outcome-failed.js', [X(20), 900]);
  w.add({ name: 'On workflow error', type: 'n8n-nodes-base.errorTrigger', typeVersion: 1, position: [X(43), 1100], parameters: {} });
  w.code('Outcome: unexpected error', 'daily/outcome-unexpected.js', [X(44), 1100]);
  w.add({ name: 'Outcome', type: 'n8n-nodes-base.noOp', typeVersion: 1, position: [X(50), 900], parameters: {} });
  w.pg('DB: finalize run', Q.FINALIZE, [X(47), 900], { onError: 'continueRegularOutput', alwaysOutputData: true });
  w.iff('Notify?', "$('Outcome').first(0).json.notify", [X(48), 900]);
  w.telegram('Telegram: notify', "$('Outcome').first(0).json.chat_id", "$('Outcome').first(0).json.text", [X(49), 780], { onError: 'continueRegularOutput' });
  w.iff('Raise error?', "$('Outcome').first(0).json.raise", [X(50), 900]);
  w.add({
    name: 'Mark execution failed', type: 'n8n-nodes-base.stopAndError', typeVersion: 1, position: [X(51), 880],
    parameters: { errorType: 'errorMessage', errorMessage: "={{ '[HANDLED] ' + $('Outcome').first(0).json.error_code + ': ' + $('Outcome').first(0).json.error_message }}" },
  });

  // ---- wiring: main line
  w.connect('Daily schedule', 'Config');
  w.connect('Manual run', 'Config');
  w.connect('Config', 'DB: run start');
  w.connect('Config', 'Outcome: failed', 1);
  w.connect('DB: run start', 'Already posted today?');
  w.connect('Already posted today?', 'Outcome: already posted', 0);
  w.connect('Already posted today?', 'Dry run?', 1);
  w.connect('Dry run?', 'Fetch robots.txt', 0);
  w.connect('Dry run?', 'Facebook: preflight token check', 1);
  w.connect('Facebook: preflight token check', 'Fetch robots.txt', 0);
  w.connect('Facebook: preflight token check', 'Outcome: failed', 1);
  w.connect('Fetch robots.txt', 'Plan listing requests', 0);
  w.connect('Fetch robots.txt', 'Outcome: failed', 1);
  w.connect('Plan listing requests', 'Polite delay (listings)', 0);
  w.connect('Plan listing requests', 'Outcome: failed', 1);
  w.chain('Polite delay (listings)', 'Fetch listing pages', 'DB: posting history', 'Select candidates');
  w.connect('Select candidates', 'Outcome: failed', 1);
  w.connect('Select candidates', 'Have candidates?', 0);
  w.connect('Have candidates?', 'Polite delay (details)', 0);
  w.connect('Have candidates?', 'Outcome: no content', 1);
  w.chain('Polite delay (details)', 'Fetch detail pages', 'Extract & validate content');
  w.connect('Extract & validate content', 'DB: claim item', 0);
  w.connect('Extract & validate content', 'Outcome: failed', 1);
  w.connect('DB: claim item', 'Claimed?');
  w.connect('Claimed?', 'Build generation request', 0);
  w.connect('Claimed?', 'Outcome: claimed elsewhere', 1);
  w.connect('Build generation request', 'LLM: generate variants');
  w.connect('LLM: generate variants', 'Guardrails: rule checks', 0);
  w.connect('LLM: generate variants', 'Outcome: failed', 1);
  w.connect('Guardrails: rule checks', 'Any draft passed rules?', 0);
  w.connect('Guardrails: rule checks', 'Outcome: failed', 1);
  w.connect('Any draft passed rules?', 'LLM: compliance judge', 0);
  w.connect('Any draft passed rules?', 'Guardrails: final decision', 1);
  w.connect('LLM: compliance judge', 'Guardrails: final decision', 0);
  w.connect('LLM: compliance judge', 'Outcome: failed', 1);
  w.connect('Guardrails: final decision', 'Passed guardrails?');
  w.connect('Passed guardrails?', 'Approval required?', 0);
  w.connect('Passed guardrails?', 'Outcome: blocked', 1);
  w.connect('Approval required?', 'Prepare review request', 0);
  w.connect('Approval required?', 'Build publish plan', 1);
  w.chain('Prepare review request', 'DB: save draft', 'Telegram: send for review');
  w.connect('Telegram: send for review', 'Wait for reviewer', 0);
  w.connect('Telegram: send for review', 'Outcome: failed', 1);
  w.chain('Wait for reviewer', 'Review decision', 'Approved?');
  w.connect('Approved?', 'DB: mark approved', 0);
  w.connect('Approved?', 'Outcome: rejected', 1);
  w.connect('DB: mark approved', 'Build publish plan');
  w.connect('Build publish plan', 'Dry run? (publish)');
  w.connect('Dry run? (publish)', 'Simulate publish', 0);
  w.connect('Dry run? (publish)', 'Facebook: publish post', 1);
  w.connect('Simulate publish', 'Outcome: success');
  w.connect('Facebook: publish post', 'Check publish result', 0);
  w.connect('Facebook: publish post', 'Outcome: failed', 1);
  w.connect('Check publish result', 'Use link fallback?', 0);
  w.connect('Check publish result', 'Outcome: failed', 1);
  w.connect('Use link fallback?', 'Facebook: publish link post (fallback)', 0);
  w.connect('Use link fallback?', 'Facebook: get permalink', 1);
  w.connect('Facebook: publish link post (fallback)', 'Check fallback result', 0);
  w.connect('Facebook: publish link post (fallback)', 'Outcome: failed', 1);
  w.connect('Check fallback result', 'Facebook: get permalink', 0);
  w.connect('Check fallback result', 'Outcome: failed', 1);
  w.connect('Facebook: get permalink', 'Cross-post to Instagram?');
  w.connect('Cross-post to Instagram?', 'Instagram: create container', 0);
  w.connect('Cross-post to Instagram?', 'Outcome: success', 1);
  w.chain('Instagram: create container', 'Wait for Instagram processing', 'Instagram: publish', 'Outcome: success');

  // ---- wiring: every outcome -> single exit
  for (const o of ['Outcome: already posted', 'Outcome: no content', 'Outcome: claimed elsewhere', 'Outcome: blocked',
    'Outcome: rejected', 'Outcome: success', 'Outcome: failed', 'Outcome: unexpected error']) w.connect(o, 'Outcome');
  w.connect('On workflow error', 'Outcome: unexpected error');
  w.chain('Outcome', 'DB: finalize run', 'Notify?');
  w.connect('Notify?', 'Telegram: notify', 0);
  w.connect('Notify?', 'Raise error?', 1);
  w.connect('Telegram: notify', 'Raise error?');
  w.connect('Raise error?', 'Mark execution failed', 0);
  return applyLayout(w.build(), DAILY_LAYOUT, DAILY_STICKIES);
}

// ------------------------------------------------------------------------------------------------
function engagement() {
  const w = new WorkflowBuilder({
    id: ENGAGEMENT_ID,
    name: 'PlacidWay → Facebook: engagement sync',
    settings: { executionOrder: 'v1', timezone: TZ, errorWorkflow: DAILY_ID, saveManualExecutions: true },
  });
  const X = (c) => c * 240;
  w.sticky('Note', '## Engagement read-back (stretch)\nEvery 6 h: for posts published in the last 30 days, reads reactions, comments, shares (and `post_clicks` insights when the token has `read_insights`), stores the latest numbers on `pw_posts` and a time-series row in `pw_engagement_snapshots`. Scheduled posts flip to *published* once Facebook reports them live. Errors (e.g. expired token) go to the daily workflow\'s error handler → Telegram alert.', [X(0), -40], 1100, 240, 4);
  w.add({ name: 'Every 6 hours', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [X(0), 300], parameters: { rule: { interval: [{ field: 'cronExpression', expression: '17 */6 * * *' }] } } });
  w.add({ name: 'Manual run', type: 'n8n-nodes-base.manualTrigger', typeVersion: 1, position: [X(0), 480], parameters: {} });
  w.code('Config', 'engagement/config.js', [X(1), 380]);
  w.pg('DB: engagement targets', Q.ENGAGEMENT_TARGETS, [X(2), 380], { payload: false });
  w.http('Facebook: reactions, comments, shares', [X(3), 380], {
    url: `={{ ${CFG}.fb_graph_base }}/{{ $json.fb_post_id }}`,
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendQuery: true, queryParameters: { parameters: [{ name: 'fields', value: 'reactions.summary(total_count).limit(0),comments.summary(total_count).limit(0),shares,permalink_url,is_published' }] },
    options: { batching: { batch: { batchSize: 1, batchInterval: 400 } }, timeout: 20000 },
  }, { credentials: CREDENTIALS.facebook, retryOnFail: true, maxTries: 2, waitBetweenTries: 3000, onError: 'continueRegularOutput' });
  w.http('Facebook: clicks (insights)', [X(4), 380], {
    url: `={{ ${CFG}.fb_graph_base }}/{{ $('DB: engagement targets').all(0)[$itemIndex].json.fb_post_id }}/insights`,
    authentication: 'genericCredentialType', genericAuthType: 'httpQueryAuth',
    sendQuery: true, queryParameters: { parameters: [{ name: 'metric', value: 'post_clicks' }] },
    options: { batching: { batch: { batchSize: 1, batchInterval: 400 } }, timeout: 20000 },
  }, { credentials: CREDENTIALS.facebook, onError: 'continueRegularOutput' });
  w.code('Merge metrics', 'engagement/merge-metrics.js', [X(5), 380]);
  w.pg('DB: save engagement', Q.ENGAGEMENT_SAVE, [X(6), 380]);
  w.connect('Every 6 hours', 'Config');
  w.connect('Manual run', 'Config');
  w.chain('Config', 'DB: engagement targets', 'Facebook: reactions, comments, shares', 'Facebook: clicks (insights)', 'Merge metrics', 'DB: save engagement');
  return w.build();
}

// ------------------------------------------------------------------------------------------------
function dashboard() {
  const w = new WorkflowBuilder({
    id: DASHBOARD_ID,
    name: 'PlacidWay → Facebook: dashboard',
    settings: { executionOrder: 'v1', timezone: TZ, errorWorkflow: DAILY_ID, saveDataSuccessExecution: 'none' },
  });
  const X = (c) => c * 240;
  w.sticky('Note', '## Dashboard (stretch)\nOpen `<n8n-url>/webhook/placidway-dashboard` for scheduled/published posts, guardrail blocks, failures, engagement and the run log. Read-only. Protect it with the Webhook node\'s Basic Auth before exposing n8n publicly.', [X(0), -20], 980, 200, 4);
  w.add({ name: 'GET /placidway-dashboard', type: 'n8n-nodes-base.webhook', typeVersion: 2, position: [X(0), 300], webhookId: stableId('dashboard-webhook'), parameters: { path: 'placidway-dashboard', responseMode: 'responseNode', options: {} } });
  w.pg('DB: dashboard data', Q.DASHBOARD, [X(1), 300], { payload: false });
  w.code('Render HTML', 'dashboard/render.js', [X(2), 300]);
  w.add({
    name: 'Respond with page', type: 'n8n-nodes-base.respondToWebhook', typeVersion: 1.1, position: [X(3), 300],
    parameters: { respondWith: 'text', responseBody: '={{ $json.html }}', options: { responseHeaders: { entries: [{ name: 'Content-Type', value: 'text/html; charset=utf-8' }, { name: 'Cache-Control', value: 'no-store' }] } } },
  });
  w.chain('GET /placidway-dashboard', 'DB: dashboard data', 'Render HTML', 'Respond with page');
  return w.build();
}

// ------------------------------------------------------------------------------------------------
function syntaxCheck(wf) {
  const tmp = path.join(require('node:os').tmpdir(), `pw-check-${process.pid}.js`);
  for (const n of wf.nodes.filter((x) => x.type === 'n8n-nodes-base.code')) {
    fs.writeFileSync(tmp, `async function __node() {\n${n.parameters.jsCode}\n}\n`);
    try { execFileSync(process.execPath, ['--check', tmp], { stdio: 'pipe' }); } catch (e) {
      throw new Error(`Syntax error in Code node "${n.name}" of "${wf.name}":\n${e.stderr}`);
    }
  }
  fs.rmSync(tmp, { force: true });
}

fs.mkdirSync(OUT, { recursive: true });
const files = {
  '01-placidway-daily-facebook-post.json': daily(),
  '02-placidway-engagement-sync.json': engagement(),
  '03-placidway-dashboard.json': dashboard(),
};
for (const [file, wf] of Object.entries(files)) {
  syntaxCheck(wf);
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(wf, null, 2) + '\n');
  const counts = wf.nodes.reduce((a, n) => { if (n.type !== 'n8n-nodes-base.stickyNote') a++; return a; }, 0);
  console.log(`built workflows/${file}  (${counts} nodes)`);
}

#!/usr/bin/env node
'use strict';
/**
 * Live sample generator: runs the same pipeline as the workflow (robots -> fetch -> extract -> LLM
 * variants -> rules -> LLM judge) for a few URLs, from the command line, without n8n or Facebook.
 * Useful to regenerate samples/ with your own model and to debug prompts.
 *
 *   LLM_API_KEY=sk-... node scripts/generate-samples.js [url ...]
 *   (optional) PW_LLM_BASE_URL, PW_LLM_MODEL, PW_BASE_URL
 * Writes samples/live/<content_key>.json. Requests to PlacidWay are sequential and >= 1.5 s apart.
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildConfig } = require('../src/lib/config');
const { robotsPolicyFromResponse, policyAllows } = require('../src/lib/robots');
const { extractPage, validateContent, llmContext } = require('../src/lib/extract');
const { contentKeyFromUrl, safeJsonParse } = require('../src/lib/util');
const { buildGenerationRequest, buildJudgeRequest } = require('../src/lib/prompt');
const { assemblePost, checkPost, finalDecision } = require('../src/lib/guardrails');

const DEFAULT_URLS = [
  'https://www.placidway.com/answer-detail/29/How-Much-Does-Shoulder-Replacement-Cost-in-Guadalajara-Mexico',
  'https://www.placidway.com/package/6950/Facelift-Package-in-Seoul-South-Korea-by-VG-Plastic-Surgery',
  'https://www.placidway.com/article/4617/Why-Canadians-Are-Choosing-Full-Mouth-Restoration-in-Colombia-Over-the-USA-or-Mexico',
];

const cfg = buildConfig(process.env);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let last = 0;
async function politeGet(url) {
  const wait = last + cfg.request_interval_ms - Date.now();
  if (wait > 0) await sleep(wait);
  last = Date.now();
  const res = await fetch(url, { headers: { 'user-agent': cfg.user_agent, accept: 'text/html,text/plain;q=0.9,*/*;q=0.8' } });
  return { status: res.status, text: await res.text() };
}

async function llm(body) {
  if (!process.env.LLM_API_KEY) throw new Error('LLM_API_KEY is not set');
  const res = await fetch(`${cfg.llm_base_url}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${process.env.LLM_API_KEY}` }, body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`LLM ${res.status}: ${JSON.stringify(json).slice(0, 300)}`);
  return json;
}

(async () => {
  const urls = process.argv.slice(2).length ? process.argv.slice(2) : DEFAULT_URLS;
  const outDir = path.resolve(__dirname, '..', 'samples', 'live');
  fs.mkdirSync(outDir, { recursive: true });
  const robots = await politeGet(`${cfg.base_url}/robots.txt`);
  const policy = robotsPolicyFromResponse(robots.status, robots.text);
  console.log(`robots.txt: ${policy.reason}`);
  for (const url of urls) {
    const ck = contentKeyFromUrl(url, [new URL(cfg.base_url).hostname]);
    if (!ck) { console.log(`skip (not an article/package/answer URL): ${url}`); continue; }
    if (!policyAllows(policy, cfg.user_agent, url)) { console.log(`skip (disallowed by robots.txt): ${url}`); continue; }
    const page = await politeGet(url);
    const content = { ...extractPage(page.text, { url, type: ck.type, baseUrl: cfg.base_url }), content_key: ck.key, url };
    const problems = validateContent(content, { statusCode: page.status, minBodyChars: cfg.min_body_chars });
    if (problems.length) { console.log(`skip ${ck.key}: ${problems.join(', ')}`); continue; }
    const source = llmContext(content, 7000);
    const gen = await llm(buildGenerationRequest(content, source, cfg));
    const parsed = safeJsonParse(gen.choices[0].message.content) || { variants: [] };
    const drafts = parsed.variants.slice(0, cfg.variants).map((v, i) => {
      const post = assemblePost(v, content, cfg);
      return { ...post, index: i + 1, rules: checkPost(post, source, cfg) };
    });
    const passing = drafts.filter((d) => d.rules.passed);
    const judge = passing.length ? safeJsonParse((await llm(buildJudgeRequest(source, passing, cfg))).choices[0].message.content) : null;
    const decision = finalDecision(drafts, judge);
    const chosen = drafts.find((d) => d.index === decision.chosen_index);
    fs.writeFileSync(path.join(outDir, `${ck.key.replace(':', '-')}.json`), JSON.stringify({
      source_url: url, title: content.title, image_url: content.image_url, model: cfg.llm_model,
      decision: decision.reason, post_text: chosen ? chosen.text : null, report: decision.variants, generated_at: new Date().toISOString(),
    }, null, 2));
    console.log(`\n=== ${ck.key}: ${decision.reason}\n${chosen ? chosen.text : '(blocked)'}`);
  }
})().catch((e) => { console.error(e.message); process.exit(1); });

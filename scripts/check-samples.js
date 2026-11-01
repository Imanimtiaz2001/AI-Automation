#!/usr/bin/env node
'use strict';
/**
 * Runs the workflow's own assembly + layer-1 guardrail code over the sample generations and writes
 * samples/sample-posts.md and samples/sample-posts.json.
 *   samples/sources/<id>.json    facts captured from the live PlacidWay page (source of truth for grounding)
 *   samples/generated/<id>.json  the LLM's {"variants":[...]} output for that page
 * Usage: node scripts/check-samples.js
 */
const fs = require('node:fs');
const path = require('node:path');
const { buildConfig } = require('../src/lib/config');
const { assemblePost, checkPost } = require('../src/lib/guardrails');

const ROOT = path.resolve(__dirname, '..');
const SRC = path.join(ROOT, 'samples', 'sources');
const GEN = path.join(ROOT, 'samples', 'generated');
const cfg = buildConfig({});
const order = ['answer-29', 'package-6950', 'article-4617', 'article-9809'];
const ids = fs.readdirSync(GEN).map((f) => f.replace(/\.json$/, '')).sort((a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99));

const out = [];
for (const id of ids) {
  const source = JSON.parse(fs.readFileSync(path.join(SRC, `${id}.json`), 'utf8'));
  const gen = JSON.parse(fs.readFileSync(path.join(GEN, `${id}.json`), 'utf8'));
  const content = { url: source.url, type: source.type, title: source.title, image_url: source.image_url, price: source.price || null };
  const sourceText = [`TITLE: ${source.title}`, source.price ? `LISTED PRICE: from $${source.price.amount.toLocaleString('en-US')}` : null, `CONTENT TYPE: ${source.type}`, 'BODY:', ...source.facts].filter(Boolean).join('\n');
  const variants = gen.variants.map((v, i) => {
    const post = assemblePost(v, content, cfg);
    return { index: i + 1, angle: post.angle, post, rules: checkPost(post, sourceText, cfg) };
  });
  const chosen = variants.find((v) => v.rules.passed) || null;
  out.push({ id, source, variants, chosen_index: chosen ? chosen.index : null });
}

fs.writeFileSync(path.join(ROOT, 'samples', 'sample-posts.json'), JSON.stringify(out.map((s) => ({
  id: s.id, source_url: s.source.url, content_type: s.source.type, title: s.source.title, image_url: s.source.image_url,
  chosen_variant: s.chosen_index,
  post_text: s.chosen_index ? s.variants[s.chosen_index - 1].post.text : null,
  chars_before_link: s.chosen_index ? s.variants[s.chosen_index - 1].post.chars_before_link : null,
  variants: s.variants.map((v) => ({ index: v.index, angle: v.angle, passed_rules: v.rules.passed, errors: v.rules.errors, warnings: v.rules.warnings, chars_before_link: v.post.chars_before_link })),
})), null, 2) + '\n');

const md = [];
md.push('# Sample output: posts generated from real PlacidWay pages');
md.push('');
md.push('Each sample is based on a live, public PlacidWay page (facts captured 2026-10-28, one page at a time, listed under each sample). The three variants per page were prepared offline, without API calls, following the workflow\'s exact generation prompt. The workflow\'s own code (`src/lib/guardrails.js`, the same code inlined into the n8n Code nodes) then assembled each post and ran the layer-1 rule checks shown below. In a live run the variants come from the configured model and the survivors also pass the layer-2 LLM judge; `npm run samples:live` regenerates them with an API key.');
md.push('');
md.push('> **Control variants.** Variant 2 of every sample is a deliberately non-compliant draft (outcome promises, invented prices, superlatives) that we inject to show what the rules catch. It is not something the prompt tends to produce.');
md.push('');
md.push('Regenerate after a live run: the run log (`pw_run_log.post_text`, `details.guardrails`) and the dashboard hold the real output of every run. `npm run samples` re-checks these files.');
md.push('');
let n = 0;
for (const s of out) {
  n++;
  const chosen = s.chosen_index ? s.variants[s.chosen_index - 1] : null;
  md.push(`## ${n}. ${s.source.title}`);
  md.push('');
  md.push(`- **Source URL:** ${s.source.url}`);
  md.push(`- **Content type:** ${s.source.type}`);
  md.push(`- **Featured image:** ${s.source.image_url ? `[og:image, 1200×630](${s.source.image_url})` : 'none (link post)'}`);
  md.push(`- **Selected:** variant ${s.chosen_index} (“${chosen ? chosen.angle : '-'}”), ${chosen ? chosen.post.chars_before_link : '-'} characters before the link (limit 500)`);
  md.push('');
  md.push('```text');
  md.push(chosen ? chosen.post.text : '(blocked: no variant passed)');
  md.push('```');
  md.push('');
  md.push('| Variant | Angle | Chars before link | Layer-1 rules | Findings |');
  md.push('|---|---|---|---|---|');
  for (const v of s.variants) {
    const findings = [...v.rules.errors.map((e) => `❌ ${e.rule}: ${e.detail}`), ...v.rules.warnings.map((w) => `⚠️ ${w.rule}: ${w.detail}`)].join('<br>') || '—';
    md.push(`| ${v.index} | ${v.angle} | ${v.post.chars_before_link} | ${v.rules.passed ? '✅ pass' : '❌ blocked'} | ${findings.replace(/\|/g, '\\|')} |`);
  }
  md.push('');
  md.push('<details><summary>Facts captured from the page (grounding set)</summary>');
  md.push('');
  for (const f of s.source.facts) md.push(`- ${f}`);
  md.push('');
  md.push('</details>');
  md.push('');
}
fs.writeFileSync(path.join(ROOT, 'samples', 'sample-posts.md'), md.join('\n'));
for (const s of out) {
  console.log(`${s.id}: chosen=${s.chosen_index} ` + s.variants.map((v) => `v${v.index}:${v.rules.passed ? 'pass' : 'FAIL'}(${v.post.chars_before_link}) ${v.rules.errors.map((e) => e.rule).join(',')} ${v.rules.warnings.map((w) => w.rule + ':' + w.detail).join(',')}`).join(' | '));
}

// Guardrails layer 1: deterministic rules on every variant (structure, length, banned claims,
// grounded numbers/prices, credentials, cited evidence). Survivors go to the LLM judge.
const { safeJsonParse } = require('../../lib/util');
const { assemblePost, checkPost } = require('../../lib/guardrails');
const { buildJudgeRequest } = require('../../lib/prompt');

const { cfg } = $('Config').first(0).json;
const { content } = $('Extract & validate content').first(0).json;
const resp = $input.first().json;
const raw = resp && resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content;
const parsed = safeJsonParse(raw);
if (!parsed || !Array.isArray(parsed.variants) || !parsed.variants.length) {
  throw new Error(`LLM_BAD_OUTPUT: expected {"variants":[...]} but got: ${String(raw).slice(0, 200)}`);
}

const drafts = parsed.variants.slice(0, cfg.variants).map((v, i) => {
  const post = assemblePost(v || {}, content, cfg);
  return { ...post, index: i + 1, rules: checkPost(post, content.llm_context, cfg) };
});
const passing = drafts.filter((d) => d.rules.passed);
return [{
  json: {
    drafts,
    any_passed: passing.length > 0,
    passed_indexes: passing.map((d) => d.index),
    judge_request: passing.length ? buildJudgeRequest(content.llm_context, passing, cfg) : null,
    generation_usage: resp.usage || null,
    model: resp.model || cfg.llm_model,
  },
}];

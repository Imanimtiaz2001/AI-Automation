// Guardrails layer 2 result: publish only a variant that passed BOTH the rules and the LLM judge.
const { safeJsonParse } = require('../../lib/util');
const { finalDecision } = require('../../lib/guardrails');

const rc = $('Guardrails: rule checks').first(0).json;
let judge = null;
let judgeUsage = null;
if ($prevNode.name === 'LLM: compliance judge') {
  const r = $input.first().json;
  judge = safeJsonParse(r && r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content);
  judgeUsage = r.usage || null;
}
const decision = finalDecision(rc.drafts, judge);
const post = decision.passed ? rc.drafts.find((d) => d.index === decision.chosen_index) : null;
const sum = (u) => (u && u.total_tokens) || 0;
return [{
  json: {
    passed: decision.passed,
    reason: decision.reason,
    post,
    report: { reason: decision.reason, chosen_index: decision.chosen_index, variants: decision.variants, judge_raw: judge },
    usage: { generation: rc.generation_usage, judge: judgeUsage, total_tokens: sum(rc.generation_usage) + sum(judgeUsage) },
  },
}];

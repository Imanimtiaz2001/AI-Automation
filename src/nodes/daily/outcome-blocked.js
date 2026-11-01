// Outcome: blocked. No variant passed both guardrail layers, so nothing is published (fail-closed).
const { buildOutcome } = require('../../lib/outcome');

const { cfg, run } = $('Config').first(0).json;
const { content } = $('Extract & validate content').first(0).json;
const claim = $('DB: claim item').first(0).json;
const fd = $input.first().json;
const lines = fd.report.variants.map((v) => {
  const why = [
    ...v.rule_errors.map((e) => `${e.rule}: ${e.detail}`),
    ...v.violations.map((x) => `judge ${x.type}: ${x.text || x.reason || ''}`),
    ...v.unsupported_claims.map((c) => `unsupported: ${c}`),
  ];
  return `V${v.index}: ${why.slice(0, 3).join('; ') || 'not judged'}`;
});
return [{
  json: buildOutcome('blocked', {
    cfg,
    execution_id: run.execution_id,
    post_id: claim.post_id,
    item: { url: content.url, title: content.title },
    reason: fd.reason,
    details: lines.join('\n'),
    details_json: { guardrails: fd.report, llm_usage: fd.usage },
  }),
}];

// Outcome: rejected or expired review. Nothing is published; the item is not retried.
const { buildOutcome } = require('../../lib/outcome');

const { cfg, run } = $('Config').first(0).json;
const { content } = $('Extract & validate content').first(0).json;
const claim = $('DB: claim item').first(0).json;
const fd = $('Guardrails: final decision').first(0).json;
const d = $input.first().json;
return [{
  json: buildOutcome(d.decision === 'review_expired' ? 'review_expired' : 'rejected', {
    cfg,
    execution_id: run.execution_id,
    post_id: claim.post_id,
    item: { url: content.url, title: content.title },
    reason: d.reason,
    post_text: fd.post.text,
    details_json: { review: d },
  }),
}];

// Outcome: success (published, scheduled, or simulated in dry run).
const { buildOutcome } = require('../../lib/outcome');

const { cfg, run } = $('Config').first(0).json;
const { content } = $('Extract & validate content').first(0).json;
const fd = $('Guardrails: final decision').first(0).json;
const claim = $('DB: claim item').first(0).json;

let fb;
if ($('Simulate publish').isExecuted) fb = $('Simulate publish').first(0).json;
else if ($('Check fallback result').isExecuted) fb = $('Check fallback result').first(0).json;
else fb = $('Check publish result').first(0).json;
const permalink = $('Facebook: get permalink').isExecuted ? ($('Facebook: get permalink').first(0).json.permalink_url || null) : null;
let instagram = null;
if ($('Instagram: publish').isExecuted) {
  const r = $('Instagram: publish').first(0).json;
  instagram = r.id && !r.error ? { status: 'published', media_id: r.id } : { status: 'failed', error: (r.error && (r.error.message || r.error)) || 'unknown' };
} else if ($('Instagram: create container').isExecuted) {
  const r = $('Instagram: create container').first(0).json;
  instagram = { status: 'failed', error: (r.error && (r.error.message || r.error)) || 'container not created' };
}
const review = $('Review decision').isExecuted ? $('Review decision').first(0).json : null;

return [{
  json: buildOutcome('success', {
    cfg,
    execution_id: run.execution_id,
    post_id: claim.post_id,
    item: { url: content.url, title: content.title },
    post_text: fd.post.text,
    fb_post_id: fb.post_id,
    fb_photo_id: fb.photo_id,
    fb_permalink: permalink,
    scheduled_for: fb.scheduled_for || null,
    endpoint: fb.endpoint,
    details_json: {
      guardrails: fd.report,
      llm_usage: fd.usage,
      publish: { endpoint: fb.endpoint, simulated: !!fb.simulated, would_send: fb.would_send || null },
      review,
      instagram,
    },
    instagram,
  }),
}];

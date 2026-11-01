// Check publish result: classifies Graph API errors; image problems fall back to a link post.
const { interpretGraphResponse } = require('../../lib/publish');

const { plan } = $('Build publish plan').first(0).json;
const r = $input.first().json; // { body, headers, statusCode }
const res = interpretGraphResponse(r.statusCode, r.body);
if (res.ok) {
  return [{ json: { ok: true, use_fallback: false, post_id: res.post_id, photo_id: res.photo_id, endpoint: plan.primary.endpoint, scheduled_for: plan.scheduled_for } }];
}
if (res.error.code === 'FB_IMAGE_ERROR' && plan.fallback) {
  return [{ json: { ok: false, use_fallback: true, primary_error: res.error, fallback: plan.fallback } }];
}
throw new Error(`${res.error.code}: ${res.error.message}${res.error.graph_code ? ` (Graph code ${res.error.graph_code})` : ''}`);

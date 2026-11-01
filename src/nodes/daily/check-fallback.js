// Check fallback result: the link post is the last attempt; any error here is reported.
const { interpretGraphResponse } = require('../../lib/publish');

const { plan } = $('Build publish plan').first(0).json;
const r = $input.first().json;
const res = interpretGraphResponse(r.statusCode, r.body);
if (!res.ok) throw new Error(`${res.error.code}: ${res.error.message}`);
return [{ json: { ok: true, post_id: res.post_id, photo_id: null, endpoint: 'feed (fallback after image error)', scheduled_for: plan.scheduled_for } }];

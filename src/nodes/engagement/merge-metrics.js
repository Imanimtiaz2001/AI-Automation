// Merge metrics: combines the post fields and the (optional) insights call into one row per post.
const { toB64Json } = require('../../lib/util');
const { classifyGraphError } = require('../../lib/publish');

const targets = $('DB: engagement targets').all(0);
const fields = $('Facebook: reactions, comments, shares').all(0);
const insights = $input.all();

const out = [];
const errors = [];
targets.forEach((t, i) => {
  const f = fields[i] ? fields[i].json : {};
  if (f.error) { errors.push(classifyGraphError(f.error)); return; }
  let clicks = null;
  const ins = insights[i] ? insights[i].json : {};
  if (!ins.error && Array.isArray(ins.data)) {
    const m = ins.data.find((d) => d.name === 'post_clicks');
    const v = m && m.values && m.values[0] && m.values[0].value;
    if (typeof v === 'number') clicks = v;
  }
  const row = {
    post_id: t.json.post_id,
    reactions: (f.reactions && f.reactions.summary && f.reactions.summary.total_count) ?? 0,
    comments: (f.comments && f.comments.summary && f.comments.summary.total_count) ?? 0,
    shares: (f.shares && f.shares.count) ?? 0,
    clicks,
    permalink: f.permalink_url || null,
    is_published: f.is_published !== false,
  };
  out.push({ json: { ...row, db_payload_b64: toB64Json(row) } });
});
if (!out.length && errors.length) {
  const e = errors[0];
  throw new Error(`${e.code}: ${e.message}`); // e.g. expired token -> error workflow alerts
}
return out;

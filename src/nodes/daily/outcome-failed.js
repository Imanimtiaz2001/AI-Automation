// Outcome: failed. Receives the error output of every node that can fail in an expected way.
const { buildOutcome } = require('../../lib/outcome');
const { buildConfig, readEnvSafely, DEFAULTS } = require('../../lib/config');

let cfg;
if ($('Config').isExecuted) cfg = $('Config').first(0).json.cfg;
else {
  const env = readEnvSafely(() => $env);
  try { cfg = buildConfig(env); } catch (e) { cfg = { ...DEFAULTS, telegram_chat_id: env.PW_TELEGRAM_CHAT_ID || '' }; }
}
const stage = $prevNode.name;
const j = $input.first().json || {};
const error = j.error || j;
const content = $('Extract & validate content').isExecuted ? $('Extract & validate content').first(0).json.content : null;
const claim = $('DB: claim item').isExecuted ? $('DB: claim item').first(0).json : null;

return [{
  json: buildOutcome('failed', {
    cfg,
    execution_id: $execution.id,
    stage,
    error,
    post_id: claim ? claim.post_id : null,
    item: content ? { url: content.url, title: content.title } : null,
    details_json: { failed_stage: stage },
  }),
}];

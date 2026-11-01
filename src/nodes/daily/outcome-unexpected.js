// Outcome: unexpected error. Runs from the Error Trigger (this workflow is its own error workflow),
// so crashes outside the handled paths are still logged and alerted. Handled failures are ignored here
// because they were already logged and alerted before the run was marked failed.
const { buildOutcome } = require('../../lib/outcome');
const { buildConfig, readEnvSafely, DEFAULTS } = require('../../lib/config');

const t = $input.first().json || {};
const ex = t.execution || {};
const err = ex.error || {};
const message = err.message || 'unknown error';
if (String(message).includes('[HANDLED]')) return [];

const env = readEnvSafely(() => $env);
let cfg;
try { cfg = buildConfig(env); } catch (e) { cfg = { ...DEFAULTS, telegram_chat_id: env.PW_TELEGRAM_CHAT_ID || '' }; }
return [{
  json: buildOutcome('unexpected', {
    cfg,
    execution_id: ex.id,
    execution_url: ex.url,
    stage: ex.lastNodeExecuted || (err.node && err.node.name) || 'unknown',
    error: { message, description: err.description },
    details_json: { workflow: t.workflow && t.workflow.name, mode: ex.mode },
  }),
}];

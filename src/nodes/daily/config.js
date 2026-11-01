// Config: builds the run configuration from PW_* environment variables (with safe defaults).
const { buildConfig, readEnvSafely } = require('../../lib/config');
const { toB64Json } = require('../../lib/util');

// Optional: edit values here to override environment variables (e.g. { dry_run: false }).
const OVERRIDES = {};

const cfg = buildConfig(readEnvSafely(() => $env), OVERRIDES);
const manual = $('Manual run').isExecuted;
const run = {
  execution_id: String($execution.id),
  trigger_mode: manual ? 'manual' : 'schedule',
  started_at: new Date().toISOString(),
  // Manual runs always go ahead (handy for demos); scheduled slots stop once today's post exists.
  force: manual,
};
const counted = ['published', 'scheduled', 'pending_review', 'approved'].concat(cfg.dry_run ? ['dry_run'] : []);
return [{
  json: {
    cfg,
    run,
    db_payload_b64: toB64Json({
      execution_id: run.execution_id,
      trigger_mode: run.trigger_mode,
      review_mode: cfg.review_mode,
      dry_run: cfg.dry_run,
      timezone: cfg.timezone,
      counted_statuses: counted,
      config: { ...cfg, llm_base_url: cfg.llm_base_url, fb_page_id: cfg.fb_page_id ? 'set' : '' },
    }),
  },
}];

// Build publish plan: photo post (image + caption) with a link-post fallback; optional scheduling.
const { buildPublishPlan } = require('../../lib/publish');

const { cfg } = $('Config').first(0).json;
const { content } = $('Extract & validate content').first(0).json;
const fd = $('Guardrails: final decision').first(0).json;
const plan = buildPublishPlan({ post: fd.post, content, cfg, nowIso: new Date().toISOString() });
return [{ json: { plan, dry_run: cfg.dry_run } }];

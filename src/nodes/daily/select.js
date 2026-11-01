// Select candidates: parses the listing pages, removes anything already used, applies the variety rules.
const { parseListing } = require('../../lib/listing');
const { selectCandidates, weekdayIndexFor } = require('../../lib/select');
const { policyAllows } = require('../../lib/robots');

const { cfg } = $('Config').first(0).json;
const plans = $('Plan listing requests').all(0);
const pages = $('Fetch listing pages').all(0);
const history = ($input.first().json.history) || [];

const fetchErrors = [];
let candidates = [];
pages.forEach((page, i) => {
  const plan = plans[i] ? plans[i].json : null;
  if (!plan) return;
  if (page.json.error || typeof page.json.html !== 'string') {
    const e = page.json.error || {};
    fetchErrors.push(`${plan.type}: ${e.message || e.description || 'no HTML returned'}`);
    return;
  }
  const parsed = parseListing(page.json.html, plan.url, plan.type)
    .map((c) => ({ ...c, robots_allowed: policyAllows(plan.robots, cfg.user_agent, c.url) }));
  candidates = candidates.concat(parsed);
});

if (fetchErrors.length && fetchErrors.length === pages.length) {
  throw new Error(`SITE_DOWN: every listing page failed (${fetchErrors.join('; ')})`);
}
if (!candidates.length) {
  throw new Error('PARSER_BROKEN: listing pages loaded but contained no /article/, /package/ or /answer-detail/ links');
}

const nowIso = new Date().toISOString();
const result = selectCandidates({
  candidates, history, cfg, weekdayIndex: weekdayIndexFor(nowIso, cfg.timezone), limit: cfg.detail_candidates,
});
const summary = {
  preferred_type: result.preferred_type,
  recent_categories: result.recent_categories,
  considered: result.considered,
  eligible: result.eligible,
  rejected: result.rejected,
  fetch_errors: fetchErrors,
};
if (!result.selected.length) return [{ json: { has_candidates: false, summary } }];
return result.selected.map((candidate, rank) => ({ json: { has_candidates: true, rank, candidate, summary } }));

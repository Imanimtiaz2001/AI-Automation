'use strict';

/** Ordered: the first matching rule wins (e.g. "stem cell therapy for knee" is stem-cell, not orthopedics). */
const CATEGORY_RULES = [
  ['hair', /hair[\s-]?(transplant|restoration|loss)|\bfue\b|\bdhi\b|baldness/i],
  ['transplant', /transplant/i],
  ['stem-cell', /stem[\s-]?cell|regenerative|exosome|\bprp\b|platelet/i],
  ['cancer', /cancer|oncolog|tumou?r|chemo|immunotherap|hifu|car[\s-]?t\b|carcinoma|leukemia/i],
  ['fertility', /\bivf\b|fertility|egg[\s-]freezing|surroga|gender[\s-]selection|tubal|vasectomy|infertil|ovar|endometri|adenomyosis/i],
  ['bariatric', /bariatric|gastric|sleeve|bypass|weight[\s-]loss|ozempic|mounjaro|obesity|lap[\s-]band/i],
  ['dental', /dental|dentist|teeth|tooth|implant|veneer|crown|all[\s-]on[\s-]\d|denture|smile|orthodont|root[\s-]canal|full[\s-]mouth/i],
  ['cosmetic', /face[\s-]?lift|tummy[\s-]tuck|abdominoplast|\bbbl\b|butt[\s-]lift|lipo|breast|rhinoplast|nose[\s-]job|eyelid|blepharoplast|mommy[\s-]makeover|body[\s-]contour|plastic[\s-]surg|cosmetic|brazilian|etching|labiaplast|vaginal/i],
  ['addiction-mental-health', /ibogaine|addiction|rehab|ptsd|depression|detox|alcohol|opioid|ketamine|mental[\s-]health/i],
  ['orthopedic', /knee|hip[\s-]|shoulder|spine|spinal|\bacl\b|orthop|joint|arthrit|disc[\s-]/i],
  ['neuro', /brain|parkinson|neuro|\bdbs\b|alzheimer|autism|\bms\b|multiple[\s-]sclerosis|stroke|cerebral/i],
  ['cardiology', /heart|cardi|valve|stent|bypass/i],
  ['eye', /lasik|cataract|\beye\b|vision|retina|glaucoma/i],
  ['wellness-longevity', /wellness|longevity|anti[\s-]?aging|biohack|spa\b|retreat|iv[\s-]therapy/i],
];

function classifyCategory(...texts) {
  const t = texts.filter(Boolean).join(' ');
  for (const [cat, re] of CATEGORY_RULES) if (re.test(t)) return cat;
  return 'general';
}

const RETRYABLE = 'failed';

/**
 * Decides whether a previously seen content key may be used again.
 * "Never post the same URL twice": anything that reached Facebook, is waiting for review,
 * was rejected/blocked, or is being processed is permanently excluded. Only transient failures
 * (attempts < max) are retried, and dry-run rows are ignored once dry-run is switched off.
 */
function isEligible(historyRow, cfg) {
  if (!historyRow) return true;
  if (historyRow.status === RETRYABLE) return (historyRow.attempts || 0) < cfg.max_attempts;
  if (historyRow.status === 'dry_run') return !cfg.dry_run;
  return false;
}

/**
 * Scores all candidates and returns the best N.
 * score = preferred-type bonus (weekday rotation) + freshness (listing position)
 *         - penalty when the treatment category was used in the last 3 posts.
 */
function selectCandidates({ candidates, history, cfg, weekdayIndex, limit }) {
  const byKey = new Map((history || []).map((h) => [h.content_key, h]));
  const recentCategories = (history || [])
    .filter((h) => h.status !== 'failed' && h.category)
    .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
    .slice(0, 3)
    .map((h) => h.category);
  const preferredType = cfg.rotation[weekdayIndex] || 'any';

  const scored = [];
  const rejected = { already_used: 0, robots: 0 };
  for (const c of candidates) {
    if (c.robots_allowed === false) { rejected.robots++; continue; }
    const h = byKey.get(c.content_key);
    if (!isEligible(h, cfg)) { rejected.already_used++; continue; }
    const category = classifyCategory(c.slug, c.title_hint);
    let score = 0;
    const reasons = [];
    if (preferredType === 'any' || c.type === preferredType) { score += 1000; reasons.push(`matches ${preferredType} rotation`); }
    const freshness = Math.max(0, 100 - c.position * 5);
    score += freshness;
    reasons.push(`listing position ${c.position + 1}`);
    if (recentCategories[0] === category) { score -= 400; reasons.push(`category ${category} used in the last post`); }
    else if (recentCategories.includes(category)) { score -= 200; reasons.push(`category ${category} used recently`); }
    if (h && h.status === 'failed') { score -= 50; reasons.push(`retry after ${h.attempts} failed attempt(s)`); }
    scored.push({ ...c, category, score, selection_reason: reasons.join('; '), retry: !!h });
  }
  scored.sort((a, b) => b.score - a.score || a.position - b.position);
  return {
    preferred_type: preferredType,
    recent_categories: recentCategories,
    considered: candidates.length,
    eligible: scored.length,
    rejected,
    selected: scored.slice(0, limit || 1),
  };
}

/** Monday = 0 ... Sunday = 6, in the configured timezone. */
function weekdayIndexFor(dateIso, timezone) {
  const d = new Date(dateIso);
  const name = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'short' }).format(d);
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].indexOf(name);
}

module.exports = { classifyCategory, selectCandidates, isEligible, weekdayIndexFor, CATEGORY_RULES };

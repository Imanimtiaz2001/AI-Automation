'use strict';
const { charLength, normalizeForMatch, collapseWhitespace } = require('./util');
const { numbersIn } = require('./extract');

/**
 * Layer 1 of the guardrails: deterministic, explainable checks that run on every LLM variant.
 * Layer 2 (LLM judge) runs afterwards on the survivors; a post is published only if BOTH pass.
 * Everything fails closed: if anything is missing or unparseable, nothing is published.
 */

// Claims that are never acceptable in a medical-tourism post, even when the source page uses them.
const BANNED = [
  ['outcome_promise', /\bguarantee(d|s)?\b/i, 'guarantee'],
  ['medical_claim', /\bcur(e|es|ed|ing)\b/i, 'cure'],
  ['medical_claim', /\b(heals?|healed)\b/i, 'heal'],
  ['outcome_promise', /\b100\s?(%|percent)/i, '100%'],
  ['outcome_promise', /\b(risk[-\s]?free|no risks?|zero risks?|without (any )?risks?)\b/i, 'risk-free'],
  ['outcome_promise', /\b(painless|pain[-\s]?free)\b/i, 'painless'],
  ['outcome_promise', /\bno (side[-\s]?effects?|downtime|scars?)\b/i, 'no side effects'],
  ['outcome_promise', /\bpermanent(ly)?\s+(results?|fix|solution|cure)\b/i, 'permanent results'],
  ['medical_claim', /\b(miracle|miraculous|magic(al)?)\b/i, 'miracle'],
  ['medical_claim', /\b(clinically\s+)?proven\b/i, 'proven'],
  ['outcome_promise', /\bsuccess\s+rates?\b/i, 'success rate'],
  ['outcome_promise', /\b(you('| wi)ll|will)\s+(look|feel|be|get|achieve|regain|see|walk|live)\b/i, 'promised outcome'],
  ['medical_claim', /\b(reverse[sd]?|reversing|eliminate[sd]?|eradicate[sd]?)\b/i, 'reverse/eliminate'],
  ['unverifiable_superlative', /(\bbest\b|\bcheapest\b|#1\b|\bnumber\s+one\b|\btop[-\s]rated\b|\bworld[-\s]class\b|\bleading\b|\blowest\s+prices?\b)/i, 'superlative'],
  ['outcome_promise', /\b(completely|totally|absolutely|perfectly|100%)\s+safe\b|\bsafest\b/i, 'absolute safety'],
  ['pressure', /\b(act now|limited time|hurry|don'?t miss out|last chance|only \d+ (spots|slots) left|spots (are )?limited|limited (spots|slots|availability)|before prices (rise|go up)|book (now|today))\b/i, 'pressure'],
];

// Credentials/approvals that are allowed only when the source page states them.
const CONDITIONAL_TERMS = [
  /\bFDA\b/, /\bJCI\b/, /\bISO\b/, /\baccredit\w*/i, /\bboard[-\s]certified\b/i, /\bcertified\b/i, /\blicensed\b/i,
];

const HASHTAG_RE = /^#[A-Za-z][A-Za-z0-9_]{1,39}$/;
const UNIT_AFTER = /^\s*[-–]?\s*(\d+\s*)?(%|percent|days?|nights?|weeks?|months?|years?|hours?|hrs?|minutes?|mins?|sessions?|visits?|times|x\b|k\b|usd|dollars?|grafts?|teeth|implants?|cc)\b/i;
const CURRENCY_BEFORE = /(\$|usd|us\$|€|£|eur|gbp|mxn|pesos?)\s*$/i;
const EMOJI_RE = /\p{Extended_Pictographic}/gu;

function assemblePost(variant, content, cfg) {
  const hook = collapseWhitespace(variant.hook);
  const lines = (Array.isArray(variant.lines) ? variant.lines : []).map(collapseWhitespace).filter(Boolean);
  const cta = collapseWhitespace(variant.cta);
  const hashtags = (Array.isArray(variant.hashtags) ? variant.hashtags : [])
    .map((h) => collapseWhitespace(h).replace(/^#?/, '#').replace(/\s+/g, ''));
  const beforeLink = [hook, '', ...lines, '', cta].join('\n').trim();
  const after = [`👉 ${content.url}`, '', hashtags.join(' ')];
  if (cfg.disclaimer) after.push(cfg.disclaimer);
  return {
    hook, lines, cta, hashtags,
    angle: collapseWhitespace(variant.angle || ''),
    evidence: (Array.isArray(variant.evidence) ? variant.evidence : []).map(collapseWhitespace).filter(Boolean),
    text_before_link: beforeLink,
    chars_before_link: charLength(beforeLink),
    text: `${beforeLink}\n\n${after.join('\n')}`,
    link: content.url,
  };
}

function ungroundedNumbers(text, sourceNumbers) {
  const allowed = new Set(sourceNumbers);
  const issues = [];
  const re = /\d[\d,]*(?:\.\d+)?/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const raw = m[0].replace(/,$/, '');
    const n = raw.replace(/,(?=\d{3}\b)/g, '').replace(/\.0+$/, '');
    if (allowed.has(n)) continue;
    const before = text.slice(Math.max(0, m.index - 4), m.index);
    const after = text.slice(m.index + m[0].length, m.index + m[0].length + 12);
    const value = Number(n);
    const looksLikeFact = CURRENCY_BEFORE.test(before) || UNIT_AFTER.test(after) || value > 10 || /[.,]/.test(raw);
    // Small counting words ("3 questions to ask") are style, not facts; anything with a unit, currency
    // or a value above 10 is a fact and must appear in the source page.
    if (looksLikeFact) issues.push(raw);
  }
  return [...new Set(issues)];
}

function evidenceMatch(evidence, sourceNorm) {
  if (!evidence.length) return { matched: 0, total: 0, missing: [] };
  const missing = [];
  let matched = 0;
  for (const e of evidence) {
    const en = normalizeForMatch(e);
    if (!en) continue;
    if (sourceNorm.includes(en)) { matched++; continue; }
    // tolerate small edits: >= 85% of the evidence words appear in the source in order-insensitive form
    const words = en.split(' ').filter((w) => w.length > 2);
    const hits = words.filter((w) => sourceNorm.includes(w)).length;
    if (words.length && hits / words.length >= 0.85) matched++; else missing.push(e);
  }
  return { matched, total: evidence.length, missing };
}

function properNounsNotInSource(text, sourceNorm, cfg) {
  const allow = new Set([cfg.brand_name.toLowerCase(), 'i', 'q&a', 'faq', 'faqs', 'diy']);
  const missing = new Set();
  for (const sentence of text.split(/(?<=[.!?:])\s+|\n+/)) {
    const words = sentence.trim().split(/\s+/);
    words.forEach((w, i) => {
      if (i === 0) return; // sentence-initial capitals are not names
      const clean = w.replace(/^[^A-Za-z]+|[^A-Za-z'’-]+$/g, '');
      if (!/^[A-Z][a-zA-Z'’-]+$/.test(clean)) return;
      const lc = clean.toLowerCase().replace(/['’]s$/, '');
      if (allow.has(lc)) return;
      if (!sourceNorm.includes(lc)) missing.add(clean);
    });
  }
  return [...missing];
}

/**
 * @returns {{passed:boolean, errors:Array<{rule:string,detail:string}>, warnings:Array<{rule:string,detail:string}>}}
 */
function checkPost(post, sourceText, cfg) {
  const errors = [];
  const warnings = [];
  const err = (rule, detail) => errors.push({ rule, detail });
  const warn = (rule, detail) => warnings.push({ rule, detail });
  const sourceNorm = normalizeForMatch(sourceText);
  const sourceNumbers = numbersIn(sourceText);
  const claimText = `${post.text_before_link}\n${post.hashtags.join(' ')}`;

  // Structure
  if (!post.hook) err('structure', 'missing hook');
  if (charLength(post.hook) > 160) err('structure', 'hook longer than 160 characters');
  if (post.lines.length < 2 || post.lines.length > 4) err('structure', `needs 2-4 value lines, got ${post.lines.length}`);
  post.lines.forEach((l, i) => { if (charLength(l) > 140) err('structure', `line ${i + 1} longer than 140 characters`); });
  if (!post.cta) err('structure', 'missing call to action');
  if (post.chars_before_link >= cfg.max_chars_before_link) err('length', `${post.chars_before_link} characters before the link (limit ${cfg.max_chars_before_link})`);
  if (post.hashtags.length < 3 || post.hashtags.length > 5) err('hashtags', `needs 3-5 hashtags, got ${post.hashtags.length}`);
  const badTags = post.hashtags.filter((h) => !HASHTAG_RE.test(h));
  if (badTags.length) err('hashtags', `invalid hashtag(s): ${badTags.join(' ')}`);
  if (new Set(post.hashtags.map((h) => h.toLowerCase())).size !== post.hashtags.length) err('hashtags', 'duplicate hashtags');
  if (!post.text.includes(post.link)) err('structure', 'source link missing');

  // Safety / compliance lexicon
  for (const [type, re, label] of BANNED) {
    const m = claimText.match(re);
    if (m) err(type, `"${m[0]}" (${label})`);
  }
  for (const re of CONDITIONAL_TERMS) {
    const m = claimText.match(re);
    if (m && !new RegExp(re.source, 'i').test(sourceText)) err('unsupported_credential', `"${m[0]}" is not stated in the source`);
  }
  if (/https?:\/\/|www\.|\b[a-z0-9-]+\.(com|net|org|io)\b/i.test(post.text_before_link)) err('structure', 'URL inside the copy (only the source link is allowed)');
  if (/[\w.+-]+@[\w-]+\.\w+/.test(claimText) || /\+?\d[\d\s().-]{8,}\d/.test(post.text_before_link)) err('structure', 'contact details in the copy');
  const emojiCount = (post.text_before_link.match(EMOJI_RE) || []).length;
  if (emojiCount > 4) err('style', `${emojiCount} emojis (max 4)`);
  if (/[A-Z]{6,}/.test(post.text_before_link.replace(/#\S+/g, ''))) warn('style', 'shouting (long all-caps word)');

  // Grounding: every fact-like number (prices, %, durations, anything > 10) must appear in the source.
  const ungrounded = ungroundedNumbers(claimText, sourceNumbers);
  if (ungrounded.length) err('ungrounded_number', `not found in source: ${ungrounded.join(', ')}`);
  if (/(\$|usd|€|£|\bprice|\bcost)/i.test(claimText) && !/\d/.test(sourceText)) err('invented_price', 'price language but the source has no figures');

  // Evidence the model cited must really be in the source (cheap hallucination detector).
  const ev = evidenceMatch(post.evidence, sourceNorm);
  if (ev.total > 0 && ev.matched === 0) err('evidence_not_found', 'none of the cited evidence appears in the source');
  else if (ev.missing.length) warn('evidence_partial', `${ev.missing.length}/${ev.total} evidence quotes not found verbatim`);
  if (ev.total === 0) warn('evidence_missing', 'model cited no evidence');

  // Names/places that do not occur in the source are suspicious; the judge decides.
  const names = properNounsNotInSource(post.text_before_link, sourceNorm, cfg);
  if (names.length) warn('unverified_names', names.join(', '));

  return { passed: errors.length === 0, errors, warnings };
}

/**
 * Combines rule results and the LLM judge into one decision. Fails closed.
 * @param {Array} drafts assembled posts with .index and .rules
 * @param {object|null} judge parsed judge JSON (null if unavailable)
 */
function finalDecision(drafts, judge) {
  const results = (judge && Array.isArray(judge.results)) ? judge.results : null;
  const report = drafts.map((d) => {
    const j = results ? results.find((r) => Number(r.variant) === d.index) : null;
    const unsupported = j && Array.isArray(j.claims) ? j.claims.filter((c) => c && c.supported !== true) : [];
    const violations = j && Array.isArray(j.violations) ? j.violations.filter(Boolean) : [];
    const judged = !!j;
    const judgePass = judged && String(j.verdict).toLowerCase() === 'pass' && unsupported.length === 0 && violations.length === 0;
    return {
      index: d.index,
      angle: d.angle,
      chars_before_link: d.chars_before_link,
      rules_passed: d.rules.passed,
      rule_errors: d.rules.errors,
      rule_warnings: d.rules.warnings,
      judged,
      judge_passed: judgePass,
      unsupported_claims: unsupported.map((c) => c.claim),
      violations,
      claims_checked: j && Array.isArray(j.claims) ? j.claims.length : 0,
      quality: j && Number(j.quality) ? Number(j.quality) : 0,
      passed: d.rules.passed && judgePass,
    };
  });
  const passing = report.filter((r) => r.passed)
    .sort((a, b) => b.quality - a.quality || a.rule_warnings.length - b.rule_warnings.length || a.index - b.index);
  const chosen = passing[0] || null;
  let reason;
  if (chosen) reason = `variant ${chosen.index} passed rules and LLM judge (quality ${chosen.quality}/5)`;
  else if (!drafts.some((d) => d.rules.passed)) reason = 'all variants failed rule checks';
  else if (!results) reason = 'LLM judge unavailable or unparseable (fail-closed)';
  else reason = 'no variant passed the LLM judge';
  return { passed: !!chosen, chosen_index: chosen ? chosen.index : null, reason, variants: report };
}

module.exports = { assemblePost, checkPost, finalDecision, ungroundedNumbers, evidenceMatch, BANNED };

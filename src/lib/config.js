'use strict';
/**
 * Single source of truth for run configuration.
 * Values come from environment variables (PW_*) with safe defaults. Secrets never live here:
 * they are n8n credentials (OpenAI key, Facebook page token, Telegram bot token, Postgres).
 */

const DEFAULTS = {
  dry_run: true,                    // true = simulation: everything runs except the Facebook POST
  review_mode: 'auto',              // 'auto' = publish immediately, 'approval' = human approves a draft first (needs Telegram)
  publish_strategy: 'now',          // 'now' = publish when the run reaches the publish step, 'schedule' = Facebook scheduled post
  schedule_time: '18:00',           // local time used when publish_strategy = 'schedule'
  timezone: 'America/Denver',       // PlacidWay is US-based; used for "one post per day" and scheduling
  post_format: 'photo',             // 'photo' = image + caption (falls back to link post), 'link' = link-preview post
  fb_page_id: '',
  ig_user_id: '',                   // optional: Instagram professional account linked to the Page -> cross-post
  fb_graph_version: 'v23.0',
  fb_graph_base: '',
  llm_base_url: 'https://api.openai.com/v1',
  llm_model: 'gpt-4.1-mini',
  llm_judge_model: '',              // empty = same as llm_model
  llm_temperature: 0.7,
  variants: 3,                      // best-of-N generation
  telegram_chat_id: '',
  notify_on_success: true,
  review_timeout_hours: 20,
  user_agent: 'PlacidWayContentDemoBot/1.0 (+contact: automation-demo@example.com)',
  base_url: 'https://www.placidway.com',
  // Listing pages ordered by "modified date" act as the feed for each content type.
  sources: {
    article: '/search-medical-articles/All/All/1',
    package: '/search-medical-packages/All/All/1',
    answer: '/search-medical-answers/All/All/1',
  },
  // Variety rule: preferred content type per weekday (Mon..Sun). Falls back to any type.
  rotation: ['article', 'package', 'answer', 'article', 'package', 'answer', 'article'],
  detail_candidates: 2,             // how many detail pages we may fetch per run (fallback if the first is unusable)
  request_interval_ms: 1500,        // >= 1000 keeps us under 1 request/second
  max_attempts: 3,                  // transient failures (e.g. Facebook down) are retried on later runs up to this
  max_chars_before_link: 500,
  target_chars_before_link: 420,
  min_body_chars: 400,
  disclaimer: 'General information only, not medical advice.',
  brand_name: 'PlacidWay',
};

const ENV_MAP = {
  PW_DRY_RUN: ['dry_run', 'bool'],
  PW_REVIEW_MODE: ['review_mode', 'enum:auto,approval'],
  PW_PUBLISH_STRATEGY: ['publish_strategy', 'enum:now,schedule'],
  PW_SCHEDULE_TIME: ['schedule_time', 'hhmm'],
  PW_TIMEZONE: ['timezone', 'string'],
  PW_POST_FORMAT: ['post_format', 'enum:photo,link'],
  PW_FB_PAGE_ID: ['fb_page_id', 'string'],
  PW_IG_USER_ID: ['ig_user_id', 'string'],
  PW_FB_GRAPH_VERSION: ['fb_graph_version', 'string'],
  PW_FB_GRAPH_BASE: ['fb_graph_base', 'string'],      // override only for tests/mocks
  PW_LLM_BASE_URL: ['llm_base_url', 'string'],
  PW_LLM_MODEL: ['llm_model', 'string'],
  PW_LLM_JUDGE_MODEL: ['llm_judge_model', 'string'],
  PW_LLM_TEMPERATURE: ['llm_temperature', 'number'],
  PW_VARIANTS: ['variants', 'int:1:5'],
  PW_TELEGRAM_CHAT_ID: ['telegram_chat_id', 'string'],
  PW_NOTIFY_ON_SUCCESS: ['notify_on_success', 'bool'],
  PW_REVIEW_TIMEOUT_HOURS: ['review_timeout_hours', 'int:1:168'],
  PW_USER_AGENT: ['user_agent', 'string'],
  PW_BASE_URL: ['base_url', 'string'],
  PW_ROTATION: ['rotation', 'rotation'],
  PW_DETAIL_CANDIDATES: ['detail_candidates', 'int:1:3'],
  PW_REQUEST_INTERVAL_MS: ['request_interval_ms', 'int:1000:60000'],
  PW_MAX_ATTEMPTS: ['max_attempts', 'int:1:10'],
  PW_DISCLAIMER: ['disclaimer', 'string'],
};

function parseValue(raw, kind, key) {
  const v = String(raw).trim();
  if (kind === 'string') return v;
  if (kind === 'bool') {
    if (/^(1|true|yes|on)$/i.test(v)) return true;
    if (/^(0|false|no|off)$/i.test(v)) return false;
    throw new Error(`CONFIG_INVALID: ${key} must be true/false, got "${v}"`);
  }
  if (kind === 'number') {
    const n = Number(v);
    if (!Number.isFinite(n)) throw new Error(`CONFIG_INVALID: ${key} must be a number`);
    return n;
  }
  if (kind.startsWith('int:')) {
    const [, lo, hi] = kind.split(':').map(Number);
    const n = parseInt(v, 10);
    if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(`CONFIG_INVALID: ${key} must be an integer ${lo}-${hi}`);
    return n;
  }
  if (kind.startsWith('enum:')) {
    const allowed = kind.slice(5).split(',');
    const lv = v.toLowerCase();
    if (!allowed.includes(lv)) throw new Error(`CONFIG_INVALID: ${key} must be one of ${allowed.join('|')}`);
    return lv;
  }
  if (kind === 'hhmm') {
    if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(v)) throw new Error(`CONFIG_INVALID: ${key} must be HH:MM`);
    return v;
  }
  if (kind === 'rotation') {
    const parts = v.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const ok = ['article', 'package', 'answer', 'any'];
    if (parts.length !== 7 || parts.some((p) => !ok.includes(p))) {
      throw new Error(`CONFIG_INVALID: ${key} must list 7 values (Mon..Sun) from ${ok.join('|')}`);
    }
    return parts;
  }
  throw new Error(`unknown kind ${kind}`);
}

/**
 * @param {object} env  process-like env object ($env in n8n). May be empty/undefined when env access is blocked.
 * @param {object} overrides  optional values edited directly in the Config node.
 */
function buildConfig(env, overrides) {
  const cfg = JSON.parse(JSON.stringify(DEFAULTS));
  const e = env || {};
  for (const [envKey, [cfgKey, kind]] of Object.entries(ENV_MAP)) {
    const raw = e[envKey];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    cfg[cfgKey] = parseValue(raw, kind, envKey);
  }
  Object.assign(cfg, overrides || {});
  if (!cfg.llm_judge_model) cfg.llm_judge_model = cfg.llm_model;
  cfg.base_url = cfg.base_url.replace(/\/+$/, '');
  cfg.fb_graph_base = (cfg.fb_graph_base || `https://graph.facebook.com/${cfg.fb_graph_version}`).replace(/\/+$/, '');

  const problems = [];
  if (!cfg.dry_run && !cfg.fb_page_id) problems.push('PW_FB_PAGE_ID is required when PW_DRY_RUN=false');
  if (cfg.max_chars_before_link > 500) problems.push('max_chars_before_link may not exceed 500');
  if (cfg.review_mode === 'approval' && !cfg.telegram_chat_id) problems.push('PW_TELEGRAM_CHAT_ID is required when PW_REVIEW_MODE=approval (drafts are sent there)');
  if (problems.length) throw new Error('CONFIG_INVALID: ' + problems.join('; '));
  return cfg;
}

/** Reads $env defensively: n8n can block env access in nodes (N8N_BLOCK_ENV_ACCESS_IN_NODE). */
function readEnvSafely(getEnv) {
  try {
    const env = getEnv();
    const out = {};
    for (const k of Object.keys(ENV_MAP)) {
      try { if (env[k] !== undefined) out[k] = env[k]; } catch (e) { /* blocked */ }
    }
    return out;
  } catch (e) {
    return {};
  }
}

module.exports = { DEFAULTS, ENV_MAP, buildConfig, readEnvSafely, parseValue };

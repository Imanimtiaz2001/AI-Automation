'use strict';
const { escapeTelegramHtml: esc, truncate, toB64Json, innerApiMessage } = require('./util');
const { classifyGraphError } = require('./publish');

/**
 * Every path through the workflow ends in exactly one "outcome". All outcomes go through the same
 * Finalize run (DB) -> Notify (Telegram) -> Raise (Stop and Error) tail, so logging and alerting
 * cannot be forgotten on a new branch.
 */

const STAGE_CODES = [
  [/robots|listing|plan listings/i, 'SITE_DOWN', 'PlacidWay could not be reached (or robots.txt was unavailable). The run will retry at the next scheduled slot.'],
  [/detail|extract/i, 'NO_VALID_CONTENT', 'Candidate pages could not be fetched or had no usable content.'],
  [/llm|judge|generate/i, 'LLM_ERROR', 'The LLM provider failed after retries.'],
  [/facebook|publish|preflight/i, 'FB_API_ERROR', 'Facebook Graph API call failed.'],
  [/postgres|history|claim|save|record|finalize|run guard|run log|db:/i, 'DB_ERROR', 'The database call failed. Check the Postgres container and credential.'],
];

function errorMessageOf(error) {
  const clean = (m) => String(m).replace(/\s*\[line \d+\]\s*$/, '');
  if (!error) return 'unknown error';
  if (typeof error === 'string') return clean(error);
  const parts = [error.message, error.description].filter(Boolean).map(clean);
  if (error.httpCode && !/^\d{3}\b/.test(parts[0] || '')) parts.unshift(`HTTP ${error.httpCode}`);
  return parts.join(' | ') || JSON.stringify(error).slice(0, 500);
}

// Codes raised deliberately by our own Code nodes ("CODE: message").
const KNOWN_CODES = {
  CONFIG_INVALID: ['Fix the PW_* environment variables and restart n8n.', false],
  SITE_DOWN: ['PlacidWay (or its robots.txt) was unreachable. The run retries at the next scheduled slot today.', true],
  ROBOTS_DISALLOWED: ['robots.txt now disallows the listing pages; the workflow will not crawl them. Review PW_* sources.', false],
  PARSER_BROKEN: ['Listing pages returned no recognizable content links; the site markup or URLs probably changed.', false],
  NO_VALID_CONTENT: ['Candidate pages were unreachable or too thin; other items will be tried on the next run.', true],
  LLM_BAD_OUTPUT: ['The LLM returned unparseable output; the next run retries.', true],
  FB_TOKEN_EXPIRED: ['Generate a new long-lived Page access token and update the "Facebook Page token" credential.', true],
  FB_PERMISSION: ['The token needs pages_manage_posts and pages_read_engagement for this Page.', true],
  FB_RATE_LIMIT: ['Facebook throttled the request; the item will be retried on the next run.', true],
  FB_IMAGE_ERROR: ['Facebook could not use the image and no fallback was possible.', true],
  FB_UNAVAILABLE: ['Facebook was unavailable; the item will be retried on the next run.', true],
  FB_API_ERROR: ['Check the Graph API error message.', true],
  REVIEW_NOTIFY_FAILED: ['The review message could not be sent to Telegram. Check the bot token and chat id.', true],
};

function classifyFailure(stage, error) {
  const msg = errorMessageOf(error);
  const flat = `${msg} ${JSON.stringify(error || {})}`;
  const prefix = msg.match(/^([A-Z][A-Z_]+):/);
  if (prefix && KNOWN_CODES[prefix[1]]) {
    const [hint, retryable] = KNOWN_CODES[prefix[1]];
    return { code: prefix[1], message: msg.slice(prefix[0].length).trim(), hint, retryable };
  }
  const http = error && error.httpCode ? `HTTP ${error.httpCode}: ` : (msg.match(/^(\d{3}) - /) ? `HTTP ${msg.slice(0, 3)}: ` : '');
  const inner = innerApiMessage(error);
  const nice = inner ? `${http}${inner}` : msg;
  if (/facebook|publish|preflight/i.test(stage || '')) {
    const g = classifyGraphError(error);
    return { code: g.code, message: nice, hint: g.hint, retryable: g.retryable };
  }
  if (/llm|judge|generate/i.test(stage || '')) {
    if (/\b401\b|invalid api key|incorrect api key|unauthorized/i.test(flat)) return { code: 'LLM_AUTH', message: nice, hint: 'The LLM API key is missing or invalid. Update the "LLM API key" credential.', retryable: false };
    if (/insufficient_quota|\b429\b|rate limit/i.test(flat)) return { code: 'LLM_RATE_LIMIT', message: nice, hint: 'LLM quota or rate limit hit; retried 3x. Check billing/limits.', retryable: true };
    return { code: 'LLM_ERROR', message: nice, hint: 'The LLM provider failed after 3 attempts; the next scheduled slot retries.', retryable: true };
  }
  for (const [re, code, hint] of STAGE_CODES) if (re.test(stage || '')) return { code, message: msg, hint, retryable: true };
  return { code: 'UNEXPECTED', message: msg, hint: 'Open the execution in n8n for the full stack trace.', retryable: true };
}

function localTime(iso, tz) {
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz || 'UTC', weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', timeZoneName: 'short' }).format(new Date(iso));
  } catch (e) { return iso; }
}

function header(icon, title, cfg) {
  return `${icon} <b>${esc(title)}</b>${cfg && cfg.dry_run ? ' <i>(dry run)</i>' : ''}`;
}

function itemLine(item) {
  if (!item || !item.url) return '';
  return `\n<b>Item:</b> <a href="${esc(item.url)}">${esc(truncate(item.title || item.url, 90))}</a>`;
}

/**
 * @param {string} kind success|skipped|no_content|blocked|rejected|review_expired|failed|unexpected
 */
function buildOutcome(kind, d) {
  const cfg = d.cfg || {};
  const base = {
    kind,
    execution_id: String(d.execution_id || ''),
    chat_id: cfg.telegram_chat_id || '',
    post_id: d.post_id || null,
    raise: false,
    notify: true,
  };
  const item = d.item || null;
  let o;
  switch (kind) {
    case 'success': {
      const status = cfg.dry_run ? 'dry_run' : (d.scheduled_for ? 'scheduled' : 'published');
      const when = d.scheduled_for ? `\n<b>Scheduled for:</b> ${esc(localTime(d.scheduled_for, cfg.timezone))}` : '';
      const link = (d.fb_permalink ? `\n<b>Facebook:</b> <a href="${esc(d.fb_permalink)}">open post</a>` : (d.fb_post_id ? `\n<b>Post ID:</b> ${esc(d.fb_post_id)}` : ''))
        + (d.instagram ? `\n<b>Instagram:</b> ${d.instagram.status === 'published' ? `published (media ${esc(d.instagram.media_id)})` : `⚠️ cross-post failed: ${esc(truncate(String(d.instagram.error), 200))}`}` : '');
      o = {
        run_status: status, post_status: status, notify: cfg.notify_on_success !== false,
        fb_post_id: d.fb_post_id || null, fb_photo_id: d.fb_photo_id || null, fb_permalink: d.fb_permalink || null,
        scheduled_for: d.scheduled_for || null, post_text: d.post_text || null, endpoint: d.endpoint || null,
        text: `${header('✅', status === 'scheduled' ? 'PlacidWay post scheduled' : status === 'dry_run' ? 'PlacidWay post generated' : 'PlacidWay post published', cfg)}${itemLine(item)}${when}${link}\n\n${esc(truncate(d.post_text || '', 900))}`,
      };
      break;
    }
    case 'skipped':
      o = { run_status: 'skipped', post_status: null, notify: false, text: '', error_message: d.reason || 'already posted today' };
      break;
    case 'no_content':
      o = { run_status: 'no_content', post_status: null, error_code: 'NO_CONTENT', error_message: d.reason,
        text: `${header('⚠️', 'No new PlacidWay content to post', cfg)}\n${esc(d.reason || '')}` };
      break;
    case 'blocked':
      o = { run_status: 'blocked', post_status: 'blocked', error_code: 'GUARDRAIL_BLOCKED', error_message: d.reason, post_text: d.post_text || null,
        text: `${header('🛑', 'Post blocked by guardrails', cfg)}${itemLine(item)}\n<b>Why:</b> ${esc(d.reason || '')}\n${esc(truncate(d.details || '', 1200))}\nNothing was published. The item is marked blocked and will not be retried.` };
      break;
    case 'rejected':
    case 'review_expired':
      o = { run_status: kind, post_status: kind, error_message: d.reason || null, post_text: d.post_text || null,
        text: `${header(kind === 'rejected' ? '🚫' : '⌛', kind === 'rejected' ? 'Draft rejected by reviewer' : 'Review window expired', cfg)}${itemLine(item)}\nNothing was published.` };
      break;
    case 'failed':
    case 'unexpected': {
      const f = d.failure || classifyFailure(d.stage, d.error);
      o = { run_status: 'failed', post_status: 'failed', error_code: f.code, error_message: truncate(f.message, 2000), raise: kind === 'failed',
        text: `${header('🔴', 'PlacidWay autopost FAILED', cfg)}\n<b>Stage:</b> ${esc(d.stage || 'unknown')}\n<b>Error:</b> ${esc(f.code)}: ${esc(truncate(f.message, 600))}\n<b>Next step:</b> ${esc(f.hint || '')}${itemLine(item)}\n<b>Execution:</b> ${esc(base.execution_id)}${d.execution_url ? ` (<a href="${esc(d.execution_url)}">open</a>)` : ''}` };
      break;
    }
    default:
      throw new Error(`unknown outcome kind ${kind}`);
  }
  const out = { ...base, ...o };
  if (!out.chat_id) out.notify = false; // alerts still land in pw_run_log and the n8n execution list
  out.db_payload_b64 = toB64Json({
    execution_id: out.execution_id,
    run_status: out.run_status,
    post_status: out.post_status,
    post_id: out.post_id,
    error_code: out.error_code || null,
    error_message: out.error_message || null,
    post_text: out.post_text || null,
    fb_post_id: out.fb_post_id || null,
    fb_photo_id: out.fb_photo_id || null,
    fb_permalink: out.fb_permalink || null,
    scheduled_for: out.scheduled_for || null,
    details: d.details_json || null,
  });
  return out;
}

module.exports = { buildOutcome, classifyFailure, errorMessageOf };

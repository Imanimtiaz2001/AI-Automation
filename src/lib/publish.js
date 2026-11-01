'use strict';

/** Offset (minutes) of a timezone at a given instant, using only Intl (no Luxon needed). */
function tzOffsetMinutes(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
  return Math.round((asUtc - date.getTime()) / 60000);
}

function localDateParts(date, timeZone) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  const [y, m, d] = p.split('-').map(Number);
  return { y, m, d };
}

/**
 * Next occurrence of HH:MM in `timeZone` that is at least `minLeadMinutes` in the future.
 * Facebook requires scheduled_publish_time between 10 minutes and 30 days ahead; we keep a 15 minute margin.
 */
function nextScheduleTime(nowIso, hhmm, timeZone, minLeadMinutes = 15) {
  const now = new Date(nowIso);
  const [hh, mm] = hhmm.split(':').map(Number);
  for (let addDays = 0; addDays < 3; addDays++) {
    const base = new Date(now.getTime() + addDays * 86400000);
    const { y, m, d } = localDateParts(base, timeZone);
    let guess = Date.UTC(y, m - 1, d, hh, mm, 0);
    guess -= tzOffsetMinutes(new Date(guess), timeZone) * 60000;
    // second pass corrects DST transitions
    const corrected = Date.UTC(y, m - 1, d, hh, mm, 0) - tzOffsetMinutes(new Date(guess), timeZone) * 60000;
    if (corrected >= now.getTime() + minLeadMinutes * 60000) return new Date(corrected);
  }
  return new Date(now.getTime() + 60 * 60000);
}

function localDayString(nowIso, timeZone) {
  const { y, m, d } = localDateParts(new Date(nowIso), timeZone);
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Instagram only accepts JPEG via image_url: ask PlacidWay's Cloudflare image endpoint for a JPEG rendition. */
function instagramImage(url) {
  const m = String(url).match(/^(https:\/\/[^/]+\/cdn-cgi\/image\/)([^/]+)\/(.+)$/);
  if (!m) return url;
  const opts = m[2].split(',').filter((o) => !/^format=/.test(o)).concat('format=jpeg').join(',');
  return `${m[1]}${opts}/${m[3]}`;
}

/**
 * Builds the Facebook Graph API calls for this post.
 *  - photo post: POST /{page-id}/photos  {url, caption}  -> image is uploaded by Facebook from the URL
 *  - link post:  POST /{page-id}/feed    {message, link} -> Facebook renders the page's og:image as a preview
 * Scheduling uses published=false + scheduled_publish_time (unix seconds).
 */
function buildPublishPlan({ post, content, cfg, nowIso }) {
  const scheduled = cfg.publish_strategy === 'schedule';
  const when = scheduled ? nextScheduleTime(nowIso, cfg.schedule_time, cfg.timezone) : null;
  const scheduleFields = scheduled ? { published: false, scheduled_publish_time: Math.floor(when.getTime() / 1000) } : { published: true };
  const base = `${cfg.fb_graph_base}/${cfg.fb_page_id || 'PAGE_ID'}`;
  const feed = { endpoint: 'feed', url: `${base}/feed`, body: { message: post.text, link: content.url, ...scheduleFields } };
  const usePhoto = cfg.post_format === 'photo' && !!content.image_url;
  const photo = usePhoto ? { endpoint: 'photos', url: `${base}/photos`, body: { url: content.image_url, caption: post.text, ...scheduleFields } } : null;
  // Instagram (optional cross-post): JPEG image required, links in captions are not clickable.
  let instagram = null;
  if (cfg.ig_user_id && content.image_url) {
    const caption = [post.text_before_link, '', `🔗 Read the full ${content.type === 'answer' ? 'answer' : content.type} on ${cfg.brand_name}.com`, '', post.hashtags.join(' '), cfg.disclaimer].filter((x) => x !== undefined && x !== null).join('\n').trim();
    instagram = {
      create_url: `${cfg.fb_graph_base}/${cfg.ig_user_id}/media`,
      publish_url: `${cfg.fb_graph_base}/${cfg.ig_user_id}/media_publish`,
      body: { image_url: instagramImage(content.image_url), caption: caption.slice(0, 2200) },
    };
  }
  return {
    instagram,
    primary: photo || feed,
    fallback: photo ? feed : null, // photo upload failures (bad image) fall back to a link post
    scheduled,
    scheduled_for: when ? when.toISOString() : null,
    with_image: usePhoto || !!content.image_url, // link posts still show the og:image preview
  };
}

const TOKEN_CODES = new Set([190, 102, 463, 467]);
const PERMISSION_CODES = new Set([10, 200, 210, 220, 230, 299]);
const RATE_CODES = new Set([4, 17, 32, 341, 368, 613]);
const TRANSIENT_CODES = new Set([1, 2]);

/** Classifies a Graph API error from a response body or an n8n error object (code first, text second). */
function classifyGraphError(input) {
  let body = input;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = { raw: body }; } }
  const flat = JSON.stringify(body || {});
  const fb = (body && body.error && typeof body.error === 'object' && body.error.code !== undefined) ? body.error : null;
  // n8n wraps the Graph response as an escaped JSON string inside message/description
  const num = (re) => { const m = flat.match(re); return m ? Number(m[1]) : null; };
  const code = fb ? Number(fb.code) : num(/\\*"code\\*"\s*:\s*(\d+)/);
  const sub = fb ? fb.error_subcode : num(/\\*"error_subcode\\*"\s*:\s*(\d+)/);
  // innermost "message" is the Graph API's own text (outer ones are n8n's "400 - ..." wrappers)
  const msgs = [...flat.matchAll(/\\*"message\\*"\s*:\s*\\*"((?:[^"\\]|\\[^"])*)/g)].map((m) => m[1].replace(/\\+$/, '').replace(/\\+(["/])/g, '$1')).filter((m) => m && !/^\d{3} - $/.test(m));
  const embedded = msgs.length ? msgs[msgs.length - 1] : null;
  const message = (fb && fb.message) || embedded || (body && body.message) || flat.slice(0, 300);
  const out = (c, retryable, hint) => ({ code: c, retryable, graph_code: code, graph_subcode: sub || null, message, hint });

  if (code !== null && !Number.isNaN(code)) {
    if (TOKEN_CODES.has(code) || [458, 459, 460, 463, 464, 467].includes(sub)) return out('FB_TOKEN_EXPIRED', false, 'Generate a new long-lived Page access token and update the "Facebook Page token" credential.');
    if (PERMISSION_CODES.has(code)) return out('FB_PERMISSION', false, 'The token needs pages_manage_posts and pages_read_engagement for this Page.');
    if (RATE_CODES.has(code)) return out('FB_RATE_LIMIT', true, 'Facebook throttled the request; the item will be retried on the next run.');
    if (code === 324 || code === 352 || sub === 2069019 || (code === 100 && /(url|image|photo|picture|media)/i.test(message))) return out('FB_IMAGE_ERROR', true, 'Image could not be fetched or processed; falling back to a link post.');
    if (TRANSIENT_CODES.has(code)) return out('FB_UNAVAILABLE', true, 'Facebook was unavailable; the item will be retried on the next run.');
    return out('FB_API_ERROR', false, 'Check the Graph API error above.');
  }
  if (/Error validating access token|session has expired|access token/i.test(flat)) return out('FB_TOKEN_EXPIRED', false, 'Generate a new long-lived Page access token and update the "Facebook Page token" credential.');
  if (/ETIMEDOUT|ECONNRESET|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|HTTP 5\d\d|status(Code)?\\?"?\s*[:=]\s*\\?"?5\d\d/i.test(flat)) return out('FB_UNAVAILABLE', true, 'Facebook was unavailable; the item will be retried on the next run.');
  return out('FB_API_ERROR', false, 'Check the Graph API error above.');
}

function interpretGraphResponse(statusCode, body) {
  let parsed = body;
  if (typeof parsed === 'string') { try { parsed = JSON.parse(parsed); } catch (e) { parsed = { raw: parsed }; } }
  const ok = Number(statusCode) >= 200 && Number(statusCode) < 300 && parsed && !parsed.error && (parsed.id || parsed.post_id);
  if (ok) {
    return { ok: true, post_id: parsed.post_id || parsed.id, photo_id: parsed.post_id ? parsed.id : null };
  }
  return { ok: false, error: classifyGraphError(parsed && Object.keys(parsed).length ? parsed : { message: `HTTP ${statusCode}` }) };
}

module.exports = { instagramImage, nextScheduleTime, localDayString, tzOffsetMinutes, buildPublishPlan, classifyGraphError, interpretGraphResponse };

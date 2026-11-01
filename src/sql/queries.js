'use strict';
/**
 * Every query takes exactly one parameter: $1 = base64(JSON). Decoding happens in SQL, so values with
 * commas/quotes/emoji are safe and the n8n "Query Parameters" field never has to split values.
 * Each query returns exactly ONE row so the next n8n node always runs (no silent stops on empty results).
 */
const P = `p AS (SELECT convert_from(decode($1, 'base64'), 'UTF8')::jsonb AS j)`;

const RUN_START = `WITH ${P},
ins AS (
  INSERT INTO pw_run_log (execution_id, trigger_mode, review_mode, dry_run, status, details)
  SELECT j->>'execution_id', j->>'trigger_mode', j->>'review_mode', (j->>'dry_run')::boolean, 'running',
         jsonb_build_object('config', j->'config')
  FROM p
  ON CONFLICT (execution_id) DO UPDATE SET status = 'running', started_at = now()
  RETURNING id
)
SELECT (SELECT id FROM ins) AS run_id,
       (SELECT count(*)::int FROM pw_posts, p
         WHERE pw_posts.status IN (SELECT jsonb_array_elements_text(p.j->'counted_statuses'))
           AND (pw_posts.created_at AT TIME ZONE (p.j->>'timezone'))::date = (now() AT TIME ZONE (p.j->>'timezone'))::date
       ) AS posts_today;`;

const HISTORY = `SELECT coalesce(json_agg(json_build_object(
         'content_key', content_key, 'status', status, 'attempts', attempts,
         'category', category, 'created_at', created_at) ORDER BY created_at DESC), '[]'::json) AS history
FROM pw_posts;`;

// Atomic claim: two concurrent runs (schedule + manual) can never process the same item.
const CLAIM = `WITH ${P},
claimed AS (
  INSERT INTO pw_posts (content_key, url, content_type, category, title, summary, image_url, status,
                        claimed_by_execution, selection_reason, source_snapshot)
  SELECT j->>'content_key', j->>'url', j->>'type', j->>'category', j->>'title', j->>'summary', j->>'image_url',
         'processing', j->>'execution_id', j->>'selection_reason', j->'source'
  FROM p
  ON CONFLICT (content_key) DO UPDATE SET
    status = 'processing',
    attempts = CASE WHEN pw_posts.status = 'dry_run' THEN 1 ELSE pw_posts.attempts + 1 END,
    claimed_by_execution = EXCLUDED.claimed_by_execution,
    url = EXCLUDED.url, title = EXCLUDED.title, summary = EXCLUDED.summary, image_url = EXCLUDED.image_url,
    category = EXCLUDED.category, selection_reason = EXCLUDED.selection_reason,
    source_snapshot = EXCLUDED.source_snapshot, last_error = NULL, updated_at = now()
  WHERE (pw_posts.status = 'failed' AND pw_posts.attempts < (SELECT (j->>'max_attempts')::int FROM p))
     OR (pw_posts.status = 'dry_run' AND NOT (SELECT (j->>'dry_run')::boolean FROM p))
  RETURNING id, attempts
),
log AS (
  UPDATE pw_run_log SET content_key = p.j->>'content_key', url = p.j->>'url', title = p.j->>'title',
         details = details || jsonb_build_object('selection', p.j->'selection')
  FROM p WHERE execution_id = p.j->>'execution_id'
  RETURNING 1
)
SELECT (SELECT id FROM claimed) AS post_id, (SELECT attempts FROM claimed) AS attempt, (SELECT count(*) FROM log)::int AS logged;`;

const SAVE_DRAFT = `WITH ${P},
po AS (
  UPDATE pw_posts SET status = 'pending_review', post_text = p.j->>'post_text', variant_angle = p.j->>'angle',
         guardrail_report = p.j->'guardrails', review_token = p.j->>'review_token', updated_at = now()
  FROM p WHERE id = (p.j->>'post_id')::bigint
  RETURNING id
),
r AS (
  UPDATE pw_run_log SET status = 'pending_review', post_text = p.j->>'post_text',
         details = details || jsonb_build_object('guardrails', p.j->'guardrails', 'llm_usage', p.j->'llm_usage')
  FROM p WHERE execution_id = p.j->>'execution_id'
  RETURNING 1
)
SELECT (SELECT id FROM po) AS post_id, (SELECT count(*) FROM r)::int AS logged;`;

const MARK_APPROVED = `WITH ${P},
po AS (
  UPDATE pw_posts SET status = 'approved', updated_at = now()
  FROM p WHERE id = (p.j->>'post_id')::bigint AND status = 'pending_review'
  RETURNING id
)
SELECT (SELECT id FROM po) AS post_id;`;

// Single exit for every run. Upserts the run log (so even a run that failed before it was logged
// is recorded) and moves the claimed post to its final state.
const FINALIZE = `WITH ${P},
r AS (
  INSERT INTO pw_run_log (execution_id, status, error_code, error_message, post_text, fb_post_id, details, finished_at)
  SELECT j->>'execution_id', j->>'run_status', j->>'error_code', j->>'error_message', j->>'post_text', j->>'fb_post_id',
         coalesce(j->'details', '{}'::jsonb), now()
  FROM p
  ON CONFLICT (execution_id) DO UPDATE SET
    status = EXCLUDED.status,
    error_code = EXCLUDED.error_code,
    error_message = EXCLUDED.error_message,
    post_text = coalesce(EXCLUDED.post_text, pw_run_log.post_text),
    fb_post_id = coalesce(EXCLUDED.fb_post_id, pw_run_log.fb_post_id),
    details = pw_run_log.details || EXCLUDED.details,
    finished_at = now(),
    duration_ms = (EXTRACT(EPOCH FROM (now() - pw_run_log.started_at)) * 1000)::int
  RETURNING id
),
po AS (
  UPDATE pw_posts SET
    status = p.j->>'post_status',
    post_text = coalesce(p.j->>'post_text', pw_posts.post_text),
    guardrail_report = coalesce(p.j->'details'->'guardrails', pw_posts.guardrail_report),
    fb_post_id = coalesce(p.j->>'fb_post_id', pw_posts.fb_post_id),
    fb_photo_id = coalesce(p.j->>'fb_photo_id', pw_posts.fb_photo_id),
    fb_permalink = coalesce(p.j->>'fb_permalink', pw_posts.fb_permalink),
    scheduled_for = coalesce((p.j->>'scheduled_for')::timestamptz, pw_posts.scheduled_for),
    published_at = CASE WHEN p.j->>'post_status' = 'published' THEN now() ELSE pw_posts.published_at END,
    last_error = p.j->>'error_message',
    updated_at = now()
  FROM p
  WHERE p.j->>'post_status' IS NOT NULL
    AND pw_posts.status IN ('processing', 'pending_review', 'approved')
    AND (pw_posts.id = (p.j->>'post_id')::bigint
         OR (p.j->>'post_id' IS NULL AND pw_posts.claimed_by_execution = p.j->>'execution_id'))
  RETURNING pw_posts.id
)
SELECT (SELECT count(*) FROM r)::int AS runs_updated, (SELECT count(*) FROM po)::int AS posts_updated;`;

// ---- engagement sync (workflow 02)
const ENGAGEMENT_TARGETS = `SELECT id AS post_id, fb_post_id
FROM pw_posts
WHERE status IN ('published', 'scheduled') AND fb_post_id IS NOT NULL
  AND coalesce(published_at, scheduled_for, created_at) > now() - interval '30 days'
  AND coalesce(scheduled_for, now() - interval '1 minute') < now()
ORDER BY coalesce(published_at, created_at) DESC
LIMIT 50;`;

const ENGAGEMENT_SAVE = `WITH ${P},
po AS (
  UPDATE pw_posts SET reactions = (p.j->>'reactions')::int, comments = (p.j->>'comments')::int,
         shares = (p.j->>'shares')::int, clicks = (p.j->>'clicks')::int,
         fb_permalink = coalesce(p.j->>'permalink', fb_permalink),
         status = CASE WHEN status = 'scheduled' AND (p.j->>'is_published')::boolean THEN 'published' ELSE status END,
         published_at = CASE WHEN status = 'scheduled' AND (p.j->>'is_published')::boolean THEN coalesce(scheduled_for, now()) ELSE published_at END,
         engagement_synced_at = now()
  FROM p WHERE id = (p.j->>'post_id')::bigint
  RETURNING id
),
s AS (
  INSERT INTO pw_engagement_snapshots (post_id, reactions, comments, shares, clicks)
  SELECT (j->>'post_id')::bigint, (j->>'reactions')::int, (j->>'comments')::int, (j->>'shares')::int, (j->>'clicks')::int
  FROM p WHERE EXISTS (SELECT 1 FROM po)
  RETURNING 1
)
SELECT (SELECT count(*) FROM po)::int AS updated;`;

// ---- dashboard (workflow 03)
const DASHBOARD = `SELECT json_build_object(
  'posts', (SELECT coalesce(json_agg(x ORDER BY x.created_at DESC), '[]'::json) FROM (
      SELECT id, content_key, content_type, category, title, url, status, attempts, post_text, image_url,
             fb_post_id, fb_permalink, scheduled_for, published_at, reactions, comments, shares, clicks,
             engagement_synced_at, last_error, created_at,
             guardrail_report->>'reason' AS guardrail_reason
      FROM pw_posts ORDER BY created_at DESC LIMIT 60) x),
  'runs', (SELECT coalesce(json_agg(r ORDER BY r.started_at DESC), '[]'::json) FROM (
      SELECT execution_id, trigger_mode, review_mode, dry_run, status, content_key, title, fb_post_id,
             error_code, error_message, started_at, finished_at, duration_ms
      FROM pw_run_log ORDER BY started_at DESC LIMIT 40) r),
  'stats', (SELECT json_build_object(
      'published', count(*) FILTER (WHERE status = 'published'),
      'scheduled', count(*) FILTER (WHERE status = 'scheduled'),
      'pending_review', count(*) FILTER (WHERE status = 'pending_review'),
      'dry_run', count(*) FILTER (WHERE status = 'dry_run'),
      'blocked', count(*) FILTER (WHERE status = 'blocked'),
      'failed', count(*) FILTER (WHERE status = 'failed'),
      'reactions', coalesce(sum(reactions), 0),
      'comments', coalesce(sum(comments), 0),
      'shares', coalesce(sum(shares), 0),
      'clicks', coalesce(sum(clicks), 0)) FROM pw_posts),
  'run_stats', (SELECT json_build_object(
      'last_7d', count(*),
      'failed_7d', count(*) FILTER (WHERE status = 'failed'),
      'avg_duration_ms', coalesce(round(avg(duration_ms)), 0)) FROM pw_run_log WHERE started_at > now() - interval '7 days'),
  'generated_at', now()
) AS data;`;

module.exports = { RUN_START, HISTORY, CLAIM, SAVE_DRAFT, MARK_APPROVED, FINALIZE, ENGAGEMENT_TARGETS, ENGAGEMENT_SAVE, DASHBOARD };

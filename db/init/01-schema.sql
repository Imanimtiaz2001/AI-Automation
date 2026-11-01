-- PlacidWay social automation: application schema (database "placidway").
-- Runs automatically on first start of the Postgres container (docker-entrypoint-initdb.d),
-- or manually:  psql "$PW_DATABASE_URL" -f db/init/01-schema.sql   (idempotent)

-- One row per piece of PlacidWay content we ever touched. content_key ("article:4617") is the
-- de-duplication key: it is derived from the numeric id in the URL, so slug edits, query strings and
-- the gangnam.placidway.com canonical domain cannot cause a double post. url is UNIQUE as well.
CREATE TABLE IF NOT EXISTS pw_posts (
  id                    BIGSERIAL PRIMARY KEY,
  content_key           TEXT NOT NULL UNIQUE,
  url                   TEXT NOT NULL UNIQUE,
  content_type          TEXT NOT NULL CHECK (content_type IN ('article', 'package', 'answer')),
  category              TEXT,
  title                 TEXT,
  summary               TEXT,
  image_url             TEXT,
  status                TEXT NOT NULL CHECK (status IN (
                          'processing',      -- claimed by a running execution
                          'pending_review',  -- draft sent to a reviewer (approval mode)
                          'approved',        -- reviewer approved, publishing
                          'published',       -- live on Facebook
                          'scheduled',       -- accepted by Facebook as a scheduled post
                          'dry_run',         -- simulation only (never sent to Facebook)
                          'rejected',        -- reviewer rejected
                          'review_expired',  -- nobody reviewed in time
                          'blocked',         -- guardrails refused every variant
                          'failed'           -- transient failure; retried up to PW_MAX_ATTEMPTS
                        )),
  attempts              INT NOT NULL DEFAULT 1,
  claimed_by_execution  TEXT,
  selection_reason      TEXT,
  post_text             TEXT,
  variant_angle         TEXT,
  guardrail_report      JSONB,
  source_snapshot       JSONB,
  review_token          TEXT,
  fb_post_id            TEXT,
  fb_photo_id           TEXT,
  fb_permalink          TEXT,
  scheduled_for         TIMESTAMPTZ,
  published_at          TIMESTAMPTZ,
  last_error            TEXT,
  -- engagement read-back (workflow 02)
  reactions             INT,
  comments              INT,
  shares                INT,
  clicks                INT,
  engagement_synced_at  TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pw_posts_status_idx ON pw_posts (status);
CREATE INDEX IF NOT EXISTS pw_posts_created_idx ON pw_posts (created_at DESC);

-- One row per workflow execution: the run log the brief asks for
-- (item chosen, post text, Facebook post id, status) plus timings, errors and the guardrail report.
CREATE TABLE IF NOT EXISTS pw_run_log (
  id             BIGSERIAL PRIMARY KEY,
  execution_id   TEXT NOT NULL UNIQUE,
  trigger_mode   TEXT,
  review_mode    TEXT,
  dry_run        BOOLEAN,
  status         TEXT NOT NULL,   -- running|published|scheduled|dry_run|pending_review|rejected|review_expired|blocked|skipped|no_content|failed
  content_key    TEXT,
  url            TEXT,
  title          TEXT,
  post_text      TEXT,
  fb_post_id     TEXT,
  error_code     TEXT,
  error_message  TEXT,
  details        JSONB NOT NULL DEFAULT '{}'::jsonb,
  started_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at    TIMESTAMPTZ,
  duration_ms    INT
);
CREATE INDEX IF NOT EXISTS pw_run_log_started_idx ON pw_run_log (started_at DESC);

-- Time series of engagement so trends can be charted (pw_posts keeps only the latest numbers).
CREATE TABLE IF NOT EXISTS pw_engagement_snapshots (
  id           BIGSERIAL PRIMARY KEY,
  post_id      BIGINT NOT NULL REFERENCES pw_posts(id) ON DELETE CASCADE,
  captured_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  reactions    INT,
  comments     INT,
  shares       INT,
  clicks       INT
);
CREATE INDEX IF NOT EXISTS pw_engagement_post_idx ON pw_engagement_snapshots (post_id, captured_at DESC);

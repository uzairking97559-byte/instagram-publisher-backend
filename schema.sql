-- Private, single-owner dashboard. Account ownership is independent of browser sessions.
CREATE TABLE IF NOT EXISTS publisher_sessions (
  session_hash TEXT PRIMARY KEY,
  auth_version TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE TABLE IF NOT EXISTS publisher_oauth_attempts (
  state_hash TEXT PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('facebook', 'instagram')),
  session_hash TEXT NOT NULL REFERENCES publisher_sessions(session_hash) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'complete', 'failed', 'cancelled')),
  expires_at TIMESTAMPTZ NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS publisher_oauth_expiry_idx ON publisher_oauth_attempts(expires_at);
CREATE TABLE IF NOT EXISTS publisher_accounts (
  id BIGSERIAL PRIMARY KEY,
  provider TEXT NOT NULL CHECK (provider IN ('facebook', 'instagram')),
  account_id TEXT NOT NULL,
  username TEXT,
  display_name TEXT,
  encrypted_token TEXT NOT NULL,
  token_expires_at TIMESTAMPTZ,
  token_refreshed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  needs_reconnect BOOLEAN NOT NULL DEFAULT FALSE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(provider, account_id)
);

-- Reel files are uploaded privately, then exposed to Meta through a short-lived
-- unguessable URL. They are deleted after expiry; never store the URL in jobs.
CREATE TABLE IF NOT EXISTS publisher_media_assets (
  id UUID PRIMARY KEY,
  upload_key UUID NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  access_token_hash TEXT NOT NULL UNIQUE,
  file_name TEXT NOT NULL,
  content_type TEXT NOT NULL CHECK (content_type IN ('video/mp4', 'video/quicktime')),
  size_bytes BIGINT NOT NULL CHECK (size_bytes > 0),
  data BYTEA NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS publisher_batches (
  id UUID PRIMARY KEY,
  request_key UUID NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  account_row_id BIGINT REFERENCES publisher_accounts(id) ON DELETE SET NULL,
  account_name TEXT NOT NULL,
  caption TEXT NOT NULL,
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (10, 15, 30)),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 10),
  next_position INTEGER NOT NULL DEFAULT 1,
  next_publish_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_job_id UUID,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'completed')),
  pause_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE publisher_media_assets ADD COLUMN IF NOT EXISTS assigned_batch_id UUID REFERENCES publisher_batches(id) ON DELETE SET NULL;

CREATE TABLE IF NOT EXISTS publisher_jobs (
  id UUID PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  account_row_id BIGINT REFERENCES publisher_accounts(id) ON DELETE SET NULL,
  account_name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'reel')),
  batch_id UUID REFERENCES publisher_batches(id) ON DELETE SET NULL,
  batch_position INTEGER,
  asset_id UUID REFERENCES publisher_media_assets(id) ON DELETE SET NULL,
  scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  creation_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('queued', 'creating', 'processing', 'publishing', 'published', 'failed', 'unknown')),
  published_media_id TEXT,
  error_code TEXT,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Additive migration for existing installations. Drop/re-add the generated
-- status constraint so already-created tables can accept queued jobs.
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS batch_id UUID REFERENCES publisher_batches(id) ON DELETE SET NULL;
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS batch_position INTEGER;
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS asset_id UUID REFERENCES publisher_media_assets(id) ON DELETE SET NULL;
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
ALTER TABLE publisher_jobs DROP CONSTRAINT IF EXISTS publisher_jobs_status_check;
ALTER TABLE publisher_jobs ADD CONSTRAINT publisher_jobs_status_check
  CHECK (status IN ('queued', 'creating', 'processing', 'publishing', 'published', 'failed', 'unknown'));

CREATE INDEX IF NOT EXISTS publisher_jobs_created_idx ON publisher_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS publisher_jobs_batch_idx ON publisher_jobs(batch_id, batch_position);
CREATE INDEX IF NOT EXISTS publisher_batches_due_idx ON publisher_batches(status, next_publish_at);
CREATE INDEX IF NOT EXISTS publisher_media_assets_expiry_idx ON publisher_media_assets(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS publisher_jobs_asset_id_idx ON publisher_jobs(asset_id) WHERE asset_id IS NOT NULL;


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

-- Per-account post target and carry-over count. The carry-over is entered by
-- the owner for posts scheduled/published before this workspace tracked them.
CREATE TABLE IF NOT EXISTS publisher_account_progress (
  account_row_id BIGINT PRIMARY KEY REFERENCES publisher_accounts(id) ON DELETE CASCADE,
  target_count INTEGER NOT NULL DEFAULT 200 CHECK (target_count BETWEEN 1 AND 10000),
  baseline_count INTEGER NOT NULL DEFAULT 0 CHECK (baseline_count >= 0 AND baseline_count <= target_count),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
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
  interval_minutes INTEGER NOT NULL CHECK (interval_minutes IN (5, 10, 15, 20, 30, 45, 60)),
  item_count INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 20),
  next_position INTEGER NOT NULL DEFAULT 1,
  next_publish_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  active_job_id UUID,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued', 'running', 'paused', 'completed', 'cancelled')),
  pause_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Existing deployments may have the earlier ten-item constraint.
ALTER TABLE publisher_batches DROP CONSTRAINT IF EXISTS publisher_batches_item_count_check;
ALTER TABLE publisher_batches ADD CONSTRAINT publisher_batches_item_count_check
  CHECK (item_count BETWEEN 1 AND 20);
-- Gaps between Reels: 5 minutes to 1 hour (keep in sync with BATCH_INTERVALS).
ALTER TABLE publisher_batches DROP CONSTRAINT IF EXISTS publisher_batches_interval_minutes_check;
ALTER TABLE publisher_batches ADD CONSTRAINT publisher_batches_interval_minutes_check
  CHECK (interval_minutes IN (5, 10, 15, 20, 30, 45, 60));
-- The owner can cancel the rest of a batch.
ALTER TABLE publisher_batches DROP CONSTRAINT IF EXISTS publisher_batches_status_check;
ALTER TABLE publisher_batches ADD CONSTRAINT publisher_batches_status_check
  CHECK (status IN ('queued', 'running', 'paused', 'completed', 'cancelled'));

ALTER TABLE publisher_media_assets ADD COLUMN IF NOT EXISTS assigned_batch_id UUID REFERENCES publisher_batches(id) ON DELETE SET NULL;

-- Videos are already compressed. Storing them uncompressed out of line skips a
-- wasted compression buffer on upload and lets substring() read one slice
-- without loading the whole file (lib/media.js). Applies to new uploads.
ALTER TABLE publisher_media_assets ALTER COLUMN data SET STORAGE EXTERNAL;

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
    CHECK (status IN ('queued', 'creating', 'processing', 'publishing', 'published', 'failed', 'unknown', 'cancelled')),
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
-- The video file name is kept on the job so Activity still shows it after the
-- video itself is deleted once the Reel is published or has failed.
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS asset_name TEXT;
UPDATE publisher_jobs j SET asset_name=a.file_name FROM publisher_media_assets a
  WHERE j.asset_id=a.id AND j.asset_name IS NULL;
ALTER TABLE publisher_jobs DROP CONSTRAINT IF EXISTS publisher_jobs_status_check;
ALTER TABLE publisher_jobs ADD CONSTRAINT publisher_jobs_status_check
  CHECK (status IN ('queued', 'creating', 'processing', 'publishing', 'published', 'failed', 'unknown', 'cancelled'));

CREATE INDEX IF NOT EXISTS publisher_jobs_created_idx ON publisher_jobs(created_at DESC);
CREATE INDEX IF NOT EXISTS publisher_jobs_batch_idx ON publisher_jobs(batch_id, batch_position);
-- One account's Activity and its post counts.
CREATE INDEX IF NOT EXISTS publisher_jobs_account_idx ON publisher_jobs(account_row_id, created_at DESC);
CREATE INDEX IF NOT EXISTS publisher_batches_due_idx ON publisher_batches(status, next_publish_at);
CREATE INDEX IF NOT EXISTS publisher_media_assets_expiry_idx ON publisher_media_assets(expires_at);
CREATE UNIQUE INDEX IF NOT EXISTS publisher_jobs_asset_id_idx ON publisher_jobs(asset_id) WHERE asset_id IS NOT NULL;

-- Reel frame (lib/frame.js): per-account look, used when a batch asks for it.
-- Uploaded background/bottom pictures are small images (5 MB at most).
CREATE TABLE IF NOT EXISTS publisher_frame_settings (
  account_row_id BIGINT PRIMARY KEY REFERENCES publisher_accounts(id) ON DELETE CASCADE,
  frame_by_default BOOLEAN NOT NULL DEFAULT TRUE,
  background_preset TEXT,
  background_image BYTEA,
  art_mode TEXT NOT NULL DEFAULT 'default' CHECK (art_mode IN ('default', 'custom', 'none')),
  art_image BYTEA,
  box_percent INTEGER NOT NULL DEFAULT 60 CHECK (box_percent IN (25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80)),
  show_username BOOLEAN NOT NULL DEFAULT TRUE,
  title_lines TEXT[] NOT NULL DEFAULT '{}',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The caption Create post fills in for this account (the owner can still edit it per batch).
ALTER TABLE publisher_frame_settings ADD COLUMN IF NOT EXISTS default_caption TEXT NOT NULL DEFAULT '';
ALTER TABLE publisher_batches ADD COLUMN IF NOT EXISTS frame BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE publisher_batches ADD COLUMN IF NOT EXISTS frame_title TEXT;
-- A framed Reel waits for its video to be rendered (pending -> rendering ->
-- done). If rendering fails, the original video is posted (failed).
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS frame_status TEXT;
ALTER TABLE publisher_jobs DROP CONSTRAINT IF EXISTS publisher_jobs_frame_status_check;
ALTER TABLE publisher_jobs ADD CONSTRAINT publisher_jobs_frame_status_check
  CHECK (frame_status IS NULL OR frame_status IN ('pending', 'rendering', 'done', 'failed'));
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS frame_attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS frame_claim UUID;
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS frame_started_at TIMESTAMPTZ;
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS frame_title TEXT;
ALTER TABLE publisher_jobs ADD COLUMN IF NOT EXISTS frame_error TEXT;
CREATE INDEX IF NOT EXISTS publisher_jobs_frame_idx ON publisher_jobs(frame_status, scheduled_at) WHERE frame_status IN ('pending', 'rendering');
-- Large uploads arrive in parts (lib/publishing.js), stored one row per part
-- so neither the upload nor Meta's ranged reads ever load the whole video.
-- An asset stored this way has data NULL and part_bytes set; until every part
-- has arrived upload_complete is FALSE and no batch or Meta request can use it.
ALTER TABLE publisher_media_assets ALTER COLUMN data DROP NOT NULL;
ALTER TABLE publisher_media_assets ADD COLUMN IF NOT EXISTS part_bytes INTEGER;
ALTER TABLE publisher_media_assets ADD COLUMN IF NOT EXISTS upload_complete BOOLEAN NOT NULL DEFAULT TRUE;
CREATE TABLE IF NOT EXISTS publisher_media_parts (
  asset_id UUID NOT NULL REFERENCES publisher_media_assets(id) ON DELETE CASCADE,
  part INTEGER NOT NULL CHECK (part >= 0),
  data BYTEA NOT NULL,
  PRIMARY KEY (asset_id, part)
);
ALTER TABLE publisher_media_parts ALTER COLUMN data SET STORAGE EXTERNAL;
-- Box sizes from 25% (keep in sync with BOX_PERCENTS in lib/frame.js).
ALTER TABLE publisher_frame_settings DROP CONSTRAINT IF EXISTS publisher_frame_settings_box_percent_check;
ALTER TABLE publisher_frame_settings ADD CONSTRAINT publisher_frame_settings_box_percent_check
  CHECK (box_percent IN (25, 30, 35, 40, 45, 50, 55, 60, 65, 70, 75, 80));

-- DM Sender (lib/dm.js): the owner's message to creators who asked for
-- promotion details, sent from an Instagram login kept in a Browser Use profile.
CREATE TABLE IF NOT EXISTS dm_campaigns (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  profile_id UUID NOT NULL,
  profile_name TEXT,
  message TEXT NOT NULL,
  daily_limit INTEGER NOT NULL DEFAULT 100 CHECK (daily_limit BETWEEN 1 AND 200),
  gap_seconds INTEGER NOT NULL DEFAULT 540 CHECK (gap_seconds BETWEEN 120 AND 3600),
  start_hour INTEGER NOT NULL DEFAULT 8 CHECK (start_hour BETWEEN 0 AND 23),
  end_hour INTEGER NOT NULL DEFAULT 23 CHECK (end_hour BETWEEN 1 AND 24),
  stop_after INTEGER CHECK (stop_after IS NULL OR stop_after BETWEEN 1 AND 1000),
  sent_since_start INTEGER NOT NULL DEFAULT 0,
  consecutive_errors INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'paused' CHECK (status IN ('running', 'paused', 'completed')),
  pause_reason TEXT,
  pause_detail TEXT,
  next_send_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- The proxy country the campaign's browser uses, or 'none' for Browser Use's
-- own connection (no proxy data to pay for).
ALTER TABLE dm_campaigns ADD COLUMN IF NOT EXISTS proxy TEXT NOT NULL DEFAULT 'in' CHECK (proxy ~ '^([a-z]{2}|none)$');
CREATE TABLE IF NOT EXISTS dm_targets (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES dm_campaigns(id) ON DELETE CASCADE,
  username TEXT NOT NULL CHECK (username ~ '^[a-z0-9._]{1,30}$'),
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'skipped', 'failed')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (campaign_id, username)
);
CREATE INDEX IF NOT EXISTS dm_targets_queue_idx ON dm_targets(campaign_id, status, position);
CREATE INDEX IF NOT EXISTS dm_targets_username_idx ON dm_targets(username, status);
-- One Browser Use cloud browser per row, with what it cost (USD).
CREATE TABLE IF NOT EXISTS dm_browsers (
  id UUID PRIMARY KEY,
  profile_id UUID NOT NULL,
  campaign_id BIGINT REFERENCES dm_campaigns(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'stopped')),
  dms_sent INTEGER NOT NULL DEFAULT 0,
  proxy_mb NUMERIC NOT NULL DEFAULT 0,
  proxy_cost_usd NUMERIC NOT NULL DEFAULT 0,
  browser_cost_usd NUMERIC NOT NULL DEFAULT 0,
  started_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  stopped_at TIMESTAMPTZ
);
CREATE INDEX IF NOT EXISTS dm_browsers_campaign_idx ON dm_browsers(campaign_id);
-- Replies (lib/dm.js), per Instagram account (Browser Use profile): chats
-- where the other person wrote last, and the answers the owner types on the
-- website. dm_inboxes keeps each account's last check and a pending request.
CREATE TABLE IF NOT EXISTS dm_inboxes (
  profile_id UUID PRIMARY KEY,
  account TEXT,
  check_requested_at TIMESTAMPTZ,
  checked_at TIMESTAMPTZ,
  check_status TEXT,
  check_detail TEXT,
  retry_at TIMESTAMPTZ
);
CREATE TABLE IF NOT EXISTS dm_replies (
  id BIGSERIAL PRIMARY KEY,
  profile_id UUID NOT NULL,
  thread TEXT NOT NULL,
  username TEXT CHECK (username IS NULL OR username ~ '^[a-z0-9._]{1,30}$'),
  name TEXT,
  row_key TEXT NOT NULL,
  text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'answered', 'done')),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (profile_id, thread)
);
-- 'undelivered': Instagram's "could not be sent" notice, not a reply (hidden).
ALTER TABLE dm_replies DROP CONSTRAINT IF EXISTS dm_replies_status_check;
ALTER TABLE dm_replies ADD CONSTRAINT dm_replies_status_check CHECK (status IN ('new', 'answered', 'done', 'undelivered'));
CREATE INDEX IF NOT EXISTS dm_replies_key_idx ON dm_replies(profile_id, row_key);
CREATE TABLE IF NOT EXISTS dm_outbox (
  id BIGSERIAL PRIMARY KEY,
  reply_id BIGINT NOT NULL REFERENCES dm_replies(id) ON DELETE CASCADE,
  profile_id UUID NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'failed')),
  reason TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  -- Set when a send was cut off by a restart: retried only if not already in the chat.
  resume BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS dm_outbox_queue_idx ON dm_outbox(profile_id, status, id);
CREATE INDEX IF NOT EXISTS dm_outbox_reply_idx ON dm_outbox(reply_id);
-- Only one running copy of the service sends DMs (a deploy briefly runs two).
CREATE TABLE IF NOT EXISTS dm_worker_lease (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  owner TEXT NOT NULL,
  expires_at TIMESTAMPTZ NOT NULL
);

-- Creator list check: which usernames are still professional accounts and
-- when they last posted (Instagram Business Discovery, see lib/checks.js).
CREATE TABLE IF NOT EXISTS creator_checks (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  active_days INTEGER NOT NULL DEFAULT 30 CHECK (active_days BETWEEN 1 AND 365),
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'done')),
  pause_reason TEXT,
  not_found_streak INTEGER NOT NULL DEFAULT 0,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS creator_check_items (
  id BIGSERIAL PRIMARY KEY,
  check_id BIGINT NOT NULL REFERENCES creator_checks(id) ON DELETE CASCADE,
  username TEXT NOT NULL CHECK (username ~ '^[a-z0-9._]{1,30}$'),
  position INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'found', 'not_found', 'error')),
  followers INTEGER,
  media_count INTEGER,
  last_post_at TIMESTAMPTZ,
  attempts INTEGER NOT NULL DEFAULT 0,
  checked_at TIMESTAMPTZ,
  UNIQUE (check_id, username)
);
CREATE INDEX IF NOT EXISTS creator_check_items_queue_idx ON creator_check_items(check_id, status, position);

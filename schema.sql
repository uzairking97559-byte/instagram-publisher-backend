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
CREATE TABLE IF NOT EXISTS publisher_jobs (
  id UUID PRIMARY KEY,
  request_key TEXT NOT NULL UNIQUE,
  payload_hash TEXT NOT NULL,
  account_row_id BIGINT REFERENCES publisher_accounts(id) ON DELETE SET NULL,
  account_name TEXT NOT NULL,
  media_type TEXT NOT NULL CHECK (media_type IN ('image', 'reel')),
  creation_id TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'creating'
    CHECK (status IN ('creating', 'processing', 'publishing', 'published', 'failed', 'unknown')),
  published_media_id TEXT,
  error_code TEXT,
  next_check_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS publisher_jobs_created_idx ON publisher_jobs(created_at DESC);


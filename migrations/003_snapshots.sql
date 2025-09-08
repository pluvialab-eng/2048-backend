-- migrations/003_snapshots.sql
CREATE TABLE IF NOT EXISTS snapshots (
  user_id TEXT PRIMARY KEY,
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_updated_at TIMESTAMPTZ,
  server_updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_server_updated_at
  ON snapshots (server_updated_at);

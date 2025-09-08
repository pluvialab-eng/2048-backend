-- migrations/003_snapshots.sql
-- Sunucuda tutabileceğin ham snapshot arşivi (İSTEĞE BAĞLI).
-- Tipler profiles ile aynı olsun: INTEGER player_id.
DROP TABLE IF EXISTS snapshots CASCADE;

CREATE TABLE snapshots (
  player_id          INTEGER PRIMARY KEY,
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_updated_at  TIMESTAMPTZ,
  server_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_snapshots_server_updated_at
  ON snapshots (server_updated_at);

-- =========================
-- 003_snapshots.sql — IDEMPOTENT
-- =========================

CREATE TABLE IF NOT EXISTS snapshots (
  player_id          INTEGER PRIMARY KEY,
  data               JSONB NOT NULL DEFAULT '{}'::jsonb,
  client_updated_at  TIMESTAMPTZ,
  server_updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name = 'snapshots'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'player_id'
  ) THEN
    ALTER TABLE snapshots
      ADD CONSTRAINT fk_snapshots_player
      FOREIGN KEY (player_id) REFERENCES players(id)
      ON DELETE CASCADE;
  END IF;
END$$;

CREATE INDEX IF NOT EXISTS idx_snapshots_server_updated_at
  ON snapshots (server_updated_at);

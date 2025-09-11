-- migrations/002_profiles.sql
-- INT player_id + JSONB data. UUID players.id ile FK VERMEYİZ (tip uyuşmazlığı).
DROP TABLE IF EXISTS profiles CASCADE;

CREATE TABLE profiles (
  player_id   INTEGER PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

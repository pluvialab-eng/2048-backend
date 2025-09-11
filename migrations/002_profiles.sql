-- migrations/002_profiles.sql — IDEMPOTENT

CREATE TABLE IF NOT EXISTS profiles (
  player_id   INTEGER PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_updated_at_idx ON profiles(updated_at);

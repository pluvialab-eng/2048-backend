-- migrations/002_profiles.sql
DROP TABLE IF EXISTS profiles CASCADE;

CREATE TABLE profiles (
    player_id INTEGER PRIMARY KEY,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

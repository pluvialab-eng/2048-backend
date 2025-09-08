-- migrations/002_profiles.sql
CREATE TABLE IF NOT EXISTS profiles (
    player_id INTEGER PRIMARY KEY REFERENCES players(id) ON DELETE CASCADE,
    data JSONB NOT NULL DEFAULT '{}'::jsonb,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

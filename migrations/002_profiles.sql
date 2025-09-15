-- =========================
-- 002_profiles.sql — IDEMPOTENT
-- =========================

CREATE TABLE IF NOT EXISTS profiles (
  player_id   INTEGER PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- (Varsa) FK ekle: profiles.player_id -> players(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
    WHERE tc.table_name = 'profiles'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'player_id'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT fk_profiles_player
      FOREIGN KEY (player_id) REFERENCES players(id)
      ON DELETE CASCADE;
  END IF;
END$$;

-- Emniyet: data NOT NULL + DEFAULT '{}' (eski tablolarda yoksa)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='profiles' AND column_name='data'
  ) THEN
    ALTER TABLE profiles
      ALTER COLUMN data SET DEFAULT '{}'::jsonb,
      ALTER COLUMN data SET NOT NULL;
  END IF;
END$$;

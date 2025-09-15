-- =========================
-- 002_profiles.sql — IDEMPOTENT (backfill + FK)
-- =========================

-- 1) profiles tablosu yoksa oluştur
CREATE TABLE IF NOT EXISTS profiles (
  player_id   INTEGER PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- 2) Emniyet: data NOT NULL + DEFAULT '{}' (eski tablolarda yoksa)
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

-- 3) FK eklemeden ÖNCE: profiles içindeki sahipsiz player_id'ler için players'ı backfill et
--    (coins varsa profiles.data->>'coins' üzerinden başlatılır, yoksa 0)
INSERT INTO players (id, google_sub, pgs_player_id, display_name, country_code, coins, created_at, updated_at)
SELECT DISTINCT
  p.player_id,
  NULL, NULL, NULL, NULL,
  COALESCE(NULLIF(p.data->>'coins','')::INT, 0),
  now(), now()
FROM profiles p
LEFT JOIN players pl ON pl.id = p.player_id
WHERE p.player_id IS NOT NULL
  AND pl.id IS NULL;

-- 4) (Varsa) FK ekle: profiles.player_id -> players(id)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    JOIN information_schema.key_column_usage kcu
      ON tc.constraint_name = kcu.constraint_name
     AND tc.table_schema   = kcu.table_schema
    WHERE tc.table_schema = 'public'
      AND tc.table_name   = 'profiles'
      AND tc.constraint_type = 'FOREIGN KEY'
      AND kcu.column_name = 'player_id'
  ) THEN
    ALTER TABLE profiles
      ADD CONSTRAINT fk_profiles_player
      FOREIGN KEY (player_id) REFERENCES players(id)
      ON DELETE CASCADE;
  END IF;
END$$;

-- 5) (opsiyonel) index örneği
-- CREATE INDEX IF NOT EXISTS idx_profiles_coins ON profiles (((data->>'coins')::INT));

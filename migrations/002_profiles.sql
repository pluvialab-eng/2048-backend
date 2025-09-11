-- migrations/002_profiles.sql — IDEMPOTENT

CREATE TABLE IF NOT EXISTS profiles (
  player_id   INTEGER PRIMARY KEY,
  data        JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS profiles_updated_at_idx ON profiles(updated_at);

-- -----------------------------
-- COINS ANAHTARINI GARANTİLE
-- -----------------------------

-- 1) Trigger fonksiyonu: insert/update sırasında data.coins yoksa 0 yazar (varsa dokunmaz)
DO $$
BEGIN
  CREATE OR REPLACE FUNCTION ensure_profile_coins()
  RETURNS trigger AS $f$
  BEGIN
    IF NEW.data IS NULL THEN
      NEW.data := '{}'::jsonb;
    END IF;

    -- coins anahtarı yoksa 0 ekle
    IF NOT (NEW.data ? 'coins') THEN
      NEW.data := jsonb_set(NEW.data, '{coins}', to_jsonb(0), true);
    END IF;

    NEW.updated_at := now();
    RETURN NEW;
  END;
  $f$ LANGUAGE plpgsql;
END$$;

-- 2) Tetikleyiciler
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_profiles_coins_ins'
  ) THEN
    CREATE TRIGGER trg_profiles_coins_ins
      BEFORE INSERT ON profiles
      FOR EACH ROW
      EXECUTE FUNCTION ensure_profile_coins();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger WHERE tgname = 'trg_profiles_coins_upd'
  ) THEN
    CREATE TRIGGER trg_profiles_coins_upd
      BEFORE UPDATE ON profiles
      FOR EACH ROW
      EXECUTE FUNCTION ensure_profile_coins();
  END IF;
END$$;

-- 3) Geriye dönük doldurma: coins anahtarı olmayan mevcut satırlara coins=0 yaz
UPDATE profiles
SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{coins}', to_jsonb(0), true),
    updated_at = now()
WHERE (data->>'coins') IS NULL;

-- =========================
-- 001_init.sql (INT player_id mimarisi)
-- =========================

-- Sıfırdan uyumlu şema için (veri yoksa tavsiye edilir)
DROP TABLE IF EXISTS coin_ledger CASCADE;
DROP TABLE IF EXISTS runs CASCADE;
DROP TABLE IF EXISTS progress CASCADE;
DROP TABLE IF EXISTS players CASCADE;

-- players: uygulamanın ürettiği deterministik kimlik (INTEGER)
CREATE TABLE players (
  id            INTEGER PRIMARY KEY,          -- makePlayerIdFromSub(sub)
  google_sub    TEXT UNIQUE,                  -- Google 'sub'
  pgs_player_id TEXT UNIQUE,                  -- (opsiyonel) PGS player id
  display_name  TEXT,
  country_code  TEXT,
  coins         INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

-- game_mode enum yoksa oluştur
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'game_mode') THEN
    CREATE TYPE game_mode AS ENUM ('classic4','size5','size6','time60');
  END IF;
END$$;

-- mod başına tek satır (upsert edilebilir)
CREATE TABLE progress (
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode        game_mode NOT NULL,
  best_score  INT NOT NULL DEFAULT 0,
  best_tile   INT NOT NULL DEFAULT 0,
  games_played INT NOT NULL DEFAULT 0,
  total_moves BIGINT NOT NULL DEFAULT 0,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, mode)
);

-- tek tek maç geçmişi / skor koşuları
CREATE TABLE runs (
  id         BIGSERIAL PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode       game_mode NOT NULL,
  score      INT NOT NULL,
  max_tile   INT NOT NULL,
  duration_ms BIGINT,
  moves      INT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- coin hareketleri (audit)
CREATE TABLE coin_ledger (
  id         BIGSERIAL PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  delta      INT      NOT NULL,     -- +/-
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

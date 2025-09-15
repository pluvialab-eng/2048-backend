-- =========================
-- 001_init.sql (INT player_id mimarisi) — IDEMPOTENT
-- =========================

CREATE TABLE IF NOT EXISTS players (
  id            INTEGER PRIMARY KEY,          -- makePlayerIdFromSub(sub)
  google_sub    TEXT UNIQUE,
  pgs_player_id TEXT UNIQUE,
  display_name  TEXT,
  country_code  TEXT,
  coins         INT NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_login_at TIMESTAMPTZ
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='players' AND column_name='coins'
  ) THEN
    ALTER TABLE players ADD COLUMN coins INT NOT NULL DEFAULT 0;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='players' AND column_name='updated_at'
  ) THEN
    ALTER TABLE players ADD COLUMN updated_at TIMESTAMPTZ NOT NULL DEFAULT now();
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name='players' AND column_name='last_login_at'
  ) THEN
    ALTER TABLE players ADD COLUMN last_login_at TIMESTAMPTZ;
  END IF;
END$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'game_mode') THEN
    CREATE TYPE game_mode AS ENUM ('classic4','size5','size6','time60');
  END IF;
END$$;

CREATE TABLE IF NOT EXISTS progress (
  player_id    INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode         game_mode NOT NULL,
  best_score   INT NOT NULL DEFAULT 0,
  best_tile    INT NOT NULL DEFAULT 0,
  games_played INT NOT NULL DEFAULT 0,
  total_moves  BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (player_id, mode)
);

CREATE TABLE IF NOT EXISTS runs (
  id          BIGSERIAL PRIMARY KEY,
  player_id   INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  mode        game_mode NOT NULL,
  score       INT NOT NULL,
  max_tile    INT NOT NULL,
  duration_ms BIGINT,
  moves       INT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS coin_ledger (
  id         BIGSERIAL PRIMARY KEY,
  player_id  INTEGER NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  delta      INT NOT NULL,
  reason     TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_runs_player_time   ON runs(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_progress_updated   ON progress(updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_coin_ledger_player ON coin_ledger(player_id, created_at DESC);

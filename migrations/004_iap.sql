-- =========================
-- 004_iap.sql — IDEMPOTENT
-- =========================

CREATE TABLE IF NOT EXISTS iap_tokens (
  id           BIGSERIAL PRIMARY KEY,
  player_id    INTEGER NOT NULL,
  product_id   TEXT NOT NULL,
  token        TEXT NOT NULL,
  amount       INT  NOT NULL DEFAULT 0,
  state        TEXT NOT NULL DEFAULT 'credited',   -- credited | rejected | ...
  raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM information_schema.table_constraints tc
    WHERE tc.table_name = 'iap_tokens'
      AND tc.constraint_type = 'FOREIGN KEY'
  ) THEN
    IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name='profiles') THEN
      ALTER TABLE iap_tokens
        ADD CONSTRAINT fk_iap_tokens_profile
        FOREIGN KEY (player_id) REFERENCES profiles(player_id) ON DELETE CASCADE;
    ELSE
      ALTER TABLE iap_tokens
        ADD CONSTRAINT fk_iap_tokens_player
        FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE;
    END IF;
  END IF;
END$$;

CREATE UNIQUE INDEX IF NOT EXISTS iap_tokens_token_uidx ON iap_tokens(token);
CREATE INDEX IF NOT EXISTS idx_iap_tokens_player ON iap_tokens(player_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_iap_tokens_state  ON iap_tokens(state);

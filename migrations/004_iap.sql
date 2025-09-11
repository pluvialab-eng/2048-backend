-- 004_iap.sql (INTEGER şema) — IDEMPOTENT

CREATE TABLE IF NOT EXISTS iap_tokens (
  id BIGSERIAL PRIMARY KEY,
  player_id INTEGER NOT NULL REFERENCES profiles(player_id) ON DELETE CASCADE,
  product_id TEXT NOT NULL,
  token TEXT NOT NULL,
  amount INT NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'credited',   -- credited | rejected
  raw_response JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (token)
);

CREATE INDEX IF NOT EXISTS iap_tokens_player_idx ON iap_tokens(player_id);

// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { OAuth2Client } from "google-auth-library"; // ← EKLENDİ

const { Pool } = pkg;

const {
  DATABASE_URL,
  JWT_SECRET = "change-me",
  ALLOWED_ORIGIN = "*",
  PORT = 8080,
  DATABASE_SSL,
  // ← EKLENDİ: Google Web Client bilgileri
  GOOGLE_WEB_CLIENT_ID,
  GOOGLE_WEB_CLIENT_SECRET,
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// ------------------- MIGRATIONS -------------------
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function runMigrations() {
  try {
    let files = await fs.readdir(MIGRATIONS_DIR);
    files = files.filter((f) => f.toLowerCase().endsWith(".sql")).sort();
    for (const f of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), "utf8");
      console.log(`[migrate] running: ${f}`);
      await pool.query(sql);
      console.log(`[migrate] done: ${f}`);
    }
    console.log("[migrate] all migrations complete.");
  } catch (e) {
    console.error("[migrate] failed:", e);
  }
}

// ------------------- HELPERS -------------------
function getPlayerFromReq(req) {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("No token");
  const token = m[1];
  const payload = jwt.verify(token, JWT_SECRET);
  if (!payload?.playerId) throw new Error("Invalid token payload");
  return payload; // { playerId: <INTEGER> }
}

function requireAuth(req, res, next) {
  try {
    req.player = getPlayerFromReq(req);
    next();
  } catch {
    return res.status(401).json({ error: "unauthorized" });
  }
}

app.get("/health", (_req, res) => res.json({ ok: true }));

// ------------------- AUTH -------------------
// Google server-side exchange için OAuth client (redirect 'postmessage')
const oauthClient =
  GOOGLE_WEB_CLIENT_ID && GOOGLE_WEB_CLIENT_SECRET
    ? new OAuth2Client(GOOGLE_WEB_CLIENT_ID, GOOGLE_WEB_CLIENT_SECRET, "postmessage")
    : null;

/**
 * POST /auth/google
 * Body: { authCode }
 * - authCode -> tokens
 * - id_token doğrulanır, Google 'sub' (google_id) alınır
 * - players upsert
 * - profiles satırı garanti
 * - JWT üret: { playerId } (requireAuth ile uyumlu)
 */
app.post("/auth/google", async (req, res) => {
  try {
    const { authCode } = req.body || {};
    if (!authCode) return res.status(400).json({ error: "authCode_required" });

    if (!oauthClient) {
      console.warn("[auth] GOOGLE_WEB_CLIENT_ID/SECRET missing");
      return res.status(500).json({ error: "server_not_configured" });
    }

    // 1) authCode -> tokens
    const { tokens } = await oauthClient.getToken(authCode);

    // 2) id_token doğrula
    if (!tokens.id_token) {
      return res.status(400).json({ error: "no_id_token" });
    }
    const ticket = await oauthClient.verifyIdToken({
      idToken: tokens.id_token,
      audience: GOOGLE_WEB_CLIENT_ID,
    });
    const payload = ticket.getPayload() || {};
    const sub = payload.sub; // Google unique id
    const name = payload.name || null;
    const picture = payload.picture || null;
    const email = payload.email || null;

    if (!sub) return res.status(400).json({ error: "invalid_id_token" });

    // 3) players upsert
    const upsertSql = `
      INSERT INTO players (google_id, display_name, photo_url)
      VALUES ($1, $2, $3)
      ON CONFLICT (google_id) DO UPDATE
        SET display_name = COALESCE(EXCLUDED.display_name, players.display_name),
            photo_url    = COALESCE(EXCLUDED.photo_url, players.photo_url)
      RETURNING id, google_id, display_name, photo_url
    `;
    const { rows } = await pool.query(upsertSql, [sub, name, picture]);
    const player = rows[0];

    // 4) profiles satırı garanti
    await pool.query(
      `INSERT INTO profiles (player_id, data, updated_at)
       VALUES ($1, '{}'::jsonb, now())
       ON CONFLICT (player_id) DO NOTHING`,
      [player.id]
    );

    // 5) JWT üret — payload { playerId }
    const token = jwt.sign({ playerId: player.id }, JWT_SECRET, { expiresIn: "30d" });

    return res.json({
      token,
      player: {
        id: player.id,
        google_id: player.google_id,
        name: player.display_name,
        photo_url: player.photo_url,
        email,
      },
    });
  } catch (err) {
    // Google tarafı hata verirse çoğu zaman 400 invalid_grant vb.
    console.error("auth_google_failed:", err?.response?.data || err);
    const status = err?.response?.status || 400;
    return res.status(status).json({ error: "auth_exchange_failed" });
  }
});

// ------------------- SYNC -------------------
// GET snapshot
app.get("/sync/snapshot", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;

    const q = `
      SELECT data, updated_at
      FROM profiles
      WHERE player_id = $1::int
    `;
    const { rows } = await pool.query(q, [playerId]);

    if (rows.length === 0) {
      const ins = `
        INSERT INTO profiles (player_id, data, updated_at)
        VALUES ($1::int, '{}'::jsonb, now())
        ON CONFLICT (player_id) DO NOTHING
        RETURNING data, updated_at
      `;
      const r2 = await pool.query(ins, [playerId]);
      if (r2.rows.length > 0) return res.json(r2.rows[0]);

      const r3 = await pool.query(q, [playerId]);
      return res.json(r3.rows[0] ?? { data: {}, updated_at: new Date().toISOString() });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("snapshot_failed:", err);
    return res.status(500).json({ error: "snapshot_failed" });
  }
});

// POST merge
app.post("/sync/merge", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    const body = req.body || {};
    const data = body.data;

    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "no_data" });
    }

    const q = `
      INSERT INTO profiles (player_id, data, updated_at)
      VALUES ($1::int, $2::jsonb, now())
      ON CONFLICT (player_id) DO UPDATE
      SET
        data = COALESCE(profiles.data, '{}'::jsonb) || EXCLUDED.data,
        updated_at = now()
      RETURNING data, updated_at
    `;
    const params = [playerId, JSON.stringify(data)];
    const { rows } = await pool.query(q, params);

    return res.json(rows[0]);
  } catch (err) {
    console.error("merge_failed:", err);
    return res.status(500).json({ error: "merge_failed" });
  }
});

// ------------------- START -------------------
await runMigrations();

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

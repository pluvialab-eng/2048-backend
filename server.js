// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { OAuth2Client } from "google-auth-library";

dotenv.config();
const { Pool } = pkg;

const {
  DATABASE_URL,
  DATABASE_SSL,
  PORT = 8080,
  ALLOWED_ORIGIN = "*",
  JWT_SECRET = "change-me",

  // Google OAuth (ID/Secret zorunlu; redirect boş ise 'postmessage' kullanılacak)
  GOOGLE_CLIENT_ID = "",
  GOOGLE_CLIENT_SECRET = "",
  GOOGLE_REDIRECT_URI = "", // boş olabilir → 'postmessage' fallback
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

/* ------------------- MIGRATIONS ------------------- */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.join(__dirname, "migrations");

async function runMigrations() {
  try {
    let files = await fs.readdir(MIGRATIONS_DIR);
    files = files.filter(f => f.toLowerCase().endsWith(".sql")).sort();
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

/* ------------------- HELPERS ------------------- */
function makePlayerIdFromSub(sub) {
  // Google 'sub' → stabil integer (32-bit) üret
  let h = 2166136261 >>> 0;
  const s = String(sub);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  // 1..2_147_483_647 aralığına
  const int31 = (h & 0x7fffffff) || 1;
  return int31;
}

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

/* ------------------- AUTH: /auth/google ------------------- */
const oauthClient = new OAuth2Client({
  clientId:     GOOGLE_CLIENT_ID || undefined,
  clientSecret: GOOGLE_CLIENT_SECRET || undefined,
  redirectUri:  GOOGLE_REDIRECT_URI?.trim() || "",
});

app.post("/auth/google", async (req, res) => {
  try {
    if (!GOOGLE_CLIENT_ID || !GOOGLE_CLIENT_SECRET) {
      console.error("auth/google: missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET");
      return res.status(500).json({ error: "server_not_configured" });
    }

    const code = req.body?.authCode;
    if (!code || typeof code !== "string") {
      return res.status(400).json({ error: "invalid_auth_code" });
    }

    const redirectUri = GOOGLE_REDIRECT_URI?.trim() || "";

    // Kodu token’a çevir
    const { tokens } = await oauthClient.getToken({
      code,
      redirect_uri: redirectUri,
    });

    const idToken = tokens.id_token;
    if (!idToken) {
      console.error("auth/google: no id_token on token response", tokens);
      return res.status(400).json({ error: "no_id_token" });
    }

    // id_token doğrula
    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });
    const payload = ticket.getPayload();
    const sub = payload?.sub;
    if (!sub) {
      return res.status(400).json({ error: "invalid_id_token" });
    }

    const playerId = makePlayerIdFromSub(sub);

    // Uygulamanın kullanacağı kendi JWT’si
    const appJwt = jwt.sign({ playerId }, JWT_SECRET, { expiresIn: "30d" });

    return res.json({
      token: appJwt,
      player: { playerId, googleSub: sub },
    });
  } catch (err) {
    console.error("auth/google failed:", err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    return res.status(status).json({ error: "auth_failed" });
  }
});

/* ------------------- SYNC ------------------- */
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
    console.error("snapshot_failed:", {
      code: err.code, detail: err.detail, message: err.message,
      table: err.table, constraint: err.constraint,
    });
    return res.status(500).json({ error: "snapshot_failed" });
  }
});

// Yardımcı: payload anlamlı mı?
function hasMeaningfulData(obj) {
  if (!obj || typeof obj !== "object") return false;
  const keys = Object.keys(obj);
  if (keys.length === 0) return false;
  for (const k of keys) {
    const v = obj[k];
    if (v === null || v === undefined) continue;
    if (typeof v === "number" && v !== 0) return true;
    if (typeof v === "string" && v.trim() !== "") return true;
    if (typeof v === "object" && Object.keys(v).length > 0) return true;
  }
  return false;
}

// POST merge
app.post("/sync/merge", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    const body = req.body || {};
    const data = body.data;

    // Boş/anlamsız merge => hiçbir şeyi ezme, mevcut kaydı döndür
    if (!hasMeaningfulData(data)) {
      const q0 = `SELECT data, updated_at FROM profiles WHERE player_id = $1::int`;
      const r0 = await pool.query(q0, [playerId]);
      if (r0.rows.length > 0) return res.json(r0.rows[0]);

      // kayıt yoksa oluştur ve boş döndür
      const ins = `
        INSERT INTO profiles (player_id, data, updated_at)
        VALUES ($1::int, '{}'::jsonb, now())
        ON CONFLICT (player_id) DO NOTHING
        RETURNING data, updated_at
      `;
      const r1 = await pool.query(ins, [playerId]);
      return res.json(r1.rows[0] ?? { data: {}, updated_at: new Date().toISOString() });
    }

    const q = `
      INSERT INTO profiles (player_id, data, updated_at)
      VALUES ($1::int, $2::jsonb, now())
      ON CONFLICT (player_id) DO UPDATE
      SET
        data = CASE
                 WHEN EXCLUDED.data = '{}'::jsonb THEN profiles.data
                 ELSE COALESCE(profiles.data, '{}'::jsonb) || EXCLUDED.data
               END,
        updated_at = now()
      RETURNING data, updated_at
    `;
    const params = [playerId, JSON.stringify(data)];
    const { rows } = await pool.query(q, params);

    return res.json(rows[0]);
  } catch (err) {
    console.error("merge_failed:", {
      code: err.code, detail: err.detail, message: err.message,
      table: err.table, constraint: err.constraint,
    });
    return res.status(500).json({ error: "merge_failed" });
  }
});

/* ------------------- START ------------------- */
await runMigrations();

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

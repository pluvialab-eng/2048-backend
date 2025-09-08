// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const { Pool } = pkg;

const {
  DATABASE_URL,
  JWT_SECRET = "change-me",
  ALLOWED_ORIGIN = "*",
  PORT = 8080,
  DATABASE_SSL,
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
    files = files.filter(f => f.toLowerCase().endsWith(".sql")).sort();
    for (const f of files) {
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, f), "utf8");
      console.log(`[migrate] running: ${f}`);
      await pool.query(sql);
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
  return payload; // { playerId: <UUID> }
}

function requireAuth(req, res, next) {
  try {
    req.player = getPlayerFromReq(req);
    next();
  } catch (err) {
    return res.status(401).json({ error: "unauthorized" });
  }
}

// ------------------- ENDPOINTS -------------------
app.get("/health", (_req, res) => res.json({ ok: true }));

// GET snapshot
app.get("/sync/snapshot", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;

    const q = `
      SELECT data, updated_at
      FROM profiles
      WHERE player_id = $1::uuid
    `;
    const { rows } = await pool.query(q, [playerId]);

    if (rows.length === 0) {
      const ins = `
        INSERT INTO profiles (player_id, data, updated_at)
        VALUES ($1::uuid, '{}'::jsonb, now())
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
      VALUES ($1::uuid, $2::jsonb, now())
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

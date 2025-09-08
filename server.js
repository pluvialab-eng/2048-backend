// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
// Node 18+ ise fetch yerleşik; "node-fetch" gereksiz.
const { Pool } = pkg;

const {
  DATABASE_URL,
  JWT_SECRET = "change-me",
  ALLOWED_ORIGIN = "*",
  PORT = 8080,

  // Sadece /auth/google için; şimdilik akışı bozmayalım:
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET,
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- JWT helper ---
function getPlayerFromReq(req) {
  const hdr = req.headers.authorization || "";
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  if (!m) throw new Error("No token");
  const token = m[1];
  const payload = jwt.verify(token, JWT_SECRET);
  // Bizim token'ımız { playerId: ... } şeklinde imzalanıyordu:
  if (!payload?.playerId) throw new Error("Invalid token payload");
  return payload;
}

function requireAuth(req, res, next) {
  try {
    req.player = getPlayerFromReq(req);
    next();
  } catch (err) {
    const msg = String(err?.message || err);
    return res.status(401).json({ error: /token/i.test(msg) ? "Invalid token" : "No token" });
  }
}

/** ------------------------------------------------------------------------
 *  SYNC ENDPOINTS  (profiles tablosu: player_id, data jsonb, updated_at)
 *  - İlk snapshot'ta kayıt yoksa boş obje döner.
 *  - Merge: UPSERT + JSONB merge (old || new).
 *  --------------------------------------------------------------------- */

// GET /sync/snapshot  -> mevcut veriyi getir
app.get("/sync/snapshot", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;

    const q = `
      SELECT data, updated_at
      FROM profiles
      WHERE player_id = $1
    `;
    const { rows } = await pool.query(q, [playerId]);

    if (rows.length === 0) {
      // İlk giriş: boş profil oluştur ve döndür
      const ins = `
        INSERT INTO profiles (player_id, data, updated_at)
        VALUES ($1, '{}'::jsonb, now())
        ON CONFLICT (player_id) DO NOTHING
        RETURNING data, updated_at
      `;
      const r2 = await pool.query(ins, [playerId]);
      if (r2.rows.length > 0) {
        return res.json(r2.rows[0]);
      }
      // (yarış durumunda başka satır oluşmuş olabilir)
      const r3 = await pool.query(q, [playerId]);
      return res.json(r3.rows[0] ?? { data: {}, updated_at: new Date().toISOString() });
    }

    return res.json(rows[0]);
  } catch (err) {
    console.error("snapshot_failed:", err);
    return res.status(500).json({ error: "snapshot_failed" });
  }
});

// POST /sync/merge  -> gelen JSON'u mevcutla birleştir ve kaydet
app.post("/sync/merge", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    const body = req.body || {};
    const data = body.data;

    if (!data || typeof data !== "object") {
      return res.status(400).json({ error: "no_data" });
    }

    // UPSERT + JSON merge
    const q = `
      INSERT INTO profiles (player_id, data, updated_at)
      VALUES ($1, $2::jsonb, now())
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

/* -----------------------------------------------------------------------
   (Opsiyonel) /auth/google mevcut akışın — dokunmadım.
   Google auth code exchange ve players/profiles yaratma sende nasılsa öyle.
   Burayı ileride iyileştiririz.
------------------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

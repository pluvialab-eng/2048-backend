// server.js
import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import dotenv from "dotenv";
import { OAuth2Client, GoogleAuth } from "google-auth-library";

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

  // IAP doğrulama için gerekli
  GOOGLE_PLAY_PACKAGE = "",          // ör: com.example.a2048
  GOOGLE_SERVICE_ACCOUNT_JSON = ""   // Service Account JSON (düz JSON ya da base64)
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

/* ------------------- IAP VERIFY (YENİ) ------------------- */

// Service Account ile Android Publisher token al
async function getGoogleAccessTokenFromSA() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");
  }
  let jsonStr = GOOGLE_SERVICE_ACCOUNT_JSON;
  // base64 geldiyse çözmeyi dene
  try {
    if (!jsonStr.trim().startsWith("{")) {
      jsonStr = Buffer.from(jsonStr, "base64").toString("utf-8");
    }
  } catch { /* ignore */ }
  const credentials = JSON.parse(jsonStr);

  const auth = new GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const client = await auth.getClient();
  const token = await client.getAccessToken();
  if (!token || !token.token) throw new Error("Google access token alınamadı");
  return token.token;
}

// Play ürün satın alımını doğrula
async function verifyPurchaseWithPlay({ packageName, productId, token }) {
  const accessToken = await getGoogleAccessTokenFromSA();
  const url = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(packageName)}/purchases/products/${encodeURIComponent(productId)}/tokens/${encodeURIComponent(token)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  const text = await res.text();
  let json = {};
  try { json = JSON.parse(text); } catch {}
  return { status: res.status, json, raw: text };
}

// profiles.data->'coins' değerini arttır
async function incrementCoins(client, playerId, delta) {
  const q = `
    UPDATE profiles
    SET data = jsonb_set(
          data,
          '{coins}',
          to_jsonb( COALESCE( (data->>'coins')::INT, 0 ) + $2 ),
          true
        ),
        updated_at = now()
    WHERE player_id = $1::int
    RETURNING (data->>'coins')::INT AS coins;
  `;
  const { rows } = await client.query(q, [playerId, delta]);
  return rows?.[0]?.coins ?? null;
}

// Ürün → coin miktarı (client ile birebir)
const COIN_PRODUCTS = {
  "coins_150": 150,
  "coins_300": 300,
  "coins_800": 800,
  "coins_2000": 2000,
};

// POST /iap/verify
// Body: { productId, purchaseToken } + Authorization: Bearer <JWT>
app.post("/iap/verify", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    const { productId, purchaseToken } = req.body || {};

    if (!productId || !purchaseToken) {
      return res.status(400).json({ error: "missing_params" });
    }
    if (!GOOGLE_PLAY_PACKAGE || !GOOGLE_SERVICE_ACCOUNT_JSON) {
      return res.status(500).json({ error: "server_not_configured" });
    }

    // Token daha önce kullanılmış mı? (unique constraint yine güvence ama erken çıkış iyi)
    const dup = await pool.query(
      "SELECT id FROM iap_tokens WHERE token = $1",
      [purchaseToken]
    );
    if (dup.rowCount > 0) {
      return res.status(409).json({ error: "token_already_used" });
    }

    // Play doğrulaması
    const result = await verifyPurchaseWithPlay({
      packageName: GOOGLE_PLAY_PACKAGE,
      productId,
      token: purchaseToken,
    });

    const purchased = result.status === 200 &&
                      result.json &&
                      result.json.purchaseState === 0; // purchased

    if (!purchased) {
      // logla (rejected)
      await pool.query(
        `INSERT INTO iap_tokens (player_id, product_id, token, amount, state, raw_response)
         VALUES ($1,$2,$3,$4,'rejected',$5)`,
        [playerId, productId, purchaseToken, 0, result.json || {}]
      );
      return res.status(400).json({ error: "not_purchased", play: result.json || null });
    }

    const amount = COIN_PRODUCTS[productId] || 0;
    if (amount <= 0) {
      return res.status(400).json({ error: "unknown_product" });
    }

    // Tek transaction: token kaydet + coin ekle
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO iap_tokens (player_id, product_id, token, amount, state, raw_response)
         VALUES ($1,$2,$3,$4,'credited',$5)`,
        [playerId, productId, purchaseToken, amount, result.json || {}]
      );

      const newCoins = await incrementCoins(client, playerId, amount);

      await client.query("COMMIT");
      client.release();

      return res.json({ ok: true, amount, newCoins });
    } catch (e) {
      try { await client.query("ROLLBACK"); client.release(); } catch {}
      // benzersiz token ihlali vb.
      if (String(e.message || "").includes("duplicate key")) {
        return res.status(409).json({ error: "token_already_used" });
      }
      throw e;
    }
  } catch (err) {
    console.error("iap_verify_failed:", {
      code: err.code, detail: err.detail, message: err.message,
      table: err.table, constraint: err.constraint,
    });
    return res.status(500).json({ error: "server_error" });
  }
});

/* ------------------- START ------------------- */
await runMigrations();

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

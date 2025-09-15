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
import { google } from "googleapis";

dotenv.config();
const { Pool } = pkg;

const {
  DATABASE_URL,
  DATABASE_SSL,
  PORT = 8080,
  ALLOWED_ORIGIN = "*",
  JWT_SECRET = "change-me",

  GOOGLE_CLIENT_ID = "",
  GOOGLE_CLIENT_SECRET = "",
  GOOGLE_REDIRECT_URI = "", // kullanılmıyor (Android için postmessage)

  // IAP doğrulama için
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
  let h = 2166136261 >>> 0;
  const s = String(sub);
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
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
  redirectUri:  "", // Android için postmessage
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

    // postmessage sabit
    const { tokens } = await oauthClient.getToken({ code, redirect_uri: "" });

    const idToken = tokens.id_token;
    if (!idToken) {
      console.error("auth/google: no id_token on token response", tokens);
      return res.status(400).json({ error: "no_id_token" });
    }

    const ticket = await oauthClient.verifyIdToken({
      idToken,
      audience: GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const sub = payload?.sub;
    if (!sub) return res.status(400).json({ error: "invalid_id_token" });

    const playerId = makePlayerIdFromSub(sub);
    const appJwt = jwt.sign({ playerId }, JWT_SECRET, { expiresIn: "30d" });

    return res.json({ token: appJwt, player: { playerId, googleSub: sub } });
  } catch (err) {
    console.error("auth/google failed:", err?.response?.data || err?.message || err);
    const status = err?.response?.status || 500;
    return res.status(status).json({ error: "auth_failed" });
  }
});

/* ------------------- SYNC ------------------- */

// sanitize + deep-merge yardımcıları
function isPlainObject(v) { return v && typeof v === "object" && !Array.isArray(v); }
function stripEmpty(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string" && v.trim() === "") continue;
    if (isPlainObject(v)) {
      const nested = stripEmpty(v);
      if (Object.keys(nested).length === 0) continue;
      out[k] = nested;
    } else out[k] = v;
  }
  return out;
}
function deepMergeKeepExisting(base, incoming) {
  if (!isPlainObject(incoming) || Object.keys(incoming).length === 0) return base || {};
  const out = { ...(base || {}) };
  for (const [k, v] of Object.entries(incoming)) {
    if (v === null || v === undefined) continue;
    if (isPlainObject(v) && isPlainObject(out[k])) out[k] = deepMergeKeepExisting(out[k], v);
    else out[k] = v;
  }
  return out;
}
// Sunucu otoriter alanlar (client’tan gelen payload’dan atılacak)
const SERVER_AUTH_KEYS = new Set(["coins"]);

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

app.post("/sync/merge", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    let data = (req.body && req.body.data) || {};

    // 1) sanitize
    data = stripEmpty(data);
    // 2) otoriter alanları düşür (ör. coins)
    for (const k of SERVER_AUTH_KEYS) { if (k in data) delete data[k]; }

    // 3) hâlâ boşsa: yazma; mevcut profili dön (yoksa boş satır oluştur)
    if (!data || Object.keys(data).length === 0) {
      const r0 = await pool.query(`SELECT data, updated_at FROM profiles WHERE player_id=$1::int`, [playerId]);
      if (r0.rows.length > 0) return res.json(r0.rows[0]);

      const r1 = await pool.query(
        `INSERT INTO profiles (player_id, data, updated_at)
         VALUES ($1::int, '{}'::jsonb, now())
         ON CONFLICT (player_id) DO NOTHING
         RETURNING data, updated_at`,
        [playerId]
      );
      return res.json(r1.rows[0] ?? { data: {}, updated_at: new Date().toISOString() });
    }

    // 4) select + deep-merge + update (idempotent)
    const cur = await pool.query("SELECT data FROM profiles WHERE player_id=$1::int", [playerId]);

    if (cur.rows.length === 0) {
      const r = await pool.query(
        `INSERT INTO profiles (player_id, data, updated_at)
         VALUES ($1::int, $2::jsonb, now())
         ON CONFLICT (player_id) DO NOTHING
         RETURNING data, updated_at`,
        [playerId, JSON.stringify(data)]
      );
      return res.json(r.rows[0] ?? { data, updated_at: new Date().toISOString() });
    } else {
      const merged = deepMergeKeepExisting(cur.rows[0].data, data);
      const r = await pool.query(
        `UPDATE profiles
           SET data=$2::jsonb, updated_at=now()
         WHERE player_id=$1::int
         RETURNING data, updated_at`,
        [playerId, JSON.stringify(merged)]
      );
      return res.json(r.rows[0]);
    }
  } catch (err) {
    console.error("merge_failed:", err);
    return res.status(500).json({ error: "merge_failed" });
  }
});

// Küçük teşhis endpoint’i
app.get("/debug/profile", requireAuth, async (req, res) => {
  const { playerId } = req.player;
  const r = await pool.query(
    "SELECT player_id, data, updated_at FROM profiles WHERE player_id=$1::int",
    [playerId]
  );
  res.json({ playerId, row: r.rows[0] || null });
});

/* ------------------- IAP VERIFY (googleapis ile) ------------------- */

// SA JSON'u (düz JSON ya da base64) -> credentials objesi
function loadServiceAccountCredentials() {
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON missing");
  let jsonStr = GOOGLE_SERVICE_ACCOUNT_JSON;
  try {
    if (!jsonStr.trim().startsWith("{")) jsonStr = Buffer.from(jsonStr, "base64").toString("utf-8");
  } catch {}
  return JSON.parse(jsonStr);
}

// Android Publisher istemcisi
async function getAndroidPublisher() {
  const credentials = loadServiceAccountCredentials();
  const auth = new google.auth.GoogleAuth({
    credentials,
    scopes: ["https://www.googleapis.com/auth/androidpublisher"],
  });
  const client = await auth.getClient();
  return google.androidpublisher({ version: "v3", auth: client });
}

// profiles.data->'coins' güvenli arttır
async function incrementCoins(client, playerId, delta) {
  const q = `
    UPDATE profiles
    SET data = jsonb_set(
          COALESCE(data, '{}'::jsonb),
          '{coins}',
          to_jsonb( COALESCE(NULLIF(data->>'coins','')::INT, 0) + $2 ),
          true
        ),
        updated_at = now()
    WHERE player_id = $1::int
    RETURNING (data->>'coins')::INT AS coins;
  `;
  const { rows } = await client.query(q, [playerId, delta]);
  return rows?.[0]?.coins ?? null;
}

// profiles.data->'coins' güvenli azalt (yetersizse UPDATE yapılmaz)
async function decrementCoinsIfEnough(client, playerId, delta) {
  const q = `
    WITH cur AS (
      SELECT COALESCE(NULLIF(data->>'coins','')::INT, 0) AS bal
      FROM profiles
      WHERE player_id = $1::int
      FOR UPDATE
    ),
    ok AS (
      SELECT (bal >= $2) AS ok FROM cur
    ),
    upd AS (
      UPDATE profiles
         SET data = jsonb_set(
               COALESCE(data, '{}'::jsonb),
               '{coins}',
               to_jsonb( (SELECT bal FROM cur) - $2 ),
               true
             ),
             updated_at = now()
       WHERE player_id = $1::int AND (SELECT ok FROM ok)
       RETURNING (data->>'coins')::INT AS coins
    )
    SELECT (SELECT bal FROM cur) AS before,
           (SELECT coins FROM upd) AS after,
           (SELECT ok FROM ok) AS ok;
  `;
  const { rows } = await client.query(q, [playerId, delta]);
  const before = rows?.[0]?.before ?? 0;
  const after  = rows?.[0]?.after ?? before;
  const ok     = !!rows?.[0]?.ok;
  return { ok, before, after };
}

// Ürün → coin miktarı (client ile birebir)
const COIN_PRODUCTS = {
  "coins_150": 150,
  "coins_300": 300,
  "coins_800": 800,
  "coins_2000": 2000,
};

// --- DEBUG: SA & paket hızlı kontrolü ---
app.get("/debug/iap-config", (_req, res) => {
  try {
    const sa = loadServiceAccountCredentials();
    return res.json({
      ok: true,
      client_email: sa.client_email,
      project_id: sa.project_id,
      package: GOOGLE_PLAY_PACKAGE
    });
  } catch (e) {
    return res.status(500).json({ error: String(e.message || e) });
  }
});

// --- DEBUG: Android Publisher erişimi test ---
app.get("/debug/iap-token", async (_req, res) => {
  try {
    await getAndroidPublisher();
    return res.json({ ok: true });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String(e.message || e) });
  }
});

// IAP ile COIN EKLE
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

    // Token double-spend engeli
    const dup = await pool.query("SELECT id FROM iap_tokens WHERE token = $1", [purchaseToken]);
    if (dup.rowCount > 0) return res.status(409).json({ error: "token_already_used" });

    // Play doğrulaması (googleapis)
    const publisher = await getAndroidPublisher();
    let playRes, status = 200;
    try {
      playRes = await publisher.purchases.products.get({
        packageName: GOOGLE_PLAY_PACKAGE,
        productId,
        token: purchaseToken,
      });
    } catch (e) {
      status = e?.response?.status || 500;
      playRes = { data: e?.response?.data || { error: e.message } };
    }

    const playJson = playRes?.data || {};
    console.log("playVerify", status, JSON.stringify(playJson));

    const purchased = (status === 200) && playJson && playJson.purchaseState === 0;
    if (!purchased) {
      await pool.query(
        `INSERT INTO iap_tokens (player_id, product_id, token, amount, state, raw_response)
         VALUES ($1,$2,$3,$4,'rejected',$5)`,
        [playerId, productId, purchaseToken, 0, playJson]
      );
      const code = (status === 401 || status === 403) ? status : 400;
      return res.status(code).json({
        error: "not_purchased",
        play: playJson,
        hint: {
          service_account_email: (() => { try { return loadServiceAccountCredentials().client_email; } catch { return undefined; } })(),
          package: GOOGLE_PLAY_PACKAGE,
          productId
        }
      });
    }

    const amount = COIN_PRODUCTS[productId] || 0;
    if (amount <= 0) return res.status(400).json({ error: "unknown_product" });

    // Tek transaction: token kaydet + coin ekle
    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      await client.query(
        `INSERT INTO iap_tokens (player_id, product_id, token, amount, state, raw_response)
         VALUES ($1,$2,$3,$4,'credited',$5)`,
        [playerId, productId, purchaseToken, amount, playJson]
      );

      // profil yoksa önce oluştur (güvenlik)
      await client.query(
        `INSERT INTO profiles (player_id, data, updated_at)
         VALUES ($1::int, '{}'::jsonb, now())
         ON CONFLICT (player_id) DO NOTHING`,
        [playerId]
      );

      const before = await getCoinsNow(playerId);
      const newCoins = await incrementCoins(client, playerId, amount);

      await client.query("COMMIT");
      client.release();

      console.log(`[iap_verify] player=${playerId} before=${before} +${amount} => after=${newCoins}`);
      return res.json({ ok: true, amount, newCoins });
    } catch (e) {
      try { await client.query("ROLLBACK"); client.release(); } catch {}
      if (String(e.message || "").includes("duplicate key")) {
        return res.status(409).json({ error: "token_already_used" });
      }
      throw e;
    }
  } catch (err) {
    console.error("iap_verify_failed:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ------------------- WALLET (server-otoriter) ------------------- */

// Profil satırı yoksa oluştur
async function ensureProfileRow(playerId) {
  await pool.query(
    `INSERT INTO profiles (player_id, data, updated_at)
     VALUES ($1::int, '{}'::jsonb, now())
     ON CONFLICT (player_id) DO NOTHING`,
    [playerId]
  );
}

// Anlık coin okuma
async function getCoinsNow(playerId) {
  const r = await pool.query(
    `SELECT COALESCE(NULLIF(data->>'coins','')::INT, 0) AS coins
       FROM profiles
      WHERE player_id = $1::int`,
    [playerId]
  );
  return r.rows?.[0]?.coins ?? 0;
}

/** GET /wallet/balance → { coins } */
app.get("/wallet/balance", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    await ensureProfileRow(playerId);
    const coins = await getCoinsNow(playerId);
    return res.json({ coins });
  } catch (e) {
    console.error("wallet_balance_failed:", e);
    return res.status(500).json({ error: "server_error" });
  }
});

// Tema vb. için COIN DÜŞ
app.post("/wallet/spend", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    const { amount, reason } = req.body || {};
    const spend = parseInt(amount, 10);

    if (!Number.isFinite(spend) || spend <= 0) {
      return res.status(400).json({ error: "bad_amount" });
    }

    const client = await pool.connect();
    try {
      await client.query("BEGIN");

      // profil satırı yoksa oluştur
      await client.query(
        `INSERT INTO profiles (player_id, data, updated_at)
         VALUES ($1::int, '{}'::jsonb, now())
         ON CONFLICT (player_id) DO NOTHING`,
        [playerId]
      );

      const before = await getCoinsNow(playerId);
      const r = await decrementCoinsIfEnough(client, playerId, spend);
      if (!r.ok) {
        await client.query("ROLLBACK"); client.release();
        console.log(`[wallet_spend] player=${playerId} before=${before} need=${spend} => INSUFFICIENT`);
        return res.status(400).json({ ok: false, error: "insufficient_balance", current: before });
      }

      // coin_ledger opsiyonel (yoksa hata verme)
      try {
        await client.query(
          `INSERT INTO coin_ledger (player_id, delta, reason) VALUES ($1, $2, $3)`,
          [playerId, -spend, (reason || "theme_purchase").toString().slice(0, 64)]
        );
      } catch {}

      await client.query("COMMIT");
      client.release();

      console.log(`[wallet_spend] player=${playerId} before=${before} -${spend} => after=${r.after}`);
      return res.json({ ok: true, newCoins: r.after });
    } catch (e) {
      try { await client.query("ROLLBACK"); client.release(); } catch {}
      throw e;
    }
  } catch (err) {
    console.error("wallet_spend_failed:", err);
    return res.status(500).json({ error: "server_error" });
  }
});

/* ------------------- START ------------------- */
await runMigrations();

app.listen(PORT, () => {
  console.log(`API listening on :${PORT}`);
});

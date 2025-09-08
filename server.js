import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
import fetch from "node-fetch"; // Node 18+ ise yerleşik fetch var; bu satırı kaldırabilirsin

const { Pool } = pkg;

const {
  DATABASE_URL,
  JWT_SECRET = "change-me",
  ALLOWED_ORIGIN = "*",
  PORT = 8080,
  GOOGLE_CLIENT_ID,      // <-- Web Application client ID
  GOOGLE_CLIENT_SECRET,  // <-- Web Application client secret
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false,
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

// --- JWT Middleware ---
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: "No token" });

  const token = authHeader.split(" ")[1];
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.player = payload; // { playerId: ... }
    next();
  } catch (err) {
    return res.status(401).json({ error: "Invalid token" });
  }
}

// --- Google Auth ---
app.post("/auth/google", async (req, res) => {
  try {
    const { authCode } = req.body;
    if (!authCode) return res.status(400).json({ error: "authCode_missing" });

    // --- 1) Auth code -> tokens
    const params = new URLSearchParams();
    params.set("code", authCode);
    params.set("client_id", GOOGLE_CLIENT_ID);
    params.set("client_secret", GOOGLE_CLIENT_SECRET);
    params.set("redirect_uri", ""); // kritik
    params.set("grant_type", "authorization_code");

    const googleRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params.toString(),
    });

    const tokens = await googleRes.json();

    if (!googleRes.ok) {
      console.error("Google token error:", { status: googleRes.status, tokens });
      return res.status(400).json({ error: "google_token_error", detail: tokens });
    }

    const idToken = tokens.id_token;
    if (!idToken) {
      console.error("No id_token in Google response:", tokens);
      return res.status(400).json({ error: "no_id_token" });
    }

    // --- 2) id_token decode + audience doğrulama
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1], "base64").toString("utf8"));
    if (payload.aud !== GOOGLE_CLIENT_ID) {
      console.error("audience_mismatch:", { aud: payload.aud, expected: GOOGLE_CLIENT_ID });
      return res.status(400).json({ error: "audience_mismatch", aud: payload.aud });
    }

    // --- 3) Oyuncu DB’de
    const { rows } = await pool.query("select * from players where google_sub = $1", [payload.sub]);

    let player;
    if (rows.length === 0) {
      const insert = await pool.query(
        "insert into players (google_sub, display_name, country_code, last_login_at) values ($1, $2, $3, now()) returning *",
        [payload.sub, payload.name || "Player", payload.locale || null]
      );
      player = insert.rows[0];
    } else {
      player = rows[0];
      await pool.query("update players set last_login_at = now() where id = $1", [player.id]);
    }

    // --- 4) Uygulama JWT
    const token = jwt.sign({ playerId: player.id }, JWT_SECRET, { expiresIn: "7d" });

    return res.json({ token, player });
  } catch (err) {
    console.error("auth/google exception:", err);
    return res.status(500).json({ error: "server_error", message: String(err) });
  }
});

// --- Sync: Snapshot (çek) ---
app.get("/sync/snapshot", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;

    const { rows } = await pool.query(
      "SELECT data, updated_at FROM profiles WHERE player_id = $1",
      [playerId]
    );

    if (rows.length === 0) {
      // hiç profili yoksa oluştur
      await pool.query(
        "INSERT INTO profiles (player_id, data) VALUES ($1, $2)",
        [playerId, {}]
      );
      return res.json({ data: {}, updated_at: new Date().toISOString() });
    }

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "snapshot_failed" });
  }
});

// --- Sync: Merge (kaydet) ---
app.post("/sync/merge", requireAuth, async (req, res) => {
  try {
    const { playerId } = req.player;
    const { data } = req.body;

    if (!data) return res.status(400).json({ error: "no_data" });

    const { rows } = await pool.query(
      `UPDATE profiles
       SET data = $1, updated_at = now()
       WHERE player_id = $2
       RETURNING data, updated_at`,
      [data, playerId]
    );

    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "merge_failed" });
  }
});

app.listen(PORT, () => console.log("listening on", PORT));

import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
import fetch from "node-fetch";   // Google OAuth için eklendi

const { Pool } = pkg;

const {
  DATABASE_URL,
  JWT_SECRET = "change-me",
  ALLOWED_ORIGIN = "*",
  PORT = 8080,
  GOOGLE_CLIENT_ID,
  GOOGLE_CLIENT_SECRET
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

// Health check
app.get("/health", (_req, res) => res.json({ ok: true }));

// Google Auth endpoint
app.post("/auth/google", async (req, res) => {
  try {
    const { authCode } = req.body;
    if (!authCode) return res.status(400).json({ error: "Missing authCode" });

    // 1. Google token exchange
    const params = new URLSearchParams();
    params.append("code", authCode);
    params.append("client_id", GOOGLE_CLIENT_ID);
    params.append("client_secret", GOOGLE_CLIENT_SECRET);
    params.append("redirect_uri", "postmessage");
    params.append("grant_type", "authorization_code");

    const googleRes = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: params
    });

    const tokens = await googleRes.json();
    if (tokens.error) {
      console.error(tokens);
      return res.status(401).json({ error: "Google auth failed" });
    }

    // 2. ID token decode
    const idToken = tokens.id_token;
    const userInfo = JSON.parse(
      Buffer.from(idToken.split(".")[1], "base64").toString()
    );

    // 3. Oyuncuyu DB’de kontrol et / oluştur
    const { rows } = await pool.query(
      "select * from players where google_sub = $1",
      [userInfo.sub]
    );

    let player;
    if (rows.length === 0) {
      const insert = await pool.query(
        "insert into players (google_sub, display_name, country_code, last_login_at) values ($1, $2, $3, now()) returning *",
        [userInfo.sub, userInfo.name, userInfo.locale || null]
      );
      player = insert.rows[0];
    } else {
      player = rows[0];
      await pool.query(
        "update players set last_login_at = now() where id = $1",
        [player.id]
      );
    }

    // 4. JWT üret
    const token = jwt.sign({ playerId: player.id }, JWT_SECRET, {
      expiresIn: "7d"
    });

    res.json({ token, player });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Server error" });
  }
});

app.listen(PORT, () => {
  console.log("listening on", PORT);
});

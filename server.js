import express from "express";
import cors from "cors";
import jwt from "jsonwebtoken";
import pkg from "pg";
const { Pool } = pkg;

const {
  DATABASE_URL,
  JWT_SECRET = "change-me",
  ALLOWED_ORIGIN = "*",
  PORT = 8080
} = process.env;

const pool = new Pool({
  connectionString: DATABASE_URL,
  ssl: process.env.DATABASE_SSL === "true" ? { rejectUnauthorized: false } : false
});

const app = express();
app.use(cors({ origin: ALLOWED_ORIGIN }));
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("listening on", PORT);
});

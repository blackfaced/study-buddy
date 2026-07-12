// src/index.ts
// Study Buddy HTTP Server — thin entry point.
//
// All routes live in `./app.ts` so they can be unit-tested with supertest
// against an in-memory database. This file is responsible for:
//   1. Loading .env
//   2. Opening the real SQLite database
//   3. Running the schema migration (Bug 4 fix: was missing in v0.1)
//   4. Building the Express app via createApp(db)
//   5. Starting HTTPS (with self-signed cert) or HTTP listener

import { config as loadDotenv } from "dotenv";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { createServer as httpsCreate } from "node:https";
import { createServer as httpCreate } from "node:http";
import express from "express";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../.env") });

const ROOT = resolve(__dirname, "../..");
const DB_PATH = process.env.STUDY_DB || join(ROOT, "data/study.db");
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3000);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3001);

const KEY_PATH = process.env.SSL_KEY || join(ROOT, "server.key");
const CERT_PATH = process.env.SSL_CERT || join(ROOT, "server.cert");
const hasCert = existsSync(KEY_PATH) && existsSync(CERT_PATH);

if (!hasCert) {
  console.warn(`[study-buddy-server] SSL cert missing at ${KEY_PATH} / ${CERT_PATH} — HTTPS disabled`);
}

// Bug 4 fix: open the DB AND run the schema migration so writes to
// chat_turns.state don't 500. Both must happen before any request handler
// touches the DB.
const db = new Database(DB_PATH);
migrateSchema(db);
console.log(`[study-buddy-server] DB ready at ${DB_PATH}`);

const app = createApp({ db, httpsPort: HTTPS_PORT });

if (hasCert) {
  httpsCreate(
    { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) },
    app
  ).listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`[study-buddy-server] HTTPS on :${HTTPS_PORT}`);
    console.log(`[study-buddy-server] Web UI: https://localhost:${HTTPS_PORT}/`);
    console.log(`[study-buddy-server] Web UI (LAN): https://mac-mini.local:${HTTPS_PORT}/`);
  });

  const redirectApp = express();
  redirectApp.use((req, res) => {
    const host = req.headers.host?.split(":")[0] || "localhost";
    res.redirect(301, `https://${host}:${HTTPS_PORT}${req.url}`);
  });
  httpCreate(redirectApp).listen(HTTP_PORT, "0.0.0.0", () => {
    console.log(`[study-buddy-server] HTTP redirect → HTTPS on :${HTTP_PORT}`);
  });
} else {
  app.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`[study-buddy-server] HTTP (no HTTPS) on :${HTTPS_PORT}`);
  });
}

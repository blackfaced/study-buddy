// src/index.ts
// Study Buddy HTTP Server — thin entry point.
//
// All routes live in `./app.ts` so they can be unit-tested with supertest
// against an in-memory database. This file is responsible for:
//   1. Loading .env
//   2. Opening the real SQLite database
//   3. Running the schema migration (Bug 4 fix: was missing in v0.1)
//   4. Building the logger (stdout + rotating file)
//   5. Building the vision client (v0.5) if MINIMAX_API_KEY is set
//   6. Building the Express app via createApp(db)
//   7. Starting HTTPS (with self-signed cert) or HTTP listener

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
import { MiniMaxVisionClient } from "./vision-client.js";
import {
  createLogger,
  stdoutSink,
  rotatingFileSink,
  type LogLevel,
} from "./logger.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../.env") });

const ROOT = resolve(__dirname, "../..");
const DB_PATH = process.env.STUDY_DB || join(ROOT, "data/study.db");
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3000);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3001);
const MISTAKES_DIR = process.env.MISTAKES_DIR || join(ROOT, "data/mistakes");
const LOG_DIR = process.env.LOG_DIR || join(ROOT, "data/logs");
const LOG_FILE = process.env.LOG_FILE || join(LOG_DIR, "study-buddy-server.log");
const LOG_LEVEL = (process.env.LOG_LEVEL || "info") as LogLevel;
const LOG_MAX_BYTES = Number(process.env.LOG_MAX_BYTES || 5 * 1024 * 1024); // 5MB

const KEY_PATH = process.env.SSL_KEY || join(ROOT, "server.key");
const CERT_PATH = process.env.SSL_CERT || join(ROOT, "server.cert");
const hasCert = existsSync(KEY_PATH) && existsSync(CERT_PATH);

// Build the logger before opening the DB so we can log startup steps.
const logger = createLogger({
  level: LOG_LEVEL,
  sinks: [stdoutSink, rotatingFileSink({ path: LOG_FILE, maxBytes: LOG_MAX_BYTES, keep: 3 })],
});

if (!hasCert) {
  logger.warn("SSL cert missing — HTTPS disabled", { key: KEY_PATH, cert: CERT_PATH });
}

// Bug 4 fix: open the DB AND run the schema migration so writes to
// chat_turns.state don't 500. Both must happen before any request handler
// touches the DB.
const db = new Database(DB_PATH);
migrateSchema(db);
logger.info("DB ready", { path: DB_PATH });

// v0.5: wire up the vision client if an API key is present. /api/mistake-photo
// returns 503 when this is null.
const visionApiKey = process.env.MINIMAX_API_KEY;
const visionClient = visionApiKey
  ? new MiniMaxVisionClient({ apiKey: visionApiKey })
  : null;
if (visionClient) {
  logger.info("vision client ready", { model: "MiniMax-M3" });
} else {
  logger.warn("MINIMAX_API_KEY not set — /api/mistake-photo will return 503");
}

const app = createApp({
  db,
  httpsPort: HTTPS_PORT,
  visionClient,
  mistakesDir: MISTAKES_DIR,
  logger,
});

if (hasCert) {
  httpsCreate(
    { key: readFileSync(KEY_PATH), cert: readFileSync(CERT_PATH) },
    app
  ).listen(HTTPS_PORT, "0.0.0.0", () => {
    logger.info("HTTPS listening", { port: HTTPS_PORT, urls: [
      `https://localhost:${HTTPS_PORT}/`,
      `https://mac-mini.local:${HTTPS_PORT}/`,
    ]});
  });

  const redirectApp = express();
  redirectApp.use((req, res) => {
    const host = req.headers.host?.split(":")[0] || "localhost";
    res.redirect(301, `https://${host}:${HTTPS_PORT}${req.url}`);
  });
  httpCreate(redirectApp).listen(HTTP_PORT, "0.0.0.0", () => {
    logger.info("HTTP→HTTPS redirect listening", { port: HTTP_PORT });
  });
} else {
  app.listen(HTTPS_PORT, "0.0.0.0", () => {
    logger.info("HTTP listening (no TLS)", { port: HTTPS_PORT });
  });
}

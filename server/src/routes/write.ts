// server/src/routes/write.ts
// =====================================================================
// Write route module — extracted from app.ts (refactor PR 5b).
// =====================================================================
//
// Owns the /api/write/* surface (v0.8+ write app, issue #57):
//   - GET    /api/write/words
//   - POST   /api/write/words
//   - DELETE /api/write/words/:char
//   - GET    /api/write/words/:char/attempts
//   - POST   /api/write/attempts
//   - POST   /api/write/extract-words    (vision-backed, issue #59)
//
// All heavy lifting is in ./write-sync.ts (addWritingWords,
// deleteWritingWord, listWritingWords, listWritingAttempts,
// recordWritingAttempt) and ./vision.ts (extractCharsImage).
// This module is the HTTP shell.
//
// Public API:
//   - registerWriteRoutes(app, { db, logger, mistakesDir, visionClient })
// =====================================================================
import multer from "multer";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";
import type { VisionClient } from "../vision.js";
import {
  addWritingWords,
  deleteWritingWord,
  listWritingAttempts,
  listWritingWords,
  recordWritingAttempt,
} from "../write-sync.js";
import { extractCharsImage } from "../vision.js";

export interface WriteRouteDeps {
  db: Database.Database;
  logger: Logger;
  mistakesDir: string;
  /** Vision client for /api/write/extract-words. If null, returns 503. */
  visionClient: VisionClient | null;
}

export function registerWriteRoutes(app: Express, deps: WriteRouteDeps): void {
  const { db, logger, mistakesDir, visionClient } = deps;

  // 1MB photo upload for extract-words. Different from the chat
  // module's 500KB limit because writing lists can be larger.
  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 1 * 1024 * 1024 },
  });

  // ============== Write app (issue #57) ==============
  // Per-character word library + attempt history. No PIN gate — writing
  // is a parent-supervised activity, not the kind of distraction the
  // buddy PIN is meant to block.
  app.get("/api/write/words", (_req: Request, res: Response) => {
    const words = listWritingWords(db);
    res.json({ words });
  });

  app.post("/api/write/words", (req: Request, res: Response) => {
    const { chars, addedBy } = req.body ?? {};
    if (typeof chars !== "string") {
      return res.status(400).json({ error: "chars must be a string" });
    }
    // Split the string into individual CJK characters; write-sync
    // does the per-char CJK validation + dedup.
    const arr = Array.from(chars);
    const result = addWritingWords(db, arr, typeof addedBy === "string" ? addedBy : "parent");
    res.json(result);
  });

  app.delete("/api/write/words/:char", (req: Request, res: Response) => {
    const char = String(req.params.char);
    // Defensive: only allow single CJK characters in the URL.
    if (!/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    const removed = deleteWritingWord(db, char);
    if (!removed) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  app.get("/api/write/words/:char/attempts", (req: Request, res: Response) => {
    const char = String(req.params.char);
    if (!/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = Math.min(Number(rawLimit ?? 50) || 50, 200);
    const attempts = listWritingAttempts(db, char, limit);
    res.json({ char, attempts });
  });

  app.post("/api/write/attempts", (req: Request, res: Response) => {
    const { char, level, strokePath } = req.body ?? {};
    if (typeof char !== "string" || !/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
      return res.status(400).json({ error: "level must be a number in [0, 1]" });
    }
    if (strokePath !== null && strokePath !== undefined && typeof strokePath !== "string") {
      return res.status(400).json({ error: "strokePath must be a string or null" });
    }
    // FK enforcement: if the char is not in the library, the INSERT
    // will fail. The client should always add to the library first.
    try {
      const attemptId = recordWritingAttempt(db, {
        char,
        level,
        strokePath: strokePath ?? null,
      });
      res.json({ attemptId });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // ============== Extract words from photo (issue #59) ==============
  app.post(
    "/api/write/extract-words",
    upload.single("image"),
    async (req: Request, res: Response) => {
      if (!visionClient) {
        return res.status(503).json({
          error: "vision not configured (MINIMAX_API_KEY not set on the server)",
        });
      }
      if (!req.file) return res.status(400).json({ error: "no image" });
      const base64 = req.file.buffer.toString("base64");
      try {
        const result = await extractCharsImage(visionClient, base64);
        res.json({ words: result.words, model: "MiniMax-M3" });
      } catch (e: any) {
        res.status(502).json({ error: `vision failed: ${e.message}` });
      }
    },
  );
}

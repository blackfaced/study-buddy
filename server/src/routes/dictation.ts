// server/src/routes/dictation.ts
// =====================================================================
// Dictation route module (issue #194 — first slice of the
// parent-operated learning-operations loop, #192).
//
// Owns the dictation task-set CRUD surface:
//   - POST /api/dictation/sets            — parent creates a set
//   - PATCH /api/dictation/sets/:id       — edit words/sentence/plays
//   - POST /api/dictation/sets/:id/retire — retire (idempotent)
//   - GET  /api/dictation/sets            — list; kid view (default)
//     returns active sets only, ?include=all is the parent view
//
// A set is pure task data (资源≠证据): an ordered word list, one
// school-required sentence, and playback counts (default 2 per word,
// 3 for the sentence, overridable per set). Nothing here writes to
// mistake_cases / learning_attempts / correction_obligations.
//
// Idempotency: POST accepts a client-generated idempotencyKey; a
// network retry with the same key returns the existing set (200)
// instead of creating a duplicate.
//
// Public API:
//   - registerDictationRoutes(app, { db, logger, beforeSourceEventAppend })
// =====================================================================
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import type { Logger } from "../logger.js";
import { insertMistake } from "../capture-service.js";

const DEFAULT_WORD_PLAYS = 2;
const DEFAULT_SENTENCE_PLAYS = 3;
const MAX_WORDS = 100;
const MAX_WORD_LEN = 20;
const MAX_SENTENCE_LEN = 100;

// #197: language outcomes of a confirmed dictation item. "wrong" =
// 错字/错词, "pinyin" = 拼音错. Both converge into the closure loop;
// "correct" produces nothing (AC3).
const DICTATION_LANGUAGES = ["correct", "wrong", "pinyin"] as const;
type DictationLanguage = (typeof DICTATION_LANGUAGES)[number];
const LANGUAGE_ERROR_TYPE: Record<Exclude<DictationLanguage, "correct">, string> = {
  wrong: "错字错词",
  pinyin: "拼音错",
};

export interface DictationRouteDeps {
  db: Database.Database;
  logger: Logger;
  /** Throw-only test seam; the real immutable writer always runs afterward. */
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void;
}

interface DictationSetRow {
  id: string;
  child_id: string;
  words_json: string;
  sentence: string;
  word_plays: number;
  sentence_plays: number;
  status: "active" | "retired";
  idempotency_key: string | null;
  created_at: number;
  updated_at: number;
}

function toApi(row: DictationSetRow) {
  return {
    id: row.id,
    childId: row.child_id,
    words: JSON.parse(row.words_json) as string[],
    sentence: row.sentence,
    wordPlays: row.word_plays,
    sentencePlays: row.sentence_plays,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function wordsError(words: unknown): string | null {
  if (!Array.isArray(words) || words.length === 0 || words.length > MAX_WORDS ||
      words.some((w) => typeof w !== "string" || w.trim().length === 0 || w.length > MAX_WORD_LEN)) {
    return `words must be 1-${MAX_WORDS} non-empty strings (each ≤ ${MAX_WORD_LEN} chars)`;
  }
  return null;
}

function sentenceError(sentence: unknown): string | null {
  if (typeof sentence !== "string" || sentence.trim().length === 0 || sentence.length > MAX_SENTENCE_LEN) {
    return `sentence must be a non-empty string (≤ ${MAX_SENTENCE_LEN} chars)`;
  }
  return null;
}

function playsError(name: string, value: unknown): string | null {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 20) {
    return `${name} must be an integer between 1 and 20`;
  }
  return null;
}

/**
 * Mount the dictation routes on the given Express app.
 */
export function registerDictationRoutes(app: Express, deps: DictationRouteDeps): void {
  const { db, logger, beforeSourceEventAppend } = deps;

  app.post("/api/dictation/sets", (req: Request, res: Response) => {
    const body = req.body ?? {};
    const childId = (typeof body.childId === "string" && body.childId.trim()) || "default";
    const { words, sentence, wordPlays, sentencePlays, idempotencyKey } = body;

    const wordsErr = wordsError(words);
    if (wordsErr) return res.status(400).json({ error: wordsErr });
    const sentenceErr = sentenceError(sentence);
    if (sentenceErr) return res.status(400).json({ error: sentenceErr });
    for (const [name, value] of [["wordPlays", wordPlays], ["sentencePlays", sentencePlays]] as const) {
      if (value !== undefined) {
        const err = playsError(name, value);
        if (err) return res.status(400).json({ error: err });
      }
    }
    if (idempotencyKey !== undefined &&
        (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0 || idempotencyKey.length > 128)) {
      return res.status(400).json({ error: "idempotencyKey must be a non-empty string (≤ 128 chars)" });
    }

    const child = db.prepare("SELECT id FROM children WHERE id = ?").get(childId) as
      | { id: string }
      | undefined;
    if (!child) return res.status(404).json({ error: "child not found" });

    // Idempotent retry: same key → return the existing set, no duplicate.
    if (idempotencyKey) {
      const existing = db.prepare(
        "SELECT * FROM dictation_sets WHERE idempotency_key = ?",
      ).get(idempotencyKey) as DictationSetRow | undefined;
      if (existing) return res.status(200).json(toApi(existing));
    }

    const now = Date.now();
    const row: DictationSetRow = {
      id: randomUUID(),
      child_id: childId,
      words_json: JSON.stringify(words.map((w: string) => w.trim())),
      sentence: sentence.trim(),
      word_plays: wordPlays ?? DEFAULT_WORD_PLAYS,
      sentence_plays: sentencePlays ?? DEFAULT_SENTENCE_PLAYS,
      status: "active",
      idempotency_key: idempotencyKey ?? null,
      created_at: now,
      updated_at: now,
    };
    db.prepare(`
      INSERT INTO dictation_sets
        (id, child_id, words_json, sentence, word_plays, sentence_plays, status, idempotency_key, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      row.id, row.child_id, row.words_json, row.sentence,
      row.word_plays, row.sentence_plays, row.status,
      row.idempotency_key, row.created_at, row.updated_at,
    );
    logger.info("dictation set created", { id: row.id, childId: row.child_id, words: words.length });
    return res.status(201).json(toApi(row));
  });

  // Retire is idempotent: retiring an already-retired set returns 200
  // with the same state, so a retried tap never errors.
  app.post("/api/dictation/sets/:id/retire", (req: Request, res: Response) => {
    const row = db.prepare("SELECT * FROM dictation_sets WHERE id = ?").get(req.params.id) as
      | DictationSetRow
      | undefined;
    if (!row) return res.status(404).json({ error: "dictation set not found" });
    if (row.status !== "retired") {
      const now = Date.now();
      db.prepare("UPDATE dictation_sets SET status = 'retired', updated_at = ? WHERE id = ?")
        .run(now, row.id);
      row.status = "retired";
      row.updated_at = now;
      logger.info("dictation set retired", { id: row.id, childId: row.child_id });
    }
    return res.json(toApi(row));
  });

  // Partial edit of the task data (words / sentence / play counts).
  // Status transitions go through /retire, not PATCH.
  app.patch("/api/dictation/sets/:id", (req: Request, res: Response) => {
    const row = db.prepare("SELECT * FROM dictation_sets WHERE id = ?").get(req.params.id) as
      | DictationSetRow
      | undefined;
    if (!row) return res.status(404).json({ error: "dictation set not found" });

    const body = req.body ?? {};
    const { words, sentence, wordPlays, sentencePlays } = body;
    if (words !== undefined) {
      const err = wordsError(words);
      if (err) return res.status(400).json({ error: err });
    }
    if (sentence !== undefined) {
      const err = sentenceError(sentence);
      if (err) return res.status(400).json({ error: err });
    }
    for (const [name, value] of [["wordPlays", wordPlays], ["sentencePlays", sentencePlays]] as const) {
      if (value !== undefined) {
        const err = playsError(name, value);
        if (err) return res.status(400).json({ error: err });
      }
    }

    const next: DictationSetRow = {
      ...row,
      words_json: words !== undefined ? JSON.stringify(words.map((w: string) => w.trim())) : row.words_json,
      sentence: sentence !== undefined ? sentence.trim() : row.sentence,
      word_plays: wordPlays ?? row.word_plays,
      sentence_plays: sentencePlays ?? row.sentence_plays,
      updated_at: Date.now(),
    };
    db.prepare(`
      UPDATE dictation_sets
      SET words_json = ?, sentence = ?, word_plays = ?, sentence_plays = ?, updated_at = ?
      WHERE id = ?
    `).run(next.words_json, next.sentence, next.word_plays, next.sentence_plays, next.updated_at, row.id);
    logger.info("dictation set edited", { id: row.id, childId: row.child_id });
    return res.json(toApi(next));
  });

  app.get("/api/dictation/sets", (req: Request, res: Response) => {
    const childId = (typeof req.query.childId === "string" && req.query.childId.trim()) || "default";
    // Kid view is the default: active sets only. The parent view opts
    // in with ?include=all — no new auth concept for v1 (#194).
    const includeAll = req.query.include === "all";
    const rows = db.prepare(`
      SELECT * FROM dictation_sets
      WHERE child_id = ? ${includeAll ? "" : "AND status = 'active'"}
      ORDER BY created_at DESC
    `).all(childId) as DictationSetRow[];
    return res.json({ sets: rows.map(toApi) });
  });

  // ============== #197: confirmed dictation results → closure loop ==============
  // "Confirmed" means the kid/parent already confirmed each item in the
  // dictation compare UI — the endpoint receives confirmed results and
  // never re-confirms. Language and handwriting outcomes are written
  // as INDEPENDENT rows (AC1):
  //   - language wrong/pinyin → insertMistake() (unified Capture path:
  //     Mistake Case subject=chinese + original Learning Attempt +
  //     open Correction Obligation + Source Event, nested transaction)
  //   - handwriting poor → append-only handwriting_observations row,
  //     never a mistake case — legibility is not a language error
  //   - correct + legible → nothing at all (AC3)
  // Idempotency (AC4): idempotencyKey is UNIQUE on
  // dictation_submissions; a retry replays the stored result.
  app.post("/api/dictation/sets/:id/submissions", (req: Request, res: Response) => {
    const set = db.prepare("SELECT * FROM dictation_sets WHERE id = ?").get(req.params.id) as
      | DictationSetRow
      | undefined;
    if (!set) return res.status(404).json({ error: "dictation set not found" });

    const body = req.body ?? {};
    const childId = (typeof body.childId === "string" && body.childId.trim()) || set.child_id;
    const { idempotencyKey, items } = body;
    if (typeof idempotencyKey !== "string" || idempotencyKey.trim().length === 0 ||
        idempotencyKey.length > 128) {
      // The key is REQUIRED here (unlike set creation): it is the only
      // thing that makes a confirm retry safe (AC4).
      return res.status(400).json({ error: "idempotencyKey is required (non-empty string, ≤ 128 chars)" });
    }
    if (!Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ error: "items must be a non-empty array" });
    }
    for (const item of items) {
      if (!item || typeof item.target !== "string" || item.target.trim().length === 0 ||
          !DICTATION_LANGUAGES.includes(item.language) ||
          (item.handwriting !== undefined && !["ok", "poor"].includes(item.handwriting)) ||
          (item.replays !== undefined && (!Number.isInteger(item.replays) || item.replays < 0))) {
        return res.status(400).json({
          error: "each item needs target (string), language (correct|wrong|pinyin), optional handwriting (ok|poor), optional replays (int ≥ 0)",
        });
      }
    }

    // Retry replay: same key → stored result, no double write.
    const existing = db.prepare(
      "SELECT result_json FROM dictation_submissions WHERE idempotency_key = ?",
    ).get(idempotencyKey) as { result_json: string } | undefined;
    if (existing) return res.status(200).json(JSON.parse(existing.result_json));

    const submissionId = randomUUID();
    const result = {
      submissionId,
      setId: set.id,
      mistakeCases: [] as Array<{ target: string; caseId: string; created: boolean }>,
      handwritingObservations: 0,
      items: items.length,
    };

      db.transaction(() => {
      // Pass 1: language outcomes (closure loop writes). Receipt comes
      // next because handwriting_observations.submission_id FKs to it.
      for (const item of items as Array<{
        target: string; language: DictationLanguage; handwriting?: "ok" | "poor"; replays?: number;
      }>) {
        if (item.language === "correct") continue;
        // 孩子的手写是笔画不是文本 — like the vision path, the typed
        // user answer arrives later in review (#160).
        const inserted = insertMistake(db, {
          childId,
          problem: item.target.trim(),
          userAnswer: "",
          correctAnswer: item.target.trim(),
          errorType: LANGUAGE_ERROR_TYPE[item.language as Exclude<DictationLanguage, "correct">],
          source: "dictation",
          subject: "chinese",
        }, beforeSourceEventAppend);
        result.mistakeCases.push({ target: item.target.trim(), caseId: inserted.caseId, created: inserted.created });
      }
      result.handwritingObservations = (items as Array<{ handwriting?: string }>)
        .filter((i) => i.handwriting === "poor").length;
      db.prepare(`
        INSERT INTO dictation_submissions
          (id, set_id, child_id, idempotency_key, payload_json, result_json, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(
        submissionId, set.id, childId, idempotencyKey,
        JSON.stringify({ items }), JSON.stringify(result), Date.now(),
      );
      // Pass 2: handwriting observations (independent of the cases).
      const insertObservation = db.prepare(`
        INSERT INTO handwriting_observations
          (child_id, char, issue_type, source, algorithm_version, submission_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of items as Array<{ target: string; handwriting?: "ok" | "poor" }>) {
        if (item.handwriting !== "poor") continue;
        insertObservation.run(
          childId, item.target.trim(), "poor_legibility", "dictation", "human-confirmed",
          submissionId, Date.now(),
        );
      }
    })();

    logger.info("dictation submission recorded", {
      submissionId, setId: set.id, childId,
      mistakeCases: result.mistakeCases.length,
      handwritingObservations: result.handwritingObservations,
    });
    return res.status(201).json(result);
  });
}

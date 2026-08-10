// server/src/write-sync.ts
//
// Data access layer for the write app (issue #57). Wraps SQLite
// operations on the writing_words and writing_attempts tables.
//
// Schema lives in db-migrate.ts; this file assumes the migration has
// run. All functions are sync (better-sqlite3 is sync) and throw on
// unexpected DB errors.
//
// Design notes:
// - writing_words.char is PRIMARY KEY, so duplicate INSERTs are
//   rejected by the DB. We use INSERT OR IGNORE + a count of affected
//   rows to know how many were actually added.
// - writing_attempts are append-only history. The kid's stroke SVG
//   path is stored as a TEXT blob (no parsing on the server side).
// - No multi-child support in v0.1 — the library is shared.

import type Database from "better-sqlite3";

export interface WritingWord {
  char: string;
  addedAt: number;
  addedBy: string;
  /** Convenience: how many attempts the kid has made. */
  attemptCount: number;
}

export interface WritingAttempt {
  id: number;
  char: string;
  level: number;
  strokePath: string | null;
  score: number | null;
  displayBand: string | null;
  status: string | null;
  strokes: unknown[] | null;
  breakdown: Record<string, unknown> | null;
  reasons: unknown[] | null;
  nextAction: string | null;
  retryOutcome: string | null;
  reviewNeeded: boolean;
  process: Record<string, unknown> | null;
  algorithmVersion: string | null;
  modelReview: Record<string, unknown> | null;
  ts: number;
}

export interface HandwritingAssessmentInput {
  status: string;
  score: number | null;
  band: string;
  strokes: unknown[];
  breakdown: Record<string, unknown> | null;
  reasons: unknown[];
  process: Record<string, unknown>;
  algorithmVersion: string;
  nextAction?: string | null;
  retryOutcome?: string | null;
  reviewNeeded?: boolean;
  modelReview?: Record<string, unknown> | null;
}

/** List all words in the library, newest first, with attempt counts. */
export function listWritingWords(db: Database.Database): WritingWord[] {
  return db
    .prepare(
      `SELECT w.char, w.added_at as addedAt, w.added_by as addedBy,
              (SELECT COUNT(*) FROM writing_attempts a WHERE a.char = w.char) as attemptCount
         FROM writing_words w
         ORDER BY w.added_at DESC`,
    )
    .all() as WritingWord[];
}

/**
 * Add one or more characters to the library. Duplicates are silently
 * skipped. Returns the count actually added (excludes duplicates).
 */
export function addWritingWords(
  db: Database.Database,
  chars: string[],
  addedBy: string = "parent",
): { added: number; skipped: number } {
  // Sanitize: only single CJK Unified Ideographs (basic block) and a
  // small set of common punctuation. Drop whitespace, control chars,
  // surrogate pairs (Hanzi Writer data is BMP only).
  const valid: string[] = [];
  for (const c of chars) {
    if (/^[\u4E00-\u9FFF]$/.test(c)) valid.push(c);
  }
  if (valid.length === 0) return { added: 0, skipped: chars.length };

  const insert = db.prepare(
    "INSERT OR IGNORE INTO writing_words (char, added_at, added_by) VALUES (?, ?, ?)",
  );
  let added = 0;
  const tx = db.transaction((items: string[]) => {
    for (const c of items) {
      // Date.now() instead of relying on the column DEFAULT — strftime('%s','now')*1000
      // is only second-precision, which makes "newest first" ordering
      // non-deterministic for sub-second batch inserts.
      const info = insert.run(c, Date.now(), addedBy);
      if (info.changes > 0) added++;
    }
  });
  tx(valid);
  return { added, skipped: chars.length - added };
}

/** Delete a word from the library. Returns true if the row existed. */
export function deleteWritingWord(db: Database.Database, char: string): boolean {
  const info = db.prepare("DELETE FROM writing_words WHERE char = ?").run(char);
  return info.changes > 0;
}

/** Get the attempt history for a single character, newest first. */
export function listWritingAttempts(
  db: Database.Database,
  char: string,
  limit: number = 50,
): WritingAttempt[] {
  const rows = db
    .prepare(
      `SELECT id, char, level, stroke_path as strokePath, score,
              display_band as displayBand, status,
              strokes_json as strokesJson,
              assessment_json as assessmentJson,
              process_json as processJson,
              algorithm_version as algorithmVersion,
              model_review_json as modelReviewJson,
              ts
         FROM writing_attempts
         WHERE char = ?
         ORDER BY ts DESC
         LIMIT ?`,
    )
    .all(char, limit) as Array<Record<string, unknown>>;

  return rows.map((row) => {
    const assessment = parseJsonObject(row.assessmentJson);
    return {
      id: Number(row.id),
      char: String(row.char),
      level: Number(row.level),
      strokePath: typeof row.strokePath === "string" ? row.strokePath : null,
      score: typeof row.score === "number" ? row.score : null,
      displayBand: typeof row.displayBand === "string" ? row.displayBand : null,
      status: typeof row.status === "string" ? row.status : null,
      strokes: parseJsonArray(row.strokesJson),
      breakdown: isRecord(assessment?.breakdown) ? assessment.breakdown : null,
      reasons: Array.isArray(assessment?.reasons) ? assessment.reasons : null,
      nextAction: typeof assessment?.nextAction === "string" ? assessment.nextAction : null,
      retryOutcome:
        typeof assessment?.retryOutcome === "string" ? assessment.retryOutcome : null,
      reviewNeeded: assessment?.reviewNeeded === true,
      process: parseJsonObject(row.processJson),
      algorithmVersion:
        typeof row.algorithmVersion === "string" ? row.algorithmVersion : null,
      modelReview: parseJsonObject(row.modelReviewJson),
      ts: Number(row.ts),
    };
  });
}

/** Record one writing attempt. Returns the inserted row id. */
export function recordWritingAttempt(
  db: Database.Database,
  input: {
    char: string;
    level: number;
    strokePath: string | null;
    assessment?: HandwritingAssessmentInput | null;
  },
): number {
  // Same Date.now() reasoning as addWritingWords — sub-second precision
  // ordering matters for the "newest first" attempts list.
  const info = db
    .prepare(
      `INSERT INTO writing_attempts (
         char, level, stroke_path, score, display_band, status,
         strokes_json, assessment_json, process_json,
         algorithm_version, model_review_json, ts
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.char,
      input.level,
      input.strokePath,
      input.assessment?.score ?? null,
      input.assessment?.band ?? null,
      input.assessment?.status ?? null,
      stringifyJson(input.assessment?.strokes),
      stringifyJson(
        input.assessment
          ? {
              breakdown: input.assessment.breakdown,
              reasons: input.assessment.reasons,
              nextAction: input.assessment.nextAction ?? null,
              retryOutcome: input.assessment.retryOutcome ?? null,
              reviewNeeded: input.assessment.reviewNeeded === true,
            }
          : null,
      ),
      stringifyJson(input.assessment?.process),
      input.assessment?.algorithmVersion ?? null,
      stringifyJson(input.assessment?.modelReview),
      Date.now(),
    );
  return Number(info.lastInsertRowid);
}

export function updateWritingAttemptModelReview(
  db: Database.Database,
  attemptId: number,
  modelReview: Record<string, unknown>,
): boolean {
  const info = db
    .prepare("UPDATE writing_attempts SET model_review_json = ? WHERE id = ?")
    .run(JSON.stringify(modelReview), attemptId);
  return info.changes > 0;
}

function stringifyJson(value: unknown): string | null {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function parseJson(value: unknown): unknown {
  if (typeof value !== "string" || value.length === 0) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function parseJsonArray(value: unknown): unknown[] | null {
  const parsed = parseJson(value);
  return Array.isArray(parsed) ? parsed : null;
}

function parseJsonObject(value: unknown): Record<string, any> | null {
  const parsed = parseJson(value);
  return isRecord(parsed) ? parsed : null;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

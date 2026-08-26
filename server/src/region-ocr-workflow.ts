// server/src/region-ocr-workflow.ts
//
// T04-B PR-B: per-region OCR for page-photo drafts. Reads a draft
// row from `mistake_photo_page_drafts`, crops each LayoutRegion,
// feeds the crop into `analyzeMistakeImage`, and writes a row per
// region to `mistake_photo_candidates`.
//
// Failure model: one region failing (vision timeout, model refusal,
// etc.) MUST NOT block the other regions. We log + skip and let the
// caller decide what to do. Empty regions → zero candidates, no
// error.
//
// First slice: writes only `problem` + `confidence` + `vision_*`
// fields. user_answer / correct_answer / error_type stay NULL —
// the closure loop (T04-C) lets the kid fill those in when
// confirming the candidate.

import type Database from "better-sqlite3";
import { cropRegion, type NormalizedBBox } from "./region-crop.js";
import { analyzeMistakeImage, type VisionClient } from "./vision.js";

export interface PageDraftRow {
  id: string;
  childId: string;
  sessionId: string;
  deviceId: string;
  layoutRegions: LayoutRegion[];
  imageBytes: Buffer;
  imageExtension: string;
}

export interface LayoutRegion {
  index: number;
  bbox: NormalizedBBox;
  subject: string;
}

export interface RegionCandidate {
  regionIndex: number;
  subject: string;
  problem: string | null;
  confidence: "ok" | "low";
  visionModel: string;
  errorMessage?: string;
}

export interface RunRegionOcrDeps {
  db: Database.Database;
  visionClient: VisionClient;
  now?: () => number;
}

/**
 * For each region in the draft, crop + analyze + INSERT. Returns the
 * candidates that were written (skipping failures). The draft row is
 * NOT mutated here — that lives in the route handler so we can return
 * a 200 even if zero candidates were produced.
 */
export async function runRegionOcr(
  draft: PageDraftRow,
  deps: RunRegionOcrDeps,
): Promise<RegionCandidate[]> {
  const { db, visionClient, now = Date.now } = deps;
  const candidates: RegionCandidate[] = [];
  const insert = db.prepare(
    `INSERT INTO mistake_photo_candidates
       (draft_id, child_id, session_id, device_id, region_index,
        subject, problem, user_answer, correct_answer, error_type,
        confidence, vision_model, vision_reasoning, vision_input, vision_ts, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?)`,
  );

  for (const region of draft.layoutRegions) {
    try {
      const cropBuf = await cropRegion(draft.imageBytes, region.bbox);
      const base64 = cropBuf.toString("base64");
      const analysis = await analyzeMistakeImage(visionClient, base64);

      insert.run(
        draft.id,
        draft.childId,
        draft.sessionId,
        draft.deviceId,
        region.index,
        region.subject,
        analysis.problemText,
        analysis.confidence,
        analysis.model,
        analysis.reasoning,
        base64.slice(0, 200), // truncate vision_input for storage
        now(),
        now(),
      );

      candidates.push({
        regionIndex: region.index,
        subject: region.subject,
        problem: analysis.problemText,
        confidence: analysis.confidence,
        visionModel: analysis.model,
      });
    } catch (err) {
      // One region failing must NOT abort the workflow. Record a
      // low-confidence "no problem" candidate so the kid can still
      // see "region 2 didn't read" in the review UI (T04-C) and
      // retake or type manually.
      const message = err instanceof Error ? err.message : String(err);
      insert.run(
        draft.id,
        draft.childId,
        draft.sessionId,
        draft.deviceId,
        region.index,
        region.subject,
        null,
        "low",
        "n/a",
        message,
        null,
        now(),
        now(),
      );
      candidates.push({
        regionIndex: region.index,
        subject: region.subject,
        problem: null,
        confidence: "low",
        visionModel: "n/a",
        errorMessage: message,
      });
    }
  }

  return candidates;
}

/** Helper to load + parse a draft row from the DB into PageDraftRow. */
export function loadPageDraft(
  db: Database.Database,
  draftId: string,
): PageDraftRow | null {
  const row = db
    .prepare(
      `SELECT id, child_id AS childId, session_id AS sessionId,
              device_id AS deviceId, layout_regions_json AS layoutRegionsJson,
              image_bytes AS imageBytes, image_extension AS imageExtension
         FROM mistake_photo_page_drafts
        WHERE id = ?`,
    )
    .get(draftId) as
    | {
        id: string;
        childId: string;
        sessionId: string;
        deviceId: string;
        layoutRegionsJson: string;
        imageBytes: Buffer;
        imageExtension: string;
      }
    | undefined;
  if (!row) return null;
  const regions = JSON.parse(row.layoutRegionsJson) as LayoutRegion[];
  return {
    id: row.id,
    childId: row.childId,
    sessionId: row.sessionId,
    deviceId: row.deviceId,
    layoutRegions: regions,
    imageBytes: row.imageBytes,
    imageExtension: row.imageExtension,
  };
}

// server/src/region-ocr-workflow.test.ts
//
// T04B-3 + T04B-4: runRegionOcr inserts one row per region; a
// region failing (vision throw) does NOT abort the workflow — it
// inserts a low-confidence "no problem" row so the review UI can
// still surface it.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import sharp from "sharp";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "./db-migrate.js";
import {
  loadPageDraft,
  runRegionOcr,
  type LayoutRegion,
} from "./region-ocr-workflow.js";
import { seedTestDevice } from "./test-device.js";
import type { VisionClient } from "./vision.js";

let db: Database.Database;
let tmpDir: string;
let testImage: Buffer;

const CHILD = "default";
const DEVICE = "test-device-region-ocr";
const SESSION = "sess-region-ocr";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-region-ocr-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);

  // seed a child + device (FK targets for the draft)
  db.prepare(
    `INSERT OR IGNORE INTO children (id, name, grade) VALUES (?, ?, ?)`,
  ).run(CHILD, "小宝", "二年级");
  seedTestDevice(db);
  // overwrite the seeded device_id so it matches our test (the seeder
  // uses a fixed name; here we just need a real device row)
  db.prepare(
    `INSERT OR REPLACE INTO paired_devices
       (device_id, child_id, credential_hash, device_name, created_at, last_seen_at)
     VALUES (?, ?, 'test-hash', 'test-region-ocr', 0, 0)`,
  ).run(DEVICE, CHILD);
  db.prepare(
    `INSERT OR REPLACE INTO sessions
       (id, child_id, device_id, started_at, subject)
     VALUES (?, ?, ?, 0, 'math')`,
  ).run(SESSION, CHILD, DEVICE);

  // 64x64 4-color test image (deterministic, easy to crop)
  testImage = await sharp({
    create: {
      width: 64,
      height: 64,
      channels: 3,
      background: { r: 200, g: 200, b: 200 },
    },
  })
    .png()
    .toBuffer();
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // wipe candidates + drafts between tests
  db.exec(`DELETE FROM mistake_photo_candidates`);
  db.exec(`DELETE FROM mistake_photo_page_drafts`);
});

function insertDraft(draftId: string, regions: LayoutRegion[]): void {
  db.prepare(
    `INSERT INTO mistake_photo_page_drafts
       (id, child_id, session_id, device_id, state,
        layout_model, layout_regions_json, layout_confidence,
        image_bytes, image_extension, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'review', 'fake-model', ?, 'ok', ?, 'jpg', 0, ?)`,
  ).run(
    draftId,
    CHILD,
    SESSION,
    DEVICE,
    JSON.stringify(regions),
    testImage,
    Date.now() + 60_000,
  );
}

function visionClientReturning(
  responses: Array<{ problemText?: string; shouldThrow?: boolean }>,
): VisionClient {
  let i = 0;
  return {
    async chat() {
      const r = responses[i++];
      if (!r) throw new Error(`vision mock: no response for call ${i}`);
      if (r.shouldThrow) throw new Error("vision timeout (mock)");
      // parseVisionResponse reads raw "题目: ..." text directly, not JSON.
      return {
        content: r.problemText ?? "",
        raw: null,
      };
    },
  };
}

describe("runRegionOcr (T04-B PR-B)", () => {
  it("T04B-3a: 2 regions → 2 candidate rows with problem text from vision", async () => {
    insertDraft("draft-1", [
      { index: 0, bbox: [0, 0, 0.5, 0.5], subject: "math" },
      { index: 1, bbox: [0.5, 0.5, 1, 1], subject: "math" },
    ]);
    const draft = loadPageDraft(db, "draft-1");
    expect(draft).not.toBeNull();

    const vision = visionClientReturning([
      { problemText: "题目: 3+4=?" },
      { problemText: "题目: 5-2=?" },
    ]);
    const candidates = await runRegionOcr(draft!, { db, visionClient: vision });

    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({
      regionIndex: 0,
      problem: "3+4=?",
      confidence: "ok",
    });
    expect(candidates[1]).toMatchObject({
      regionIndex: 1,
      problem: "5-2=?",
      confidence: "ok",
    });

    const rows = db
      .prepare(
        `SELECT region_index, problem, confidence FROM mistake_photo_candidates
          WHERE draft_id = ? ORDER BY region_index`,
      )
      .all("draft-1") as Array<{
        region_index: number;
        problem: string;
        confidence: string;
      }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ region_index: 0, problem: "3+4=?", confidence: "ok" });
    expect(rows[1]).toEqual({ region_index: 1, problem: "5-2=?", confidence: "ok" });
  });

  it("T04B-3b: 0 regions → 0 candidate rows, no error", async () => {
    insertDraft("draft-empty", []);
    const draft = loadPageDraft(db, "draft-empty");
    expect(draft).not.toBeNull();

    const vision = visionClientReturning([]); // never called
    const candidates = await runRegionOcr(draft!, { db, visionClient: vision });
    expect(candidates).toEqual([]);
    const rows = db
      .prepare(`SELECT count(*) as n FROM mistake_photo_candidates WHERE draft_id = ?`)
      .get("draft-empty") as { n: number };
    expect(rows.n).toBe(0);
  });

  it("T04B-4a: region 1 vision throws → region 0 candidate written, region 1 marked low", async () => {
    insertDraft("draft-partial", [
      { index: 0, bbox: [0, 0, 0.5, 1.0], subject: "math" },
      { index: 1, bbox: [0.5, 0, 1.0, 1.0], subject: "math" },
    ]);
    const draft = loadPageDraft(db, "draft-partial");
    expect(draft).not.toBeNull();

    const vision = visionClientReturning([
      { problemText: "题目: 3+4=?" },
      { shouldThrow: true },
    ]);
    const candidates = await runRegionOcr(draft!, { db, visionClient: vision });

    // Workflow does NOT throw; both regions are reported in the
    // return value (one success, one low-confidence "no problem").
    expect(candidates).toHaveLength(2);
    expect(candidates[0]).toMatchObject({ regionIndex: 0, problem: "3+4=?", confidence: "ok" });
    expect(candidates[1]).toMatchObject({
      regionIndex: 1,
      problem: null,
      confidence: "low",
      errorMessage: "vision timeout (mock)",
    });

    const rows = db
      .prepare(
        `SELECT region_index, problem, confidence, vision_reasoning
           FROM mistake_photo_candidates
          WHERE draft_id = ?
          ORDER BY region_index`,
      )
      .all("draft-partial") as Array<{
        region_index: number;
        problem: string | null;
        confidence: string;
        vision_reasoning: string | null;
      }>;
    expect(rows).toHaveLength(2);
    expect(rows[0].problem).toBe("3+4=?");
    expect(rows[0].confidence).toBe("ok");
    expect(rows[1].problem).toBeNull();
    expect(rows[1].confidence).toBe("low");
    expect(rows[1].vision_reasoning).toMatch(/vision timeout/);
  });

  it("T04B-4b: all regions fail → 0 ok candidates, N low candidates, no throw", async () => {
    insertDraft("draft-allfail", [
      { index: 0, bbox: [0, 0, 0.5, 0.5], subject: "math" },
      { index: 1, bbox: [0.5, 0, 1.0, 0.5], subject: "math" },
    ]);
    const draft = loadPageDraft(db, "draft-allfail");
    expect(draft).not.toBeNull();

    const vision = visionClientReturning([
      { shouldThrow: true },
      { shouldThrow: true },
    ]);
    const candidates = await runRegionOcr(draft!, { db, visionClient: vision });
    expect(candidates).toHaveLength(2);
    expect(candidates.every((c) => c.confidence === "low")).toBe(true);
    expect(candidates.every((c) => c.problem === null)).toBe(true);
  });
});

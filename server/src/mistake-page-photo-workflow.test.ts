// server/src/mistake-page-photo-workflow.test.ts
//
// Tests for the page-photo multi-candidate capture workflow
// (SB124-T04 #128). Strategy B: layout analysis first, then
// per-region OCR. This file covers the workflow's persistence + layout
// pass (T04-A). The per-region OCR + candidate table arrive in
// T04-B. The confirm/discard/cancel flow arrives in T04-C.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { migrateSchema } from "./db-migrate.js";
import { MistakePagePhotoWorkflow } from "./mistake-page-photo-workflow.js";

let db: Database.Database;
let tmpDir: string;
let workflow: MistakePagePhotoWorkflow;

const CHILD = "default";
const SESSION = "sess_1";
const DEVICE = "dev_1";

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-page-photo-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  // Seed the FK parents the page_drafts table references.
  db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run("default", "Default");
  db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run("alice", "Alice");
  db.prepare(
    "INSERT OR IGNORE INTO paired_devices (device_id, child_id, credential_hash, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("dev_1", "default", "hash-1", "Test Device", Date.now(), Date.now());
  db.prepare(
    "INSERT OR IGNORE INTO paired_devices (device_id, child_id, credential_hash, device_name, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?)",
  ).run("dev_alice", "alice", "hash-alice", "Alice Device", Date.now(), Date.now());
  db.prepare("INSERT OR IGNORE INTO sessions (id, child_id, started_at) VALUES (?, ?, ?)").run("sess_1", "default", Date.now());
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Wipe drafts between tests so id collisions don't cross runs.
  db.prepare("DELETE FROM mistake_photo_page_drafts").run();
  workflow = new MistakePagePhotoWorkflow({ db });
});

function fakeLayout(extra: object = {}) {
  return {
    analyze: async () => ({
      regions: [
        { index: 1, bbox: [0.05, 0.10, 0.95, 0.20] as [number, number, number, number], subject: "math" as const },
        { index: 2, bbox: [0.05, 0.30, 0.95, 0.40] as [number, number, number, number], subject: "math" as const },
      ],
      confidence: "ok" as const,
      model: "MiniMax-M3",
      raw: { id: "test" },
      ...extra,
    }),
  };
}

describe("MistakePagePhotoWorkflow.createPageDraft", () => {
  it("persists a draft row and returns the layout regions", async () => {
    const draft = await workflow.createPageDraft({
      childId: CHILD,
      sessionId: SESSION,
      deviceId: DEVICE,
      bytes: Buffer.from("fake-jpeg"),
      extension: "jpg",
      ...fakeLayout(),
    });
    expect(draft.id).toMatch(/^page_/);
    expect(draft.state).toBe("review");
    expect(draft.regions).toHaveLength(2);
    expect(draft.regions[0].subject).toBe("math");
    expect(draft.layoutConfidence).toBe("ok");
    expect(draft.layoutModel).toBe("MiniMax-M3");
    // Persisted to DB
    const row = db
      .prepare("SELECT id, state, layout_regions_json FROM mistake_photo_page_drafts WHERE id = ?")
      .get(draft.id) as { id: string; state: string; layout_regions_json: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.state).toBe("review");
    const stored = JSON.parse(row!.layout_regions_json);
    expect(stored).toHaveLength(2);
  });

  it("saves the image bytes (for later per-region OCR in T04-B)", async () => {
    const bytes = Buffer.from("a-fake-png-with-three-questions");
    const draft = await workflow.createPageDraft({
      childId: CHILD,
      sessionId: SESSION,
      deviceId: DEVICE,
      bytes,
      extension: "png",
      ...fakeLayout(),
    });
    const row = db
      .prepare("SELECT image_bytes, image_extension FROM mistake_photo_page_drafts WHERE id = ?")
      .get(draft.id) as { image_bytes: Buffer; image_extension: string };
    expect(row.image_bytes.equals(bytes)).toBe(true);
    expect(row.image_extension).toBe("png");
  });

  it("stores 'low' confidence when the layout returns no regions", async () => {
    const draft = await workflow.createPageDraft({
      childId: CHILD,
      sessionId: SESSION,
      deviceId: DEVICE,
      bytes: Buffer.from("fake"),
      extension: "jpg",
      ...fakeLayout({ regions: [], confidence: "low" }),
    });
    expect(draft.state).toBe("review"); // still review — parent can edit/discard manually
    expect(draft.layoutConfidence).toBe("low");
    expect(draft.regions).toEqual([]);
  });

  it("rejects the same draftId if already in flight (idempotency key)", async () => {
    // Not strictly required by spec but defensive against double-tap
    // on the upload button. The photo workflow uses `draftId` as an
    // idempotency key; the page workflow mirrors that.
    const draftId = "page_dup_test_001";
    const a = await workflow.createPageDraft({
      id: draftId,
      childId: CHILD,
      sessionId: SESSION,
      deviceId: DEVICE,
      bytes: Buffer.from("first"),
      extension: "jpg",
      ...fakeLayout(),
    });
    // Second call with the same id should return the existing draft,
    // NOT re-run analysis (which would re-call the vision API).
    const b = await workflow.createPageDraft({
      id: draftId,
      childId: CHILD,
      sessionId: SESSION,
      deviceId: DEVICE,
      bytes: Buffer.from("second"),
      extension: "jpg",
      ...fakeLayout(),
    });
    expect(a.id).toBe(b.id);
    // Only ONE row in the DB
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM mistake_photo_page_drafts WHERE id = ?")
      .get(draftId) as { c: number };
    expect(count.c).toBe(1);
  });
});

describe("MistakePagePhotoWorkflow.getPageDraft", () => {
  it("returns the persisted draft by id", async () => {
    const created = await workflow.createPageDraft({
      childId: CHILD,
      sessionId: SESSION,
      deviceId: DEVICE,
      bytes: Buffer.from("x"),
      extension: "jpg",
      ...fakeLayout(),
    });
    const fetched = await workflow.getPageDraft(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
    expect(fetched!.regions).toHaveLength(2);
  });

  it("returns null for a non-existent id", async () => {
    const fetched = await workflow.getPageDraft("page_does_not_exist");
    expect(fetched).toBeNull();
  });

  it("rejects access from a different child (cross-child isolation)", async () => {
    const created = await workflow.createPageDraft({
      childId: CHILD,
      sessionId: SESSION,
      deviceId: DEVICE,
      bytes: Buffer.from("x"),
      extension: "jpg",
      ...fakeLayout(),
    });
    const fetched = await workflow.getPageDraft(created.id, { childId: "alice" });
    expect(fetched).toBeNull();
  });
});

// server/src/page-photo-region.test.ts
//
// T04B-5: POST /api/mistake-photo/page/:draftId/regions runs
// per-region OCR. This file covers the happy path + the auth
// boundary cases (cross-child 404, cross-session 403) that the
// workflow alone can't catch.

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import sharp from "sharp";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { seedTestDevice, TEST_DEVICE } from "./test-device.js";
import { MistakePagePhotoWorkflow } from "./mistake-page-photo-workflow.js";
import type { VisionClient } from "./vision.js";

let db: Database.Database;
let tmpDir: string;
let testImage: Buffer;

const CHILD = TEST_DEVICE.childId; // "default"
const DEVICE = "default"; // v0.5 no-pairing: virtual device
const SESSION_OTHER = "sess-other-foreign";
let sessionId = "";

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-page-photo-region-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("foreign_keys = ON");
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  seedTestDevice(db);
  // FK targets: a second child + a second session the cross-child /
  // cross-session tests can reference without violating FKs.
  db.prepare(`INSERT OR IGNORE INTO children (id, name, grade) VALUES ('bob', 'Bob', '三年级')`).run();
  db.prepare(
    `INSERT OR REPLACE INTO sessions (id, child_id, device_id, started_at, subject)
     VALUES (?, ?, ?, 0, 'math')`,
  ).run(SESSION_OTHER, "default", DEVICE);
  // The auth middleware hardcodes TEST_DEVICE = (test-device, default),
  // so we MUST start the session via /api/session/start (which writes
  // the device_id into sessions) — direct INSERT with a session/device
  // mismatch trips findOwnedActiveSession.
  const bootApp = createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    pagePhotoWorkflow: new MistakePagePhotoWorkflow({ db }),
  });
  const start = await request(bootApp)
    .post("/api/session/start")
    .send({ subject: "math" });
  expect(start.status).toBe(200);
  sessionId = start.body.sessionId;
  // Mirror the session id under the alias we use in tests so seedDraft
  // can target a known session. We keep DEVICE/CHILD in sync with
  // TEST_DEVICE so the cross-session test (#T04B-5b) only flips the
  // session id.
  SESSION_REAL = sessionId;

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

let SESSION_REAL = "";

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.exec(`DELETE FROM mistake_photo_candidates`);
  db.exec(`DELETE FROM mistake_photo_page_drafts`);});

function seedDraft(
  draftId: string,
  overrides: {
    childId?: string;
    sessionId?: string;
    deviceId?: string;
    regions?: Array<{ index: number; bbox: [number, number, number, number]; subject: string }>;
  } = {},
): void {
  const regions = overrides.regions ?? [
    { index: 0, bbox: [0, 0, 0.5, 0.5] as [number, number, number, number], subject: "math" },
    { index: 1, bbox: [0.5, 0.5, 1, 1] as [number, number, number, number], subject: "math" },
  ];
  db.prepare(
    `INSERT INTO mistake_photo_page_drafts
       (id, child_id, session_id, device_id, state,
        layout_model, layout_regions_json, layout_confidence,
        image_bytes, image_extension, created_at, expires_at)
     VALUES (?, ?, ?, ?, 'review', 'fake-model', ?, 'ok', ?, 'jpg', 0, ?)`,
  ).run(
    draftId,
    overrides.childId ?? CHILD,
    overrides.sessionId ?? SESSION_REAL,
    overrides.deviceId ?? DEVICE,
    JSON.stringify(regions),
    testImage,
    Date.now() + 60_000,
  );
}

function fakeVision(): VisionClient {
  let i = 0;
  return {
    async chat() {
      i++;
      return {
        content: i === 1 ? "题目: 3+4=?" : "题目: 5-2=?",
        raw: null,
      };
    },
  };
}

function makeAppWith(vision: VisionClient | null) {
  return createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    visionClient: vision,
    pagePhotoWorkflow: new MistakePagePhotoWorkflow({ db }),
  });
}

describe("POST /api/mistake-photo/page/:draftId/regions (T04-B PR-B)", () => {
  it("T04B-5a: 200 with candidates when draft matches session + device", async () => {
    seedDraft("draft_happy_001");
    const appWithVision = makeAppWith(fakeVision());
    const res = await request(appWithVision)
      .post("/api/mistake-photo/page/draft_happy_001/regions")
      .send({ sessionId });    expect(res.status).toBe(200);
    expect(res.body.draftId).toBe("draft_happy_001");
    expect(res.body.candidates).toHaveLength(2);
    expect(res.body.candidates[0]).toMatchObject({
      regionIndex: 0,
      problem: "3+4=?",
      confidence: "ok",
    });
    expect(res.body.candidates[1]).toMatchObject({
      regionIndex: 1,
      problem: "5-2=?",
      confidence: "ok",
    });
  });

  it("T04B-5b: 403 when draft session_id doesn't match the caller's session", async () => {
    seedDraft("draft_other_sess_002", { sessionId: SESSION_OTHER });
    const appWithVision = makeAppWith(fakeVision());
    const res = await request(appWithVision)
      .post("/api/mistake-photo/page/draft_other_sess_002/regions")
      .send({ sessionId });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/session/i) });
  });

  it("T04B-5c: 404 when draft belongs to another child (cross-child isolation)", async () => {
    seedDraft("draft_other_child_03", { childId: "bob" });
    const appWithVision = makeAppWith(fakeVision());
    const res = await request(appWithVision)
      .post("/api/mistake-photo/page/draft_other_child_03/regions")
      .send({ sessionId });
    expect(res.status).toBe(404);
  });

  it("T04B-5d: 404 when draft id doesn't exist at all", async () => {
    const appWithVision = makeAppWith(fakeVision());
    const res = await request(appWithVision)
      .post("/api/mistake-photo/page/draft_does_not_exist_04/regions")
      .send({ sessionId });
    expect(res.status).toBe(404);
  });

  it("T04B-5e: 503 when no vision client is configured", async () => {
    seedDraft("draft_no_vision_005");
    const appNoVision = makeAppWith(null);
    const res = await request(appNoVision)
      .post("/api/mistake-photo/page/draft_no_vision_005/regions")
      .send({ sessionId });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: expect.stringMatching(/vision/i) });
  });

  it("T04B-5f: 200 with empty candidates when draft has 0 regions", async () => {
    seedDraft("draft_empty_006", { regions: [] });
    const appWithVision = makeAppWith(fakeVision());
    const res = await request(appWithVision)
      .post("/api/mistake-photo/page/draft_empty_006/regions")
      .send({ sessionId });
    expect(res.status).toBe(200);
    expect(res.body.candidates).toEqual([]);
  });
});

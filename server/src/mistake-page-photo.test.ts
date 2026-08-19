// server/src/mistake-page-photo.test.ts
//
// Tests for the page-photo multi-candidate capture route
// (SB124-T04 #128). This file covers the T04-A endpoints:
//   POST /api/mistake-photo/page     — upload a page photo, run layout analysis
//   GET  /api/mistake-photo/page/:id — fetch the persisted draft
//
// Per-region OCR arrives in T04-B; confirm/discard in T04-C.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { MistakePagePhotoWorkflow } from "./mistake-page-photo-workflow.js";
import { seedTestDevice, testDeviceAuthenticator } from "./test-device.js";
import type { VisionClient } from "./vision.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;
let workflow: MistakePagePhotoWorkflow;
let fakeVision: VisionClient;
let sessionId = "";

const CHILD = "default";

function makeFakeJpeg(): Buffer {
  // 1x1 white JPEG. sharp will accept it; we only care about the
  // upload + flow, not the actual image content.
  return Buffer.from([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
    0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00, 0xff, 0xdb, 0x00, 0x43,
    0x00, 0x08, 0x06, 0x06, 0x07, 0x06, 0x05, 0x08, 0x07, 0x07, 0x07, 0x09,
    0x09, 0x08, 0x0a, 0x0c, 0x14, 0x0d, 0x0c, 0x0b, 0x0b, 0x0c, 0x19, 0x12,
    0x13, 0x0f, 0x14, 0x1d, 0x1a, 0x1f, 0x1e, 0x1d, 0x1a, 0x1c, 0x1c, 0x20,
    0x24, 0x2e, 0x27, 0x20, 0x22, 0x2c, 0x23, 0x1c, 0x1c, 0x28, 0x37, 0x29,
    0x2c, 0x30, 0x31, 0x34, 0x34, 0x34, 0x1f, 0x27, 0x39, 0x3d, 0x38, 0x32,
    0x3c, 0x2e, 0x33, 0x34, 0x32, 0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x01,
    0x00, 0x01, 0x01, 0x01, 0x11, 0x00, 0xff, 0xc4, 0x00, 0x1f, 0x00, 0x00,
    0x01, 0x05, 0x01, 0x01, 0x01, 0x01, 0x01, 0x01, 0x00, 0x00, 0x00, 0x00,
    0x00, 0x00, 0x00, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08,
    0x09, 0x0a, 0x0b, 0xff, 0xc4, 0x00, 0xb5, 0x10, 0x00, 0x02, 0x01, 0x03,
    0x03, 0x02, 0x04, 0x03, 0x05, 0x05, 0x04, 0x04, 0x00, 0x00, 0x01, 0x7d,
    0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06,
    0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08,
    0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72,
    0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28,
    0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45,
    0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59,
    0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75,
    0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89,
    0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3,
    0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6,
    0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9,
    0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2,
    0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4,
    0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa, 0xff, 0xda, 0x00, 0x08, 0x01, 0x01,
    0x00, 0x00, 0x3f, 0x00, 0xfb, 0xd1, 0xff, 0xd9,
  ]);
}

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-page-photo-route-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  seedTestDevice(db);

  fakeVision = {
    async chat() {
      return {
        content: JSON.stringify([
          { index: 1, bbox: [0.05, 0.10, 0.95, 0.20], subject: "math" },
          { index: 2, bbox: [0.05, 0.30, 0.95, 0.40], subject: "math" },
        ]),
        raw: { id: "vision-call" },
      };
    },
  };

  workflow = new MistakePagePhotoWorkflow({ db });
  app = createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    visionClient: fakeVision,
    pagePhotoWorkflow: workflow,
    deviceAuthenticator: testDeviceAuthenticator,
  });

  // Start a session for the default child (testDeviceAuthenticator
  // auto-resolves deviceId="test-device", childId="default"). The
  // route's requireOwnedActiveSession reads sessionId from the form
  // body / query.
  const start = await request(app)
    .post("/api/session/start")
    .send({ subject: "math" });
  expect(start.status).toBe(200);
  sessionId = start.body.sessionId;
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare("DELETE FROM mistake_photo_page_drafts").run();
});

describe("POST /api/mistake-photo/page", () => {
  it("creates a draft with layout regions from a valid page photo", async () => {
    const res = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", sessionId)
      .field("draftId", "page_route_test_001")
      .attach("photo", makeFakeJpeg(), { filename: "page.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(201);
    expect(res.body.id).toBe("page_route_test_001");
    expect(res.body.state).toBe("review");
    expect(res.body.regions).toHaveLength(2);
    expect(res.body.regions[0].subject).toBe("math");
    expect(res.body.layoutConfidence).toBe("ok");
    expect(res.body.childId).toBe(CHILD);
  });

  it("returns 400 when no photo is attached", async () => {
    const res = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", sessionId)
      .field("draftId", "page_route_no_photo");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/photo/);
  });

  it("returns 400 when no draftId is provided", async () => {
    const res = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", sessionId)
      .attach("photo", makeFakeJpeg(), { filename: "page.jpg", contentType: "image/jpeg" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/draftId/);
  });

  it("returns 415 when photo type is unsupported", async () => {
    const res = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", sessionId)
      .field("draftId", "page_route_bad_type")
      .attach("photo", Buffer.from("not a real image"), { filename: "page.gif", contentType: "image/gif" });
    expect(res.status).toBe(415);
  });

  it("is idempotent on the same draftId (returns the existing draft)", async () => {
    const first = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", sessionId)
      .field("draftId", "page_route_idempotent")
      .attach("photo", makeFakeJpeg(), { filename: "page.jpg", contentType: "image/jpeg" });
    expect(first.status).toBe(201);
    const second = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", sessionId)
      .field("draftId", "page_route_idempotent")
      .attach("photo", makeFakeJpeg(), { filename: "page.jpg", contentType: "image/jpeg" });
    expect(second.status).toBe(201);
    expect(second.body.id).toBe(first.body.id);
  });

  it("returns 403 when the device has no active session", async () => {
    // Pass a sessionId that was never paired to this device.
    const res = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", "session_does_not_exist")
      .field("draftId", "page_route_orphan")
      .attach("photo", makeFakeJpeg(), { filename: "page.jpg", contentType: "image/jpeg" });
    // not-found or forbidden — both are valid "no access" responses
    expect([403, 404]).toContain(res.status);
  });
});

describe("GET /api/mistake-photo/page/:id", () => {
  it("returns the persisted draft with regions", async () => {
    const post = await request(app)
      .post("/api/mistake-photo/page")
      .field("sessionId", sessionId)
      .field("draftId", "page_route_get_001")
      .attach("photo", makeFakeJpeg(), { filename: "page.jpg", contentType: "image/jpeg" });
    const id = post.body.id;
    const res = await request(app)
      .get(`/api/mistake-photo/page/${id}?sessionId=${sessionId}`);
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(id);
    expect(res.body.regions).toHaveLength(2);
  });

  it("returns 404 for a non-existent id", async () => {
    const res = await request(app)
      .get(`/api/mistake-photo/page/page_does_not_exist?sessionId=${sessionId}`);
    expect(res.status).toBe(404);
  });
});

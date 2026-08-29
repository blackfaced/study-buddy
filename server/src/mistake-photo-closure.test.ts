// server/src/mistake-photo-closure.test.ts
//
// T10 mirror work on the server side (issue #166): vision confirm
// path used to write the legacy `mistakes` mirror + call the compat
// bridge. After T10, it must write the closure-loop primary tables
// directly via `insertMistake()` — same path as `/api/capture/manual`
// and the game `/api/game/mistake` flow. These tests pin the new
// contract end-to-end.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { memorySink, createLogger } from "./logger.js";
import { MistakePhotoWorkflow } from "./mistake-photo-workflow.js";
import { seedTestDevice, testDeviceAuthenticator } from "./test-device.js";
import sharp from "sharp";
import type { VisionClient } from "./vision.js";
import type { DeviceRequestAuthenticator } from "./device-auth.js";

let db: Database.Database;
let mistakesDir: string;
let providerCalls = 0;
let validJpeg: Buffer;
const logMemory = memorySink();
const logger = createLogger({ sinks: [logMemory.sink] });

function fakeVisionClient(content = "题目：1 + 1"): VisionClient {
  return {
    async chat() {
      providerCalls += 1;
      return { content, raw: { secretProviderPayload: true } };
    },
  };
}

beforeAll(async () => {
  db = new Database(":memory:");
  migrateSchema(db);
  seedTestDevice(db);
  mistakesDir = mkdtempSync(join(tmpdir(), "study-buddy-vision-closure-"));
  validJpeg = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  }).jpeg().toBuffer();
});

afterAll(() => {
  db.close();
  rmSync(mistakesDir, { recursive: true, force: true });
});

beforeEach(() => {
  db.prepare("DELETE FROM mistake_photo_confirmations").run();
  db.prepare("DELETE FROM learning_attempts").run();
  db.prepare("DELETE FROM correction_obligations").run();
  db.prepare("DELETE FROM mistake_cases").run();
  db.prepare("DELETE FROM mistakes").run();
  db.prepare("DELETE FROM sessions").run();
  // source_events is immutable; tests rely on insert sequence
  // counting from the prior beforeAll/beforeEach baseline.
  providerCalls = 0;
});

function makeApp(options: {
  visionClient?: VisionClient | null;
  workflow?: MistakePhotoWorkflow;
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void;
  authenticator?: DeviceRequestAuthenticator;
} = {}) {
  return createApp({
    db,
    visionClient: options.visionClient === undefined ? fakeVisionClient() : options.visionClient,
    mistakesDir,
    deviceAuthenticator: options.authenticator ?? testDeviceAuthenticator,
    logger,
    mistakePhotoWorkflow: options.workflow,
    beforeSourceEventAppend: options.beforeSourceEventAppend,
  });
}

async function startSession(app: ReturnType<typeof createApp>) {
  const response = await request(app).post("/api/session/start").send({ subject: "math" });
  expect(response.status).toBe(200);
  return response.body.sessionId as string;
}

async function analyzeAndConfirm(
  app: ReturnType<typeof createApp>,
  sessionId: string,
  draftId: string,
  problemText: string,
) {
  const analysis = await request(app)
    .post("/api/mistake-photo")
    .field("sessionId", sessionId)
    .field("draftId", draftId)
    .attach("photo", validJpeg, {
      filename: "homework.jpg",
      contentType: "image/jpeg",
    });
  expect(analysis.status).toBe(200);
  const confirm = await request(app)
    .post(`/api/mistake-photo/${draftId}/confirm`)
    .send({ sessionId, problemText });
  return { analysis, confirm };
}

describe("Vision path → closure loop (issue #166)", () => {
  it("V-1: confirm creates 1 mistake_case + 1 learning_attempt (original) + 1 correction_obligation (open)", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const { confirm } = await analyzeAndConfirm(app, sessionId, "draft_v1", "1 + 1");
    expect(confirm.status).toBe(200);
    expect(confirm.body).toMatchObject({ state: "confirmed" });

    const cases = db.prepare("SELECT case_id, child_id, source, problem, subject FROM mistake_cases").all() as Array<{ case_id: string; child_id: string; source: string; problem: string; subject: string }>;
    expect(cases).toHaveLength(1);
    expect(cases[0]).toMatchObject({
      child_id: "default",
      source: "vision",
      problem: "1 + 1",
      subject: "math",
    });

    const attempts = db.prepare("SELECT attempt_kind, is_correct, child_id FROM learning_attempts").all() as Array<{ attempt_kind: string; is_correct: number; child_id: string }>;
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toEqual({ attempt_kind: "original", is_correct: 0, child_id: "default" });

    const obligations = db.prepare("SELECT status FROM correction_obligations").all() as Array<{ status: string }>;
    expect(obligations).toHaveLength(1);
    expect(obligations[0]).toEqual({ status: "open" });
  });

  it("V-2: idempotent retry of confirm returns same caseId, does not create a second case", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const first = await analyzeAndConfirm(app, sessionId, "draft_v2", "1 + 1");
    expect(first.confirm.status).toBe(200);

    // Idempotent retry — fresh workflow simulates an HTTP restart.
    const restarted = makeApp();
    const retry = await request(restarted)
      .post(`/api/mistake-photo/draft_v2/confirm`)
      .send({ sessionId, problemText: "1 + 1" });
    expect(retry.status).toBe(200);
    expect(retry.body.caseId ?? retry.body.mistakeId).toBeDefined();

    const caseCount = db
      .prepare("SELECT COUNT(*) AS c FROM mistake_cases")
      .get() as { c: number };
    expect(caseCount.c).toBe(1);

    const attempts = db
      .prepare("SELECT COUNT(*) AS c FROM learning_attempts")
      .get() as { c: number };
    expect(attempts.c).toBe(1);
  });

  it("V-3: source_event emitted with full payload (closure-loop record path)", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const { confirm } = await analyzeAndConfirm(app, sessionId, "draft_v3", "1 + 1");
    expect(confirm.status).toBe(200);
    const caseId = (confirm.body as { caseId?: string }).caseId;
    expect(caseId).toMatch(/^case:/);
    // The current server-side appendLearningAttemptSourceEvent
    // records the source event under `mistake:${mistakeId}`; the
    // closure-loop reader joins back to mistake_cases via the
    // mirror's id. PR-D v2.4 will switch the record_id to
    // `case:${case_id}`; until then we just verify the event fires
    // and the payload carries the closure-loop evidence.
    const events = db
      .prepare(
        "SELECT record_id, event_type, payload_json FROM source_events",
      )
      .all() as Array<{ record_id: string; event_type: string; payload_json: string }>;
    const attemptEvent = events.find(
      (e) => e.event_type === "learning_attempt_recorded"
        && JSON.parse(e.payload_json).problem === "1 + 1",
    );
    expect(attemptEvent).toBeDefined();
    const payload = JSON.parse(attemptEvent!.payload_json);
    expect(payload).toMatchObject({
      kind: "learning_attempt",
      subject: "math",
      problem: "1 + 1",
      source: "vision",
    });
  });

  it("V-4: mistake_photo_confirmations FK still satisfied (mistake_id points to mistakes mirror)", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const { confirm } = await analyzeAndConfirm(app, sessionId, "draft_v4", "1 + 1");
    expect(confirm.status).toBe(200);

    const confirmations = db
      .prepare("SELECT draft_id, mistake_id, child_id FROM mistake_photo_confirmations")
      .all() as Array<{ draft_id: string; mistake_id: number; child_id: string }>;
    expect(confirmations).toHaveLength(1);
    expect(confirmations[0]).toMatchObject({
      draft_id: "draft_v4",
      child_id: "default",
    });
    expect(confirmations[0].mistake_id).toBeGreaterThan(0);

    // The mirror row the FK points to must exist (closure-loop path
    // still writes a mistakes mirror row so the FK is satisfied).
    const mirror = db
      .prepare("SELECT id, source, child_id, problem FROM mistakes WHERE id = ?")
      .get(confirmations[0].mistake_id) as { id: number; source: string; child_id: string; problem: string } | undefined;
    expect(mirror).toMatchObject({
      id: confirmations[0].mistake_id,
      source: "vision",
      child_id: "default",
      problem: "1 + 1",
    });
  });

  it("V-5: explicit_correction (parent edited) writes a new closure-loop case for the corrected problem", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const analysis = await request(app)
      .post("/api/mistake-photo")
      .field("sessionId", sessionId)
      .field("draftId", "draft_v5")
      .attach("photo", validJpeg, {
        filename: "homework.jpg",
        contentType: "image/jpeg",
      });
    expect(analysis.status).toBe(200);
    // Parent typed a corrected problem (VLM read "1 + 1" but parent
    // knows it's actually "2 + 2"). The two should be separate cases.
    const confirm = await request(app)
      .post(`/api/mistake-photo/draft_v5/confirm`)
      .send({ sessionId, problemText: "2 + 2" });
    expect(confirm.status).toBe(200);

    const cases = db
      .prepare("SELECT problem FROM mistake_cases ORDER BY opened_at")
      .all() as Array<{ problem: string }>;
    expect(cases).toEqual([{ problem: "2 + 2" }]);
    const confirmationMethod = db
      .prepare("SELECT confirmation_method FROM mistake_photo_confirmations WHERE draft_id = ?")
      .get("draft_v5") as { confirmation_method: string } | undefined;
    expect(confirmationMethod?.confirmation_method).toBe("explicit_correction");
  });
});

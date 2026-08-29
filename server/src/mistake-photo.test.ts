import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import type { VisionClient } from "./vision.js";
import { memorySink, createLogger } from "./logger.js";
import { MistakePhotoWorkflow } from "./mistake-photo-workflow.js";
import { seedTestDevice, testDeviceAuthenticator } from "./test-device.js";
import sharp from "sharp";
import type { DeviceRequestAuthenticator } from "./device-auth.js";

let db: Database.Database;
let mistakesDir: string;
let providerCalls = 0;
let validJpeg: Buffer;
const logMemory = memorySink();
const logger = createLogger({ sinks: [logMemory.sink] });

function fakeVisionClient(content = "题目：1 + 1\n思路：不会持久化的模型推理"): VisionClient {
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
  mistakesDir = mkdtempSync(join(tmpdir(), "study-buddy-mistake-photo-"));
  validJpeg = await sharp({
    create: { width: 2, height: 2, channels: 3, background: "white" },
  }).jpeg().toBuffer();
});

afterAll(() => {
  db.close();
  rmSync(mistakesDir, { recursive: true, force: true });
});

beforeEach(() => {
  // T10 mirror work (issue #166): confirm now writes the closure
  // loop, so beforeEach needs to wipe the closure-loop tables too
  // (not just the legacy mistakes mirror) to keep tests isolated.
  db.prepare("DELETE FROM mistake_photo_confirmations").run();
  db.prepare("DELETE FROM mistake_photo_page_drafts").run();
  db.prepare("DELETE FROM mistake_photo_candidates").run();
  db.prepare("DELETE FROM learning_attempts").run();
  db.prepare("DELETE FROM correction_obligations").run();
  db.prepare("DELETE FROM mistake_cases").run();
  db.prepare("DELETE FROM mistakes").run();
  db.prepare("DELETE FROM sessions").run();
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

async function analyze(
  app: ReturnType<typeof createApp>,
  sessionId: string,
  draftId = "draft_12345678",
  deviceId?: string,
) {
  const pending = request(app)
    .post("/api/mistake-photo")
    .field("sessionId", sessionId)
    .field("draftId", draftId)
    .attach("photo", validJpeg, {
      filename: "homework.jpg",
      contentType: "image/jpeg",
    });
  if (deviceId) pending.set("x-test-device", deviceId);
  return pending;
}

describe("confirmed mistake-photo workflow", () => {
  it("keeps analysis temporary until explicit acceptance", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const response = await analyze(app, sessionId);

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      draftId: "draft_12345678",
      state: "review",
      problemText: "1 + 1",
      // Vision client returns normal problem → confidence "ok"
      confidence: "ok",
    });
    expect(response.body).not.toHaveProperty("reasoning");
    expect(response.body).not.toHaveProperty("imagePath");
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 0 });
    expect(readdirSync(join(mistakesDir, ".pending"))).toEqual([]);

    const confirmed = await request(app)
      .post("/api/mistake-photo/draft_12345678/confirm")
      .send({ sessionId, problemText: "1 + 1" });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.confirmationMethod).toBe("explicit_acceptance");
    expect(confirmed.body.caseId).toMatch(/^case:/);

    // T10 mirror work (issue #166): closure loop is the source of
    // truth, mistakes mirror is a thin compat layer. The case row
    // carries the canonical evidence; vision-specific columns
    // (evidence_status, evidence_method, image_path, vision_*) live
    // on mistake_photo_drafts / mistake_photo_candidates in the new
    // contract, not on the mistakes mirror.
    const caseRow = db
      .prepare("SELECT child_id, problem, source FROM mistake_cases WHERE case_id = ?")
      .get(confirmed.body.caseId) as { child_id: string; problem: string; source: string } | undefined;
    expect(caseRow).toEqual({
      child_id: "default",
      problem: "1 + 1",
      source: "vision",
    });
    expect(JSON.stringify(caseRow)).not.toContain("secretProviderPayload");
    expect(JSON.stringify(logMemory.entries())).not.toContain("不会持久化的模型推理");
    const mistakeId = (
      db
        .prepare("SELECT original_mistake_id FROM mistake_cases WHERE case_id = ?")
        .get(confirmed.body.caseId) as { original_mistake_id: number | null } | undefined
    )?.original_mistake_id;
    const event = db.prepare(
      "SELECT record_type, event_type, payload_json FROM source_events WHERE record_id = ?",
    ).get(`mistake:${mistakeId}`) as any;
    expect(event.record_type).toBe("learning_attempt");
    expect(event.event_type).toBe("learning_attempt_recorded");
    expect(JSON.parse(event.payload_json)).toMatchObject({
      kind: "learning_attempt",
      problem: "1 + 1",
      source: "vision",
    });
  });

  it("records normalized edits as an explicit correction", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    await analyze(app, sessionId, "draft_correction");

    const response = await request(app)
      .post("/api/mistake-photo/draft_correction/confirm")
      .send({ sessionId, problemText: "  1   +  2\r\n= ?  " });
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      problemText: "1 + 2\n= ?",
      confirmationMethod: "explicit_correction",
    });
    // T10 mirror work: closure loop is the source of truth.
    // The "explicit_correction" mark is captured in
    // mistake_photo_confirmations.confirmation_method (audit), not
    // on mistakes.evidence_method (legacy).
    const row = db
      .prepare("SELECT problem FROM mistake_cases WHERE case_id = ?")
      .get(response.body.caseId) as { problem: string } | undefined;
    expect(row).toEqual({ problem: "1 + 2\n= ?" });
    const confirmation = db
      .prepare("SELECT confirmation_method FROM mistake_photo_confirmations WHERE draft_id = ?")
      .get("draft_correction") as { confirmation_method: string } | undefined;
    expect(confirmation?.confirmation_method).toBe("explicit_correction");
  });

  it("exposes confidence 'low' on the draft response when VLM returns 无法识别", async () => {
    const app = makeApp({
      visionClient: fakeVisionClient("无法识别"),
    });
    const sessionId = await startSession(app);
    const draftId = "draft_low_conf";
    const response = await analyze(app, sessionId, draftId);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      draftId,
      state: "review",
      problemText: "无法识别",
      confidence: "low",
    });
  });

  it("cancels a reviewed draft without creating learning evidence", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    await analyze(app, sessionId, "draft_cancelled");

    const cancelled = await request(app)
      .post("/api/mistake-photo/draft_cancelled/cancel")
      .send({ sessionId });
    expect(cancelled.body.state).toBe("cancelled");
    const missing = await request(app)
      .get(`/api/mistake-photo/draft_cancelled?sessionId=${sessionId}`);
    expect(missing.status).toBe(404);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 0 });
  });

  it("restores a pending review after refresh", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    await analyze(app, sessionId, "draft_refresh_1");
    const restored = await request(app)
      .get(`/api/mistake-photo/draft_refresh_1?sessionId=${sessionId}`);
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ state: "review", problemText: "1 + 1" });
  });

  it("deduplicates repeated analysis and confirmation", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const first = await analyze(app, sessionId, "draft_duplicate");
    const second = await analyze(app, sessionId, "draft_duplicate");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(providerCalls).toBe(1);

    const confirm = () => request(app)
      .post("/api/mistake-photo/draft_duplicate/confirm")
      .send({ sessionId, problemText: "1 + 1" });
    const accepted = await confirm();
    // A fresh workflow simulates an HTTP server restart after the client
    // timed out receiving the first successful confirmation response.
    const restartedApp = makeApp();
    const retried = await request(restartedApp)
      .post("/api/mistake-photo/draft_duplicate/confirm")
      .send({ sessionId, problemText: "1 + 1" });
    // T10 mirror work: closure loop is the source of truth, dedupe
    // key is (child_id, problem, source). The caseId is the stable
    // identity across retries; mistakeId (legacy mirror id) is
    // also stable.
    expect(retried.body.caseId).toBe(accepted.body.caseId);
    expect(retried.body.mistakeId).toBe(accepted.body.mistakeId);
    // Exactly one closure-loop case for this (child, problem, source).
    expect(
      db
        .prepare("SELECT COUNT(*) AS c FROM mistake_cases WHERE child_id = ? AND problem = ? AND source = 'vision'")
        .get("default", "1 + 1"),
    ).toEqual({ c: 1 });
    const repeatedUpload = await analyze(restartedApp, sessionId, "draft_duplicate");
    expect(repeatedUpload.body).toMatchObject({
      state: "confirmed",
      mistakeId: accepted.body.mistakeId,
    });
    expect(providerCalls).toBe(1);
  });

  it("keeps game and vision provenance separate for the same problem", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    // Seed a game-source mistake via the closure loop's insertMistake
    // helper so we exercise the same write path real game clients use.
    const { insertMistake } = await import("./capture-service.js");
    insertMistake(db, {
      childId: "default",
      problem: "1 + 1",
      userAnswer: "3",
      correctAnswer: "2",
      errorType: "compute",
      source: "game",
    });

    await analyze(app, sessionId, "draft_provenance");
    const response = await request(app)
      .post("/api/mistake-photo/draft_provenance/confirm")
      .send({ sessionId, problemText: "1 + 1" });
    expect(response.status).toBe(200);
    // T10 mirror work: closure loop keeps `source` on mistake_cases,
    // not on the mistakes mirror. Two separate cases (game + vision)
    // for the same (child, problem) — different `source` makes them
    // distinct rows in the closure loop.
    const caseSources = db
      .prepare(
        "SELECT source FROM mistake_cases WHERE child_id = 'default' AND problem = '1 + 1' ORDER BY opened_at",
      )
      .all() as Array<{ source: string }>;
    expect(caseSources.map((r) => r.source)).toEqual(["game", "vision"]);
  });

  it("rolls back confirmation if its Source Event cannot be appended", async () => {
    const app = makeApp({
      beforeSourceEventAppend() { throw new Error("source feed unavailable"); },
    });
    const sessionId = await startSession(app);
    await analyze(app, sessionId, "draft_atomicity");
    const eventsBefore = db.prepare("SELECT COUNT(*) AS count FROM source_events").get() as { count: number };

    const response = await request(app)
      .post("/api/mistake-photo/draft_atomicity/confirm")
      .send({ sessionId, problemText: "1 + 1" });
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistake_photo_confirmations").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_events").get()).toEqual(eventsBefore);
  });

  it("deletes temporary media and creates no record when the provider fails", async () => {
    const app = makeApp({
      visionClient: { async chat() { throw new Error("upstream secret failure"); } },
    });
    const sessionId = await startSession(app);
    const response = await analyze(app, sessionId, "draft_failure_1");
    expect(response.status).toBe(502);
    expect(response.body).toEqual({ error: "vision failed" });
    expect(readdirSync(join(mistakesDir, ".pending"))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 0 });
    expect(JSON.stringify(logMemory.entries())).not.toContain("upstream secret failure");
  });

  it("cancel during analysis aborts the provider and deletes temporary media", async () => {
    let entered!: () => void;
    const providerEntered = new Promise<void>((resolve) => { entered = resolve; });
    const app = makeApp({
      visionClient: {
        async chat({ signal }) {
          entered();
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const error = new Error("cancelled");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          });
        },
      },
    });
    const sessionId = await startSession(app);
    const pendingAnalysis = analyze(app, sessionId, "draft_cancel_running").then((value) => value);
    await providerEntered;
    const cancelled = await request(app)
      .post("/api/mistake-photo/draft_cancel_running/cancel")
      .send({ sessionId });
    const analysis = await pendingAnalysis;
    expect(cancelled.body.state).toBe("cancelled");
    expect(analysis.status).toBe(504);
    expect(readdirSync(join(mistakesDir, ".pending"))).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 0 });
  });

  it("aborts a timed-out provider and expires draft metadata", async () => {
    let now = 1_000;
    const workflow = new MistakePhotoWorkflow({
      rootDir: mistakesDir,
      now: () => now,
      ttlMs: 100,
      providerTimeoutMs: 5,
    });
    const timeoutApp = makeApp({
      workflow,
      visionClient: {
        async chat({ signal }) {
          return new Promise((_resolve, reject) => {
            signal?.addEventListener("abort", () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            });
          });
        },
      },
    });
    const sessionId = await startSession(timeoutApp);
    const timeout = await analyze(timeoutApp, sessionId, "draft_timeout_1");
    expect(timeout.status).toBe(504);
    expect(readdirSync(join(mistakesDir, ".pending"))).toEqual([]);

    const app = makeApp({ workflow });
    await analyze(app, sessionId, "draft_expiring_1");
    now += 101;
    expect(workflow.sweepExpired()).toBe(1);
    expect(workflow.get("draft_expiring_1")).toBeNull();
  });

  it("rejects missing, invalid-type, and oversized uploads", async () => {
    const app = makeApp();
    const sessionId = await startSession(app);
    const missing = await request(app)
      .post("/api/mistake-photo")
      .field("sessionId", sessionId)
      .field("draftId", "draft_missing_1");
    expect(missing.status).toBe(400);

    const invalid = await request(app)
      .post("/api/mistake-photo")
      .field("sessionId", sessionId)
      .field("draftId", "draft_invalid_1")
      .attach("photo", Buffer.from("text"), { filename: "note.txt", contentType: "text/plain" });
    expect(invalid.status).toBe(415);

    const spoofed = await request(app)
      .post("/api/mistake-photo")
      .field("sessionId", sessionId)
      .field("draftId", "draft_spoofed_1")
      .attach("photo", Buffer.from("not really a jpeg"), { filename: "fake.jpg", contentType: "image/jpeg" });
    expect(spoofed.status).toBe(415);

    const oversized = await request(app)
      .post("/api/mistake-photo")
      .field("sessionId", sessionId)
      .field("draftId", "draft_oversized")
      .attach("photo", Buffer.alloc(500 * 1024 + 1), { filename: "large.jpg", contentType: "image/jpeg" });
    expect(oversized.status).toBe(413);
    expect(providerCalls).toBe(0);
  });

  it("requires vision configuration and an exact active session", async () => {
    const noVision = makeApp({ visionClient: null });
    const sessionId = await startSession(noVision);
    const unavailable = await analyze(noVision, sessionId, "draft_no_vision");
    expect(unavailable.status).toBe(503);

    const app = makeApp();
    const missingSession = await request(app)
      .post("/api/mistake-photo")
      .field("draftId", "draft_no_session")
      .attach("photo", Buffer.from("x"), { filename: "x.jpg", contentType: "image/jpeg" });
    expect(missingSession.status).toBe(400);
  });

  it("rejects another device's active session before and after confirmation", async () => {
    const secondDeviceId = "test-device-b";
    db.prepare(
      `INSERT OR IGNORE INTO paired_devices
         (device_id, child_id, credential_hash, device_name, created_at, last_seen_at)
       VALUES (?, 'default', ?, 'second', 0, 0)`,
    ).run(secondDeviceId, "second-device-hash");
    const authenticator: DeviceRequestAuthenticator = {
      requireDevice(req, res, next) {
        res.locals.device = {
          deviceId: req.get("x-test-device") || "test-device",
          childId: "default",
        };
        next();
      },
    };
    const app = makeApp({ authenticator });
    const sessionA = await startSession(app);
    const startedB = await request(app)
      .post("/api/session/start")
      .set("x-test-device", secondDeviceId)
      .send({ subject: "math" });
    const sessionB = startedB.body.sessionId as string;

    await analyze(app, sessionA, "draft_cross_session");
    const crossUpload = await analyze(app, sessionB, "draft_cross_session", secondDeviceId);
    expect(crossUpload.status).toBe(403);
    const crossRead = await request(app)
      .get(`/api/mistake-photo/draft_cross_session?sessionId=${sessionB}`)
      .set("x-test-device", secondDeviceId);
    expect(crossRead.status).toBe(403);
    const crossCancel = await request(app)
      .post("/api/mistake-photo/draft_cross_session/cancel")
      .set("x-test-device", secondDeviceId)
      .send({ sessionId: sessionB });
    expect(crossCancel.status).toBe(403);
    const crossConfirm = await request(app)
      .post("/api/mistake-photo/draft_cross_session/confirm")
      .set("x-test-device", secondDeviceId)
      .send({ sessionId: sessionB, problemText: "1 + 1" });
    expect(crossConfirm.status).toBe(403);

    const confirmed = await request(app)
      .post("/api/mistake-photo/draft_cross_session/confirm")
      .send({ sessionId: sessionA, problemText: "1 + 1" });
    expect(confirmed.status).toBe(200);
    const reusedReceipt = await analyze(app, sessionB, "draft_cross_session", secondDeviceId);
    expect(reusedReceipt.status).toBe(403);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 1 });
  });
});

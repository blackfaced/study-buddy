import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { createLogger } from "./logger.js";
import { seedTestDevice, testDeviceAuthenticator } from "./test-device.js";

const TOKEN = "session-source-test-token";

describe("learning Session revisions and withdrawals (#106)", () => {
  let db: Database.Database;
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "study-buddy-session-source-"));
    db = new Database(join(dir, "study.db"));
    migrateSchema(db);
    seedTestDevice(db);
    app = createApp({
      db,
      integrationToken: TOKEN,
      integrationLoopbackCheck: () => true,
      logger: createLogger({ level: "error", sinks: [] }),
      callMinimax: async () => "stub",
      deviceAuthenticator: testDeviceAuthenticator,
    });
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function feed() {
    return request(app)
      .get("/api/integration/source-events?after=0&limit=100&schemaVersion=1")
      .set("Authorization", `Bearer ${TOKEN}`);
  }

  async function completedSession() {
    const started = await request(app)
      .post("/api/session/start")
      .send({ childId: "default", subject: "math" });
    const ended = await request(app)
      .post("/api/session/end")
      .send({ sessionId: started.body.sessionId });
    expect(ended.status).toBe(200);
    return { sessionId: started.body.sessionId as string, ended };
  }

  it("atomically completes a Session and emits exactly one stable source record", async () => {
    const { sessionId, ended } = await completedSession();
    expect(ended.body).toMatchObject({ revision: 1, withdrawn: false });

    const page = await feed();
    expect(page.status).toBe(200);
    expect(page.body.events).toHaveLength(1);
    expect(page.body.events[0]).toMatchObject({
      eventType: "learning_session_completed",
      sourceIdentity: {
        recordType: "learning_session",
        recordId: `session:${sessionId}`,
        revision: 1,
      },
      payload: {
        kind: "learning_session",
        sessionKind: "study",
        subject: "math",
      },
    });

    const retry = await request(app)
      .post("/api/session/end")
      .send({ sessionId });
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(1);
    expect((await feed()).body.events).toHaveLength(1);
  });

  it("adopts and completes a pre-pairing active Session before opening a device-owned one", async () => {
    const legacySessionId = "legacy-active-session";
    db.prepare(
      `INSERT INTO sessions (id, child_id, started_at)
       VALUES (?, 'default', ?)`,
    ).run(legacySessionId, Date.now() - 60_000);

    const started = await request(app)
      .post("/api/session/start")
      .send({ childId: "default", subject: "math" });
    expect(started.status).toBe(200);

    const adopted = db.prepare(
      `SELECT device_id AS deviceId, ended_at AS endedAt,
              source_revision AS sourceRevision
         FROM sessions WHERE id = ?`,
    ).get(legacySessionId) as {
      deviceId: string | null;
      endedAt: number | null;
      sourceRevision: number;
    };
    expect(adopted.deviceId).not.toBeNull();
    expect(adopted.endedAt).not.toBeNull();
    expect(adopted.sourceRevision).toBe(1);

    const corrected = await request(app)
      .patch(`/api/session/${legacySessionId}`)
      .send({ subject: "corrected legacy" });
    expect(corrected.status).toBe(200);
    expect(corrected.body.revision).toBe(2);

    const events = (await feed()).body.events;
    expect(events.map((event: any) => event.sourceIdentity.recordId))
      .toEqual([`session:${legacySessionId}`, `session:${legacySessionId}`]);
    expect(events.map((event: any) => event.sourceIdentity.revision)).toEqual([1, 2]);
    expect(
      db.prepare(
        `SELECT COUNT(*) AS count FROM sessions
          WHERE child_id = 'default' AND device_id IS NULL AND ended_at IS NULL`,
      ).get(),
    ).toEqual({ count: 0 });
  });

  it("does not adopt a game-only mistake session as a study Session", async () => {
    // SB124-T10: /api/game/mistake is retired (returns 410). The
    // closure loop's helper is the source of truth for game-source
    // mistakes too — see integration-source-events.test.ts for the
    // shared recordAttempt helper pattern.
    const { insertMistake } = await import("./capture-service.js");
    const mistake = insertMistake(db, {
      childId: "default",
      problem: "7+8",
      userAnswer: "14",
      correctAnswer: "15",
      errorType: null,
      source: "game",
    });
    expect(mistake.id).toBeGreaterThan(0);
    const gameSession = db.prepare(
      `SELECT s.id, s.subject
         FROM sessions s JOIN mistakes m ON m.session_id = s.id
        WHERE m.id = ?`,
    ).get(mistake.id) as { id: string; subject: string };
    expect(gameSession.subject).toBe("__game__:math");

    const started = await request(app).post("/api/session/start").send({ subject: "作业" });
    expect(started.status).toBe(200);
    expect(db.prepare(
      `SELECT ended_at AS endedAt, device_id AS deviceId,
              source_revision AS sourceRevision
         FROM sessions WHERE id = ?`,
    ).get(gameSession.id)).toEqual({ endedAt: null, deviceId: null, sourceRevision: 0 });

    const events = (await feed()).body.events;
    expect(events).toHaveLength(1);
    expect(events[0].sourceIdentity.recordType).toBe("learning_attempt");
  });

  it("rolls back Session completion when the source event cannot be inserted", async () => {
    const started = await request(app).post("/api/session/start").send({});
    db.exec(`
      CREATE TRIGGER fail_session_source_event
      BEFORE INSERT ON source_events
      WHEN NEW.record_type = 'learning_session'
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
    `);

    const ended = await request(app)
      .post("/api/session/end")
      .send({ sessionId: started.body.sessionId });
    expect(ended.status).toBe(500);
    expect(
      db.prepare(
        "SELECT ended_at, source_revision FROM sessions WHERE id = ?",
      ).get(started.body.sessionId),
    ).toEqual({ ended_at: null, source_revision: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_events").get())
      .toEqual({ count: 0 });
  });

  it("keeps identity, advances revisions, and deduplicates correction retries", async () => {
    const { sessionId } = await completedSession();
    const corrected = await request(app)
      .patch(`/api/session/${sessionId}`)
      .send({ subject: "arithmetic", totalMinutes: 12 });
    expect(corrected.status).toBe(200);
    expect(corrected.body.revision).toBe(2);

    const retry = await request(app)
      .patch(`/api/session/${sessionId}`)
      .send({ subject: "arithmetic", totalMinutes: 12 });
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(2);

    const events = (await feed()).body.events;
    expect(events.map((event: any) => event.sourceIdentity.recordId))
      .toEqual([`session:${sessionId}`, `session:${sessionId}`]);
    expect(events.map((event: any) => event.sourceIdentity.revision)).toEqual([1, 2]);
    expect(events[1]).toMatchObject({
      eventType: "source_record_corrected",
      payload: { subject: "arithmetic", durationMinutes: 12 },
    });
  });

  it("atomically claims a published legacy Session on its first correction", async () => {
    const { sessionId } = await completedSession();
    db.prepare("UPDATE sessions SET device_id = NULL WHERE id = ?").run(sessionId);

    const corrected = await request(app)
      .patch(`/api/session/${sessionId}`)
      .send({ totalMinutes: 3 });
    expect(corrected.status).toBe(200);
    expect(corrected.body.revision).toBe(2);
    expect(db.prepare(
      "SELECT device_id AS deviceId FROM sessions WHERE id = ?",
    ).get(sessionId)).toEqual({ deviceId: "test-device" });
  });

  it("withdraws with an empty payload and does not duplicate withdrawal retries", async () => {
    const { sessionId } = await completedSession();
    await request(app).patch(`/api/session/${sessionId}`).send({ totalMinutes: 2 });

    const withdrawn = await request(app).delete(`/api/session/${sessionId}`);
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body).toMatchObject({ revision: 3, withdrawn: true });
    const retry = await request(app).delete(`/api/session/${sessionId}`);
    expect(retry.status).toBe(200);
    expect(retry.body.revision).toBe(3);

    const events = (await feed()).body.events;
    expect(events).toHaveLength(3);
    expect(events[2]).toMatchObject({
      eventType: "source_record_withdrawn",
      payload: null,
      sourceIdentity: {
        recordId: `session:${sessionId}`,
        revision: 3,
      },
    });
    const serialized = JSON.stringify(events[2]);
    expect(serialized).not.toContain("arithmetic");
    expect(serialized).not.toContain("durationMinutes");
  });

  it("rejects malformed corrections and active-session withdrawals", async () => {
    const started = await request(app).post("/api/session/start").send({});
    expect(
      (await request(app).patch(`/api/session/${started.body.sessionId}`).send({ totalMinutes: -1 })).status,
    ).toBe(400);
    expect(
      (await request(app).delete(`/api/session/${started.body.sessionId}`)).status,
    ).toBe(409);
  });
});

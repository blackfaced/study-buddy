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

const TOKEN = "chat-source-test-token";

// Build the JSON body for POST /api/integration/retrieve from a list of
// source-feed events. Pulled out of the test body because it doesn't
// capture any of the surrounding scope (pure function of its inputs) —
// oxlint: consistent-function-scoping.
function buildRetrievalBody(events: any[], selected = events) {
  const occurredAt = Date.parse(events[0].occurredAt);
  return {
    schemaVersion: 1,
    sessionRef: events[0].payload.sessionRef,
    turnRefs: selected.map((event: any) => event.payload.turnRef),
    window: {
      from: new Date(occurredAt - 60_000).toISOString(),
      to: new Date(occurredAt + 60_000).toISOString(),
    },
  };
}

describe("bounded chat references and retrieval (#107)", () => {
  let db: Database.Database;
  let dir: string;
  let app: ReturnType<typeof createApp>;
  let sessionId: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "study-buddy-chat-source-"));
    db = new Database(join(dir, "study.db"));
    migrateSchema(db);
    seedTestDevice(db);
    app = buildApp(true);
    sessionId = (db.prepare(
      `INSERT INTO sessions (id, child_id, device_id, started_at, subject)
       VALUES ('chat-source-session', 'default', 'test-device', ?, 'chat')
       RETURNING id`,
    ).get(Date.now()) as { id: string }).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  function buildApp(loopback: boolean) {
    return createApp({
      db,
      integrationToken: TOKEN,
      integrationLoopbackCheck: () => loopback,
      logger: createLogger({ level: "error", sinks: [] }),
      callMinimax: async (messages) => `coach:${messages.at(-1)?.content ?? ""}`,
      deviceAuthenticator: testDeviceAuthenticator,
    });
  }

  function feed() {
    return request(app)
      .get("/api/integration/source-events?after=0&limit=100&schemaVersion=1")
      .set("Authorization", `Bearer ${TOKEN}`);
  }

  function retrieve(body: object, target = app) {
    return request(target)
      .post("/api/integration/chat-turns")
      .set("Authorization", `Bearer ${TOKEN}`)
      .send(body);
  }

  async function seedChat(text = "私密的孩子原话") {
    const response = await request(app).post("/api/chat").send({ sessionId, text });
    expect(response.status).toBe(200);
    const events = (await feed()).body.events.filter(
      (event: any) => event.sourceIdentity.recordType === "chat_turn",
    );
    return { response, events };
  }

  it("publishes stable references without copying chat text into the Source feed", async () => {
    const { events } = await seedChat();
    expect(events).toHaveLength(2);
    expect(events.map((event: any) => event.payload.role)).toEqual(["child", "agent"]);
    for (const event of events) {
      expect(event).toMatchObject({
        eventType: "chat_turn_recorded",
        sourceIdentity: { recordType: "chat_turn", revision: 1 },
        payload: {
          kind: "chat_turn_reference",
          sessionRef: expect.stringMatching(/^session:/),
          turnRef: expect.stringMatching(/^chat_turn:/),
        },
      });
    }
    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("私密的孩子原话");
    expect(serialized).not.toContain("coach:");
  });

  it("returns only explicitly requested turns inside the bounded window", async () => {
    const { events } = await seedChat("只取这一轮");
    const result = await retrieve(buildRetrievalBody(events, [events[0]]));
    expect(result.status).toBe(200);
    expect(result.body.turns).toEqual([
      {
        turnRef: events[0].payload.turnRef,
        role: "child",
        content: "只取这一轮",
        occurredAt: events[0].occurredAt,
      },
    ]);
    const serialized = JSON.stringify(result.body);
    expect(serialized).not.toContain("topic");
    expect(serialized).not.toContain("redirected");
    expect(serialized).not.toContain("image");
    expect(serialized).not.toContain("reasoning");
  });

  it("rejects unbounded, excessive, malformed, unsupported, and unknown requests", async () => {
    const { events } = await seedChat();
    const valid = buildRetrievalBody(events);
    const invalidBodies = [
      { ...valid, window: undefined },
      { ...valid, schemaVersion: 2 },
      { ...valid, turnRefs: [] },
      { ...valid, turnRefs: Array.from({ length: 51 }, (_, i) => `chat_turn:${i + 1}`) },
      { ...valid, turnRefs: ["bad-ref"] },
      {
        ...valid,
        window: { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" },
      },
      {
        ...valid,
        window: { from: "2026-01-01", to: "2026-01-02" },
      },
    ];
    for (const body of invalidBodies) {
      expect((await retrieve(body)).status).toBe(400);
    }
    expect(
      (await retrieve({ ...valid, turnRefs: ["chat_turn:999999"] })).status,
    ).toBe(404);
  });

  it("rejects guessed chat rows that were never published in the Source feed", async () => {
    const { events } = await seedChat("published");
    const publishedSessionId = events[0].payload.sessionRef.slice("session:".length);
    const ts = Date.parse(events[0].occurredAt);
    const unpublishedId = Number(db.prepare(
      `INSERT INTO chat_turns (session_id, ts, role, content, topic)
       VALUES (?, ?, 'child', 'legacy unpublished text', 'learning')`,
    ).run(publishedSessionId, ts).lastInsertRowid);
    const body = buildRetrievalBody(events);
    body.turnRefs = [`chat_turn:${unpublishedId}`];
    expect((await retrieve(body)).status).toBe(404);
  });

  it("fails explicitly when a stored chat event advertises a different turn reference", async () => {
    const { events } = await seedChat("consistent reference");
    const source = db.prepare(
      `SELECT source_installation_id, subject_ref FROM source_events LIMIT 1`,
    ).get() as { source_installation_id: string; subject_ref: string };
    const occurredAt = Date.parse(events[0].occurredAt);
    db.prepare(
      `INSERT INTO source_events (
         event_id, source_product, source_installation_id, subject_ref,
         record_type, record_id, revision, occurred_at, event_type,
         event_schema_version, payload_json
       ) VALUES (?, 'study_buddy', ?, ?, 'chat_turn', 'chat_turn:999999', 1, ?,
         'chat_turn_recorded', 1, ?)`,
    ).run(
      "mismatched-chat-reference",
      source.source_installation_id,
      source.subject_ref,
      occurredAt,
      JSON.stringify({
        ...events[0].payload,
        turnRef: events[0].payload.turnRef,
      }),
    );
    expect((await feed()).status).toBe(500);
  });

  it("requires the independent credential and loopback origin", async () => {
    const { events } = await seedChat();
    const body = buildRetrievalBody(events);
    expect((await request(app).post("/api/integration/chat-turns").send(body)).status)
      .toBe(401);
    expect(
      (await request(app).post("/api/integration/chat-turns").set("X-Buddy-Pin", "1234").send(body)).status,
    ).toBe(401);
    expect((await retrieve(body, buildApp(false))).status).toBe(403);
  });

  it("rolls back chat rows when a Source Event insert fails", async () => {
    db.exec(`
      CREATE TRIGGER fail_chat_source_event
      BEFORE INSERT ON source_events
      WHEN NEW.record_type = 'chat_turn'
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
    `);
    const response = await request(app).post("/api/chat").send({ sessionId, text: "rollback" });
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_turns").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_events").get())
      .toEqual({ count: 0 });
  });

  it("keeps bounded reads stable while a new chat write is appended", async () => {
    const { events } = await seedChat("first");
    const body = buildRetrievalBody(events, [events[0]]);
    const [read, write] = await Promise.all([
      retrieve(body),
      request(app).post("/api/chat").send({ sessionId, text: "second" }),
    ]);
    expect(read.status).toBe(200);
    expect(read.body.turns.map((turn: any) => turn.content)).toEqual(["first"]);
    expect(write.status).toBe(200);
    const allEvents = (await feed()).body.events.filter(
      (event: any) => event.sourceIdentity.recordType === "chat_turn",
    );
    expect(allEvents).toHaveLength(4);
    expect(new Set(allEvents.map((event: any) => event.sequence)).size).toBe(4);
  });
});

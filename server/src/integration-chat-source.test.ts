import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { createLogger } from "./logger.js";

const TOKEN = "chat-source-test-token";

describe("bounded chat references and retrieval (#107)", () => {
  let db: Database.Database;
  let dir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "study-buddy-chat-source-"));
    db = new Database(join(dir, "study.db"));
    migrateSchema(db);
    app = buildApp(true);
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
    const response = await request(app).post("/api/chat").send({ text });
    expect(response.status).toBe(200);
    const events = (await feed()).body.events.filter(
      (event: any) => event.sourceIdentity.recordType === "chat_turn",
    );
    return { response, events };
  }

  function retrievalBody(events: any[], selected = events) {
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
    const result = await retrieve(retrievalBody(events, [events[0]]));
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
    const valid = retrievalBody(events);
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
    ];
    for (const body of invalidBodies) {
      expect((await retrieve(body)).status).toBe(400);
    }
    expect(
      (await retrieve({ ...valid, turnRefs: ["chat_turn:999999"] })).status,
    ).toBe(404);
  });

  it("requires the independent credential and loopback origin", async () => {
    const { events } = await seedChat();
    const body = retrievalBody(events);
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
    const response = await request(app).post("/api/chat").send({ text: "rollback" });
    expect(response.status).toBe(500);
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_turns").get())
      .toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM source_events").get())
      .toEqual({ count: 0 });
  });

  it("keeps bounded reads stable while a new chat write is appended", async () => {
    const { events } = await seedChat("first");
    const body = retrievalBody(events, [events[0]]);
    const [read, write] = await Promise.all([
      retrieve(body),
      request(app).post("/api/chat").send({ text: "second" }),
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

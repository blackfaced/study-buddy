import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppOptions } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { createLogger } from "./logger.js";

const INTEGRATION_TOKEN = "test-integration-token-with-enough-entropy";

describe("Study Buddy transactional source-event feed (#104)", () => {
  let db: Database.Database;
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  function buildApp(
    loopback = true,
    overrides: Partial<AppOptions> = {},
  ): ReturnType<typeof createApp> {
    return createApp({
      db,
      httpsPort: 3000,
      integrationToken: INTEGRATION_TOKEN,
      integrationLoopbackCheck: () => loopback,
      logger: createLogger({ level: "error", sinks: [] }),
      ...overrides,
    });
  }

  async function recordAttempt(problem: string, childId = "default") {
    return request(app).post("/api/game/mistake").send({
      childId,
      problem,
      userAnswer: "11",
      correctAnswer: "12",
      errorType: "carry",
      source: "candy-math-island",
    });
  }

  function feed(after = 0, limit = 10) {
    return request(app)
      .get(
        `/api/integration/source-events?after=${after}&limit=${limit}&schemaVersion=1`,
      )
      .set("Authorization", `Bearer ${INTEGRATION_TOKEN}`);
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-source-feed-"));
    db = new Database(join(tmpDir, "study.db"));
    migrateSchema(db);
    app = buildApp();
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("commits one Learning Attempt event and exposes it through the authenticated feed", async () => {
    const attempt = await recordAttempt("7 + 5 = ?");
    expect(attempt.status).toBe(201);

    const firstPage = await feed();
    expect(firstPage.status).toBe(200);
    expect(firstPage.body).toMatchObject({
      eventSchemaVersion: 1,
      page: {
        after: 0,
        endOfPage: true,
        endOfFeed: true,
        hasMore: false,
      },
    });
    expect(firstPage.body.events).toHaveLength(1);
    expect(firstPage.body.events[0].eventId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(firstPage.body.events[0]).toMatchObject({
      sequence: 1,
      eventType: "learning_attempt_recorded",
      sourceIdentity: {
        sourceProduct: "study_buddy",
        recordType: "learning_attempt",
        recordId: `mistake:${attempt.body.id}`,
        revision: 1,
      },
      payload: {
        kind: "learning_attempt",
        problem: "7 + 5 = ?",
        submittedAnswer: "11",
        expectedAnswer: "12",
        mistakeType: "carry",
        source: "game",
      },
    });
    expect(firstPage.body.events[0].sourceIdentity.sourceInstallationId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(firstPage.body.events[0].payload.subjectRef).toMatch(
      /^[0-9a-f-]{36}$/,
    );
    expect(firstPage.body.events[0].subjectRef).toBe(
      firstPage.body.events[0].payload.subjectRef,
    );
    expect(firstPage.body.page.nextCursor).toBe(1);
    const serialized = JSON.stringify(firstPage.body).toLowerCase();
    expect(serialized).not.toContain("memorynexus");
    expect(serialized).not.toContain("cognitive_space");
    expect(serialized).not.toContain("namespace_id");
    expect(serialized).not.toContain(INTEGRATION_TOKEN.toLowerCase());
  });

  it("rolls back the domain write when Source Event insertion fails", async () => {
    app = buildApp(true, {
      beforeSourceEventAppend: (recordType) => {
        expect(recordType).toBe("learning_attempt");
        throw new Error("forced source event failure");
      },
    });

    const response = await recordAttempt("rollback-only-problem", "rollback-child");
    expect(response.status).toBe(500);
    expect(response.body).toEqual({ error: "mistake could not be recorded" });
    expect((await request(app).get("/api/health")).body).toMatchObject({
      childrenCount: 1,
      sessionsCount: 0,
    });
    expect((await request(app).get("/api/game/weak-topics?days=7")).body.weakTopics).toEqual([]);
    expect((await feed()).body.events).toEqual([]);
  });

  it("keeps one logical event for an idempotent product retry", async () => {
    const first = await recordAttempt("idempotent-problem");
    const replay = await recordAttempt("idempotent-problem");
    expect(first.status).toBe(201);
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ id: first.body.id, created: false });
    expect((await feed()).body.events).toHaveLength(1);
  });

  it("records attempts without a configured consumer or integration credential", async () => {
    app = createApp({
      db,
      httpsPort: 3000,
      integrationToken: null,
      logger: createLogger({ level: "error", sinks: [] }),
    });
    const attempt = await recordAttempt("offline-consumer-problem");
    expect(attempt.status).toBe(201);
    expect((await request(app).get("/api/integration/source-events")).status).toBe(
      401,
    );
    app = buildApp();
    expect((await feed()).body.events).toHaveLength(1);
  });

  it("preserves installation identity, sequence, and unread events across restart", async () => {
    await recordAttempt("restart-problem");
    const before = (await feed()).body.events[0].sourceIdentity.sourceInstallationId;
    const dbPath = join(tmpDir, "study.db");
    db.close();
    db = new Database(dbPath);
    migrateSchema(db);
    app = buildApp();

    const page = await feed();
    expect(page.status).toBe(200);
    expect(page.body.events).toHaveLength(1);
    expect(page.body.events[0].sequence).toBe(1);
    expect(page.body.events[0].sourceIdentity.sourceInstallationId).toBe(
      before,
    );
  });

  it("requires the independent credential and rejects non-loopback clients", async () => {
    await recordAttempt("private-feed-problem");
    expect(
      (await request(app).get("/api/integration/source-events")).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/integration/source-events")
          .set("Authorization", "Bearer wrong-token")
      ).status,
    ).toBe(401);
    expect(
      (
        await request(app)
          .get("/api/integration/source-events")
          .set("X-Buddy-Pin", "1234")
      ).status,
    ).toBe(401);

    const lanApp = buildApp(false);
    expect(
      (
        await request(lanApp)
          .get("/api/integration/source-events")
          .set("Authorization", `Bearer ${INTEGRATION_TOKEN}`)
      ).status,
    ).toBe(403);
  });

  it("paginates with stable monotonic cursors and explicit feed boundaries", async () => {
    for (const problem of ["page-a", "page-b", "page-c"]) {
      expect((await recordAttempt(problem)).status).toBe(201);
    }

    const first = await feed(0, 2);
    expect(first.body.events.map((event: any) => event.sequence)).toEqual([1, 2]);
    expect(first.body.page).toEqual({
      after: 0,
      nextCursor: 2,
      endOfPage: true,
      endOfFeed: false,
      hasMore: true,
    });
    const second = await feed(first.body.page.nextCursor, 2);
    expect(second.body.events.map((event: any) => event.sequence)).toEqual([3]);
    expect(second.body.page).toEqual({
      after: 2,
      nextCursor: 3,
      endOfPage: true,
      endOfFeed: true,
      hasMore: false,
    });
    const empty = await feed(second.body.page.nextCursor, 2);
    expect(empty.body.events).toEqual([]);
    expect(empty.body.page.nextCursor).toBe(3);
    expect(empty.body.page.endOfFeed).toBe(true);
  });

  it("rejects malformed cursors, versions, excessive pages, and unbounded attempts", async () => {
    for (const query of [
      "after=-1&limit=10&schemaVersion=1",
      "after=1.5&limit=10&schemaVersion=1",
      "after=0&limit=101&schemaVersion=1",
      "after=0&limit=10&schemaVersion=2",
    ]) {
      const response = await request(app)
        .get(`/api/integration/source-events?${query}`)
        .set("Authorization", `Bearer ${INTEGRATION_TOKEN}`);
      expect(response.status).toBe(400);
    }
    expect((await feed(999, 10)).status).toBe(400);
    const oversized = await recordAttempt("x".repeat(201));
    expect(oversized.status).toBe(400);
    expect((await request(app).get("/api/game/weak-topics?days=7")).body.weakTopics).toEqual([]);
    expect((await feed()).body.events).toEqual([]);
  });

  it("has no gaps or repeats when writes and feed reads overlap", async () => {
    const writes = Array.from({ length: 20 }, (_, index) =>
      recordAttempt(`concurrent-${index}`),
    );
    await Promise.all([feed(0, 5), ...writes]);

    const sequences: number[] = [];
    let cursor = 0;
    while (true) {
      const page = await feed(cursor, 4);
      sequences.push(
        ...page.body.events.map((event: any) => event.sequence as number),
      );
      cursor = page.body.page.nextCursor;
      if (page.body.page.endOfFeed) break;
    }
    expect(sequences).toEqual(Array.from({ length: 20 }, (_, index) => index + 1));
    expect(new Set(sequences).size).toBe(20);
  });

});

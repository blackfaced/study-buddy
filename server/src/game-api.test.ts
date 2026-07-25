import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp, APPS } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let outboxPath: string;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  outboxPath = join(mkdtempSync(join(tmpdir(), "game-api-")), "outbox.jsonl");
  app = createApp({ db, httpsPort: 3000, outboxPath });
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  // Reset between tests so aggregates are deterministic.
  db.prepare("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL").run();
  db.prepare("DELETE FROM mistakes").run();
});

describe("GET /api/apps (platform registry)", () => {
  it("returns the registered apps list", async () => {
    const res = await request(app).get("/api/apps");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.apps)).toBe(true);
    expect(res.body.apps.length).toBeGreaterThan(0);
    const candy = res.body.apps.find((a: any) => a.id === "candy-math-island");
    expect(candy).toBeDefined();
    expect(candy.name).toBe("糖果口算岛");
    expect(candy.url).toBe("/games/candy-math-island/");
    expect(candy.status).toBe("ready");
  });

  it("APPS export matches the API response", () => {
    // sanity: same source of truth
    expect(APPS.length).toBeGreaterThan(0);
    expect(APPS.find((a) => a.id === "candy-math-island")).toBeDefined();
  });
});

describe("POST /api/game/mistake", () => {
  const validBody = {
    childId: "default",
    subject: "math",
    problem: "5 + 7 = ?",
    errorType: "carry",
    userAnswer: 11,
    correctAnswer: 12,
    level: 1,
  };

  it("returns 200 and a mistakeId on a valid payload", async () => {
    const res = await request(app).post("/api/game/mistake").send(validBody);
    expect(res.status).toBe(200);
    expect(typeof res.body.mistakeId).toBe("number");
  });

  it("persists the mistake with source='game' and the user/correct answers", async () => {
    const res = await request(app).post("/api/game/mistake").send(validBody);
    const id = res.body.mistakeId as number;
    const row = db
      .prepare("SELECT * FROM mistakes WHERE id = ?")
      .get(id) as any;
    expect(row).toBeDefined();
    expect(row.source).toBe("game");
    expect(row.error_type).toBe("carry");
    expect(parseInt(row.user_answer, 10)).toBe(11);
    expect(parseInt(row.correct_answer, 10)).toBe(12);
  });

  it("appends an outbox entry so the Nexus worker can index it later", async () => {
    const res = await request(app).post("/api/game/mistake").send(validBody);
    expect(res.status).toBe(200);
    // Read the raw file (the worker's job, but the test verifies the seam)
    const raw = await import("node:fs/promises").then((m) => m.readFile(outboxPath, "utf-8"));
    const lines = raw.split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.kind).toBe("math_mistake");
    expect(last.entityId).toBe("child:default");
    expect(last.payload).toMatchObject({ errorType: "carry", level: 1, source: "game" });
  });

  it("returns 400 when fields are missing or wrong type", async () => {
    const res = await request(app).post("/api/game/mistake").send({ childId: "default" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/missing or invalid/);
  });
});

describe("GET /api/game/weak-topics", () => {
  it("returns the aggregated weak topics across recent days", async () => {
    // Seed three carries
    for (let i = 0; i < 3; i++) {
      await request(app)
        .post("/api/game/mistake")
        .send({
          childId: "default",
          subject: "math",
          problem: `5+${i}`,
          errorType: "carry",
          userAnswer: 0,
          correctAnswer: 1,
          level: 1,
        });
    }
    const res = await request(app).get("/api/game/weak-topics?days=7");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
    const carry = res.body.weakTopics.find((t: any) => t.errorType === "carry");
    expect(carry).toBeDefined();
    expect(carry.count).toBe(3);
  });

  it("defaults to 7 days when no ?days is given", async () => {
    const res = await request(app).get("/api/game/weak-topics");
    expect(res.status).toBe(200);
    expect(res.body.days).toBe(7);
  });

  it("returns 400 on a non-positive days value", async () => {
    const res = await request(app).get("/api/game/weak-topics?days=0");
    expect(res.status).toBe(400);
  });
});

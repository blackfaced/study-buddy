import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import type { VisionClient } from "./vision.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let mistakesDir: string;

function fakeVisionClient(content = "题目：1+1\n思路：数一数"): VisionClient {
  return {
    async chat() {
      return { content, raw: { mocked: true } };
    },
  };
}

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  mistakesDir = mkdtempSync(join(tmpdir(), "study-buddy-mistakes-"));
  app = createApp({ db, httpsPort: 3000, visionClient: fakeVisionClient(), mistakesDir });
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  // reset: close any active session between tests
  db.prepare("UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL").run();
  // clear mistakes
  db.prepare("DELETE FROM mistakes").run();
});

async function startSession() {
  const res = await request(app)
    .post("/api/session/start")
    .send({ subject: "math" });
  expect(res.status).toBe(200);
  return res.body.sessionId as string;
}

describe("POST /api/mistake-photo (v0.5)", () => {
  it("returns 503 when no vision client is configured", async () => {
    const noVisionApp = createApp({ db, httpsPort: 3000, visionClient: null, mistakesDir });
    const res = await request(noVisionApp)
      .post("/api/mistake-photo")
      .attach("photo", Buffer.from("fake-jpeg-bytes"), "test.jpg");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/vision not configured/);
  });

  it("returns 400 when no photo is attached", async () => {
    await startSession();
    const res = await request(app).post("/api/mistake-photo");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no photo");
  });

  it("returns 400 when there is no active session", async () => {
    const res = await request(app)
      .post("/api/mistake-photo")
      .attach("photo", Buffer.from("fake-jpeg-bytes"), "test.jpg");
    expect(res.status).toBe(400);
    expect(res.body.error).toBe("no active session");
  });

  it("on success: writes the photo to mistakesDir, persists a mistakes row, and returns parsed vision", async () => {
    await startSession();
    const res = await request(app)
      .post("/api/mistake-photo")
      .attach("photo", Buffer.from("FAKE-JPEG-CONTENT"), "math.jpg");

    expect(res.status).toBe(200);
    expect(res.body.problemText).toBe("1+1");
    expect(res.body.reasoning).toBe("数一数");
    expect(res.body.model).toBe("MiniMax-M3");
    expect(res.body.mistakeId).toBeDefined();
    expect(res.body.imagePath).toContain(mistakesDir);

    // File was written
    const savedPath = res.body.imagePath as string;
    expect(existsSync(savedPath)).toBe(true);
    expect(readFileSync(savedPath, "utf-8")).toBe("FAKE-JPEG-CONTENT");

    // mistakes row was inserted with v0.5 columns populated
    const row = db
      .prepare(
        "SELECT * FROM mistakes WHERE image_path = ?"
      )
      .get(savedPath) as any;
    expect(row).toBeDefined();
    expect(row.image_path).toBe(savedPath);
    expect(row.vision_input).toBe("1+1");
    expect(row.vision_reasoning).toBe("数一数");
    expect(row.vision_model).toBe("MiniMax-M3");
    expect(row.vision_ts).toBeGreaterThan(0);
    expect(row.problem).toBe("1+1");
  });

  it("persists '无法识别' as the problem text when vision gives up", async () => {
    await startSession();
    const noReadApp = createApp({
      db,
      httpsPort: 3000,
      visionClient: fakeVisionClient("无法识别"),
      mistakesDir,
    });
    const res = await request(noReadApp)
      .post("/api/mistake-photo")
      .attach("photo", Buffer.from("BLUR"), "blur.jpg");

    expect(res.status).toBe(200);
    expect(res.body.problemText).toBe("无法识别");
    expect(res.body.reasoning).toBe("");

    const row = db
      .prepare("SELECT problem, vision_input, vision_reasoning FROM mistakes ORDER BY id DESC LIMIT 1")
      .get() as any;
    expect(row.problem).toBe("无法识别");
    expect(row.vision_input).toBe("无法识别");
    expect(row.vision_reasoning).toBe("");
  });

  it("returns 502 when the vision client throws", async () => {
    await startSession();
    const failingApp = createApp({
      db,
      httpsPort: 3000,
      visionClient: {
        async chat() {
          throw new Error("upstream timeout");
        },
      },
      mistakesDir,
    });
    const res = await request(failingApp)
      .post("/api/mistake-photo")
      .attach("photo", Buffer.from("X"), "x.jpg");
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/vision failed/);
  });
});

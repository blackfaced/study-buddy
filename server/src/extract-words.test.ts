// server/src/extract-words.test.ts
//
// Integration tests for POST /api/write/extract-words (issue #57 v0.2).
// Mirrors the pattern from mistake-photo.test.ts: inject a fake
// VisionClient via AppOptions, use supertest with .attach() for
// the multipart upload, and assert the response shape.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import type { VisionClient } from "./vision.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let noVisionApp: ReturnType<typeof createApp>;

/** A fake vision client that returns the given text content. */
function fakeVisionClient(content: string): VisionClient {
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
  app = createApp({ db, httpsPort: 3000, visionClient: fakeVisionClient("永 泳 远 处") });
  noVisionApp = createApp({ db, httpsPort: 3000, visionClient: null });
});

afterAll(() => db.close());

// 1x1 transparent PNG — minimal valid image bytes that multer will accept.
const TINY_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

describe("POST /api/write/extract-words (issue #57 v0.2)", () => {
  it("200 with words array when vision returns CJK", async () => {
    const res = await request(app)
      .post("/api/write/extract-words")
      .attach("image", TINY_PNG, "test.png");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      words: ["永", "泳", "远", "处"],
      model: "MiniMax-M3",
    });
  });

  it("returns empty words array when vision returns no CJK", async () => {
    // Build a fresh app with a vision client that returns ASCII only.
    const asciiApp = createApp({
      db,
      httpsPort: 3000,
      visionClient: fakeVisionClient("hello 123 !@#"),
    });
    const res = await request(asciiApp)
      .post("/api/write/extract-words")
      .attach("image", TINY_PNG, "ascii.png");
    expect(res.status).toBe(200);
    expect(res.body.words).toEqual([]);
  });

  it("503 when vision is not configured", async () => {
    const res = await request(noVisionApp)
      .post("/api/write/extract-words")
      .attach("image", TINY_PNG, "test.png");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/vision not configured/);
  });

  it("400 when no image is attached", async () => {
    const res = await request(app).post("/api/write/extract-words");
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no image/);
  });

  it("deduplicates vision output server-side", async () => {
    // Vision returned "永 永 永 远 远 处" — handler must dedupe to
    // ["永","远","处"]. The parser inside extractCharsImage does this,
    // so we just verify the wire output is deduped.
    const dupApp = createApp({
      db,
      httpsPort: 3000,
      visionClient: fakeVisionClient("永 永 永 远 远 处"),
    });
    const res = await request(dupApp)
      .post("/api/write/extract-words")
      .attach("image", TINY_PNG, "dup.png");
    expect(res.status).toBe(200);
    expect(res.body.words).toEqual(["永", "远", "处"]);
  });
});

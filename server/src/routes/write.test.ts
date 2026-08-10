// server/src/routes/write.test.ts
//
// Tests for the write route module extracted from app.ts (PR 5b of
// the refactor series). The module owns:
//   - GET    /api/write/words
//   - POST   /api/write/words
//   - DELETE /api/write/words/:char
//   - GET    /api/write/words/:char/attempts
//   - POST   /api/write/attempts
//   - POST   /api/write/extract-words    (vision-backed, v0.2 issue #59)
//
// Tested in isolation. Heavy lifting is in write-sync.ts (already
// covered by write-sync.test.ts). This module is the HTTP shell:
// validation, status codes, multer for the photo upload, and the
// vision call for extract-words.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "../db-migrate.js";
import { registerWriteRoutes } from "./write.js";

let db: Database.Database;
let app: ReturnType<typeof express>;
let mistakesDir: string;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
  mistakesDir = mkdtempSync(join(tmpdir(), "write-test-"));
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec("DELETE FROM writing_attempts");
  db.exec("DELETE FROM writing_words");

  app = express();
  app.use(express.json({ limit: "1mb" }));
  registerWriteRoutes(app, {
    db,
    logger: silentLogger(),
    mistakesDir,
    visionClient: null,
  });
});

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// --- /api/write/words -----------------------------------------------

describe("GET /api/write/words", () => {
  it("returns an empty array when the library is empty", async () => {
    const res = await request(app).get("/api/write/words");
    expect(res.status).toBe(200);
    expect(res.body.words).toEqual([]);
  });

  it("returns the chars already in the library", async () => {
    // Seed via POST first.
    await request(app).post("/api/write/words").send({ chars: "一二", addedBy: "test" });
    const res = await request(app).get("/api/write/words");
    const chars = (res.body.words as Array<{ char: string }>).map((w) => w.char);
    expect(chars).toContain("一");
    expect(chars).toContain("二");
  });
});

describe("POST /api/write/words", () => {
  it("adds new chars and reports added/skipped counts", async () => {
    const res = await request(app)
      .post("/api/write/words")
      .send({ chars: "一二三", addedBy: "test" });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(3);
    expect(res.body.skipped).toBe(0);
  });

  it("returns 400 when chars is not a string", async () => {
    const res = await request(app).post("/api/write/words").send({ chars: 123 });
    expect(res.status).toBe(400);
  });

  it("splits the string into individual CJK chars", async () => {
    const res = await request(app).post("/api/write/words").send({ chars: "天地人" });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(3);
  });
});

describe("DELETE /api/write/words/:char", () => {
  it("deletes an existing char and returns 200", async () => {
    await request(app).post("/api/write/words").send({ chars: "一" });
    const res = await request(app).delete("/api/write/words/一");
    expect(res.status).toBe(200);
  });

  it("returns 404 for a CJK char not in the library", async () => {
    // Use a CJK character that's not in the library (we never added it).
    const res = await request(app).delete("/api/write/words/永");
    expect(res.status).toBe(404);
  });
});

// --- /api/write/attempts --------------------------------------------

describe("GET /api/write/words/:char/attempts", () => {
  it("returns an empty list when no attempts exist", async () => {
    const res = await request(app).get("/api/write/words/一/attempts");
    expect(res.status).toBe(200);
    expect(res.body.attempts).toEqual([]);
  });
});

describe("POST /api/write/attempts", () => {
  it("records an attempt and returns the id", async () => {
    await request(app).post("/api/write/words").send({ chars: "一" });
    const res = await request(app)
      .post("/api/write/attempts")
      .send({ char: "一", level: 1.0, strokePath: "M 10 10 L 100 100" });
    expect(res.status).toBe(200);
    expect(res.body.attemptId).toBeTruthy();
  });

  it("accepts and returns an explainable handwriting assessment", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    const assessment = {
      status: "scored",
      score: 82,
      band: "写得规范",
      strokes: [[{ x: 100, y: 100 }, { x: 200, y: 100 }]],
      breakdown: { structure: 0.8, placement: 0.9, strokeQuality: 0.75, shape: 0.8 },
      reasons: [{ code: "placement_right", message: "整体向左一点" }],
      process: { orderErrors: 0, rejectedStrokes: 0 },
      algorithmVersion: "handwriting-coach-v1",
      nextAction: "review_later",
      retryOutcome: "failed",
      reviewNeeded: true,
      modelReview: { status: "skipped" },
    };

    const created = await request(app)
      .post("/api/write/attempts")
      .send({ char: "永", level: 1, strokePath: "M 100 100 L 200 100", assessment });
    expect(created.status).toBe(200);

    const history = await request(app).get("/api/write/words/永/attempts");
    expect(history.status).toBe(200);
    expect(history.body.attempts[0]).toMatchObject({
      status: "scored",
      score: 82,
      displayBand: "写得规范",
      algorithmVersion: "handwriting-coach-v1",
      reasons: assessment.reasons,
      process: assessment.process,
      nextAction: "review_later",
      retryOutcome: "failed",
      reviewNeeded: true,
    });
  });

  it("returns 400 when fields are missing or wrong type", async () => {
    const res = await request(app).post("/api/write/attempts").send({});
    expect(res.status).toBe(400);
  });
  it("rejects malformed nested stroke data instead of persisting it", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    const res = await request(app).post("/api/write/attempts").send({
      char: "永",
      level: 1,
      assessment: {
        status: "scored",
        score: 80,
        band: "写得规范",
        strokes: [[{ x: "not-a-number", y: 20 }]],
        breakdown: { structure: 0.8, placement: 0.8, strokeQuality: 0.8, shape: 0.8 },
        reasons: [],
        process: {},
        algorithmVersion: "handwriting-coach-v1",
      },
    });

    expect(res.status).toBe(400);
  });

  it("round-trips an unscorable attempt without inventing a low score", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    const created = await request(app).post("/api/write/attempts").send({
      char: "永",
      level: 1,
      assessment: {
        status: "unscorable",
        score: null,
        band: "暂时无法判断",
        strokes: [[{ x: 10, y: 10 }, { x: 20, y: 20 }]],
        breakdown: null,
        reasons: [{ code: "reference_unavailable", message: "这次暂时无法判断" }],
        process: {},
        algorithmVersion: "handwriting-coach-v1",
      },
    });

    expect(created.status).toBe(200);
    const history = await request(app).get("/api/write/words/永/attempts");
    expect(history.body.attempts[0]).toMatchObject({
      status: "unscorable",
      score: null,
      displayBand: "暂时无法判断",
    });
  });

  it("rejects semantically contradictory assessment states", async () => {
    await request(app).post("/api/write/words").send({ chars: "永" });
    const res = await request(app).post("/api/write/attempts").send({
      char: "永",
      level: 1,
      assessment: {
        status: "unscorable",
        score: 100,
        band: "写得很好",
        strokes: [[{ x: 10, y: 10 }, { x: 20, y: 20 }]],
        breakdown: { structure: 1, placement: 1, strokeQuality: 1, shape: 1 },
        reasons: [{ code: "reference_unavailable", message: "暂时无法判断" }],
        process: {},
        algorithmVersion: "handwriting-coach-v1",
      },
    });

    expect(res.status).toBe(400);
  });

});

describe("handwriting visual review", () => {
  it("returns 503 when visual review is not configured", async () => {
    const res = await request(app).post("/api/write/review").send({
      imageBase64: "abc123",
      localAssessment: { breakdown: { structure: 0.6 } },
    });

    expect(res.status).toBe(503);
  });

  it("reviews structure without blocking and persists the resulting metadata", async () => {
    const reviewApp = express();
    reviewApp.use(express.json({ limit: "1mb" }));
    registerWriteRoutes(reviewApp, {
      db,
      logger: silentLogger(),
      mistakesDir,
      visionClient: {
        async chat() {
          return { content: "左右两边再靠近一点。", raw: { stub: true } };
        },
      },
    });
    await request(reviewApp).post("/api/write/words").send({ chars: "永" });
    const attempt = await request(reviewApp).post("/api/write/attempts").send({
      char: "永",
      level: 1,
      strokePath: "M 1 1 L 2 2",
      assessment: {
        status: "scored",
        score: 74,
        band: "基本正确",
        strokes: [[{ x: 1, y: 1 }, { x: 2, y: 2 }]],
        breakdown: { structure: 0.6, placement: 0.8, strokeQuality: 0.8, shape: 0.7 },
        reasons: [{ code: "structure_proportion", message: "看看宽窄" }],
        process: {},
        algorithmVersion: "handwriting-coach-v1",
        modelReview: { status: "pending" },
      },
    });

    const reviewed = await request(reviewApp).post("/api/write/review").send({
      imageBase64: "abc123",
      localAssessment: { breakdown: { structure: 0.6 } },
    });
    expect(reviewed.status).toBe(200);
    expect(reviewed.body).toMatchObject({
      status: "completed",
      suggestion: "左右两边再靠近一点。",
      model: "MiniMax-M3",
    });
    expect(reviewed.body.raw).toBeUndefined();

    const updated = await request(reviewApp)
      .patch(`/api/write/attempts/${attempt.body.attemptId}/model-review`)
      .send({ modelReview: reviewed.body });
    expect(updated.status).toBe(200);

    const history = await request(reviewApp).get("/api/write/words/永/attempts");
    expect(history.body.attempts[0].modelReview).toMatchObject({
      status: "completed",
      suggestion: "左右两边再靠近一点。",
    });
  });
  it("returns a retryable error when visual review fails", async () => {
    const reviewApp = express();
    reviewApp.use(express.json({ limit: "1mb" }));
    registerWriteRoutes(reviewApp, {
      db,
      logger: silentLogger(),
      mistakesDir,
      visionClient: {
        async chat() {
          throw new Error("upstream timeout");
        },
      },
    });

    const res = await request(reviewApp).post("/api/write/review").send({
      imageBase64: "abc123",
      localAssessment: { breakdown: { structure: 0.6 } },
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/upstream timeout/);
  });

  it("enforces a server-side deadline when the provider never resolves", async () => {
    const reviewApp = express();
    reviewApp.use(express.json({ limit: "1mb" }));
    registerWriteRoutes(reviewApp, {
      db,
      logger: silentLogger(),
      mistakesDir,
      handwritingReviewTimeoutMs: 20,
      visionClient: {
        async chat() {
          return new Promise(() => {});
        },
      },
    });

    const res = await request(reviewApp).post("/api/write/review").send({
      imageBase64: "abc123",
      localAssessment: { breakdown: { structure: 0.6 } },
    });

    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/timeout/);
  });

});

// --- /api/write/extract-words ---------------------------------------

describe("POST /api/write/extract-words", () => {
  it("returns 503 when no vision client is configured", async () => {
    const res = await request(app)
      .post("/api/write/extract-words")
      .attach("image", Buffer.from("fake-jpg"), "list.jpg");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/vision not configured/);
  });

  it("returns 400 when no image is attached", async () => {
    const a = express();
    a.use(express.json({ limit: "1mb" }));
    registerWriteRoutes(a, {
      db,
      logger: silentLogger(),
      mistakesDir,
      visionClient: stubVision(["天", "地"]),
    });
    const res = await request(a).post("/api/write/extract-words").send({});
    expect(res.status).toBe(400);
  });

  it("analyses photo + returns extracted words (with stub vision)", async () => {
    const a = express();
    a.use(express.json({ limit: "1mb" }));
    registerWriteRoutes(a, {
      db,
      logger: silentLogger(),
      mistakesDir,
      visionClient: stubVision(["天", "地", "人"]),
    });
    const res = await request(a)
      .post("/api/write/extract-words")
      .attach("image", Buffer.from("fake-jpg"), "list.jpg");
    expect(res.status).toBe(200);
    expect(res.body.words).toEqual(["天", "地", "人"]);
    expect(res.body.model).toBe("MiniMax-M3");
  });
});

function stubVision(words: string[]) {
  return {
    async chat(_params: { system: string; user: string; imageBase64: string }) {
      return {
        content: words.join(" "),
        raw: { stub: true },
      };
    },
  };
}

// server/src/capture-organize.test.ts
//
// POST /api/capture/organize (buddy 文字描述 intake): an LLM structures a
// parent's messy one-line description ("昨天小宝算 8+5 写成 12") into the
// 5 fields /api/capture/manual needs. The prompt builder and response
// parser are pure functions (capture-organize.ts) tested without any
// LLM; the route tests use a stub VisionClient.
//
// Route contract:
//   happy path            → 200 { problem, userAnswer, correctAnswer,
//                                 subject, errorType }
//   text missing/empty/too long → 400
//   no visionClient configured  → 503 (clear Chinese error)
//   LLM garbage / request fails → 502

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import type { VisionClient } from "./vision.js";
import { buildOrganizePrompt, parseOrganizeResponse } from "./capture-organize.js";

const GOOD_JSON = JSON.stringify({
  problem: "8+5=?",
  userAnswer: "12",
  correctAnswer: "13",
  subject: "math",
  errorType: "进位加法错误",
});

function stubVisionClient(content: string): VisionClient {
  return {
    chat: async () => ({ content, raw: {} }),
  };
}

describe("capture-organize · buildOrganizePrompt", () => {
  it("embeds the parent's text and demands strict JSON with the 5 fields", () => {
    const text = "昨天小宝算 8+5 写成 12";
    const { system, user } = buildOrganizePrompt(text);
    expect(user).toContain(text);
    for (const field of ["problem", "userAnswer", "correctAnswer", "subject", "errorType"]) {
      expect(system).toContain(field);
    }
    // Strict JSON: the parser depends on it, so the prompt must say so.
    expect(system).toContain("JSON");
    expect(system).toContain("math");
    expect(system).toContain("chinese");
    expect(system).toContain("english");
  });
});

describe("capture-organize · parseOrganizeResponse", () => {
  it("parses a clean strict-JSON reply", () => {
    const out = parseOrganizeResponse(GOOD_JSON);
    expect(out).toEqual({
      problem: "8+5=?",
      userAnswer: "12",
      correctAnswer: "13",
      subject: "math",
      errorType: "进位加法错误",
    });
  });

  it("tolerates ```json fences and surrounding prose", () => {
    const fenced = "好的，整理如下：\n```json\n" + GOOD_JSON + "\n```";
    expect(parseOrganizeResponse(fenced)).toEqual(parseOrganizeResponse(GOOD_JSON));
  });

  it("fills fields the LLM couldn't determine with empty strings (parent edits in preview)", () => {
    const out = parseOrganizeResponse(JSON.stringify({ problem: "8+5=?", subject: "math" }));
    expect(out).toEqual({
      problem: "8+5=?",
      userAnswer: "",
      correctAnswer: "",
      subject: "math",
      errorType: "",
    });
  });

  it("normalizes a Chinese subject name to the english enum value", () => {
    const out = parseOrganizeResponse(JSON.stringify({ problem: "8+5=?", subject: "数学" }));
    expect(out?.subject).toBe("math");
  });

  it("drops an unknown subject to '' — the parent picks it in the preview UI", () => {
    const out = parseOrganizeResponse(JSON.stringify({ problem: "p", subject: "science" }));
    expect(out?.subject).toBe("");
  });

  it("returns null on non-JSON garbage", () => {
    expect(parseOrganizeResponse("我看不懂这段话")).toBeNull();
    expect(parseOrganizeResponse("")).toBeNull();
    expect(parseOrganizeResponse("[1,2,3]")).toBeNull();
  });
});

describe("POST /api/capture/organize", () => {
  let tmpDir: string;
  let db: Database.Database;

  beforeAll(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-capture-organize-"));
    db = new Database(join(tmpDir, "test.db"));
    db.pragma("journal_mode = WAL");
    migrateSchema(db);
  });

  afterAll(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  function appWith(visionClient: VisionClient | null) {
    return createApp({
      db,
      httpsPort: 3000,
      outboxPath: join(tmpDir, "outbox.jsonl"),
      visionClient,
    });
  }

  it("happy path: messy parent text → 200 with the 5 structured fields", async () => {
    const app = appWith(stubVisionClient(GOOD_JSON));
    const res = await request(app)
      .post("/api/capture/organize")
      .send({ text: "昨天小宝算 8+5 写成 12" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      problem: "8+5=?",
      userAnswer: "12",
      correctAnswer: "13",
      subject: "math",
      errorType: "进位加法错误",
    });
  });

  it("empty / missing / overlong text → 400", async () => {
    const app = appWith(stubVisionClient(GOOD_JSON));
    for (const text of ["", "   ", undefined, "x".repeat(501)]) {
      const res = await request(app)
        .post("/api/capture/organize")
        .send(text === undefined ? {} : { text });
      expect(res.status).toBe(400);
      expect(res.body).toHaveProperty("error");
    }
  });

  it("no visionClient configured → 503 with a clear Chinese error", async () => {
    const app = appWith(null);
    const res = await request(app)
      .post("/api/capture/organize")
      .send({ text: "昨天小宝算 8+5 写成 12" });
    expect(res.status).toBe(503);
    expect(res.body.error).toContain("MINIMAX_API_KEY");
  });

  it("LLM garbage → 502", async () => {
    const app = appWith(stubVisionClient("这不是 JSON"));
    const res = await request(app)
      .post("/api/capture/organize")
      .send({ text: "昨天小宝算 8+5 写成 12" });
    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("LLM request failure → 502", async () => {
    const failing: VisionClient = {
      chat: async () => {
        throw new Error("vision API 500: boom");
      },
    };
    const app = appWith(failing);
    const res = await request(app)
      .post("/api/capture/organize")
      .send({ text: "昨天小宝算 8+5 写成 12" });
    expect(res.status).toBe(502);
    expect(res.body).toHaveProperty("error");
  });

  it("text-only call: the stub receives no image", async () => {
    let seen: unknown = "unset";
    const peeking: VisionClient = {
      chat: async (params) => {
        seen = params;
        return { content: GOOD_JSON, raw: {} };
      },
    };
    const app = appWith(peeking);
    const res = await request(app)
      .post("/api/capture/organize")
      .send({ text: "昨天小宝算 8+5 写成 12" });
    expect(res.status).toBe(200);
    const params = seen as { imageBase64?: string; user: string };
    expect(params.imageBase64 === undefined || params.imageBase64 === "").toBe(true);
    expect(params.user).toContain("昨天小宝算 8+5 写成 12");
  });
});

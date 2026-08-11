// server/src/routes/chat.test.ts
//
// Tests for the chat route module extracted from app.ts (PR 4 of
// the refactor series). The module owns:
//   - POST /api/video-mode
//   - POST /api/frame
//   - POST /api/chat         (LLM-backed)
//   - POST /api/voice        (placeholder)
//   - POST /api/mistake-photo (vision-backed)
//
// chat is the most complex module in the codebase: it integrates
// the LLM (callMinimax), session lifecycle, emotion classification,
// name-change detection, outbox (parent notify), and the camera
// frame analyzer. We test in isolation with all heavy deps mocked
// or stubbed so a single test doesn't hit the network or the DB
// schema of another module.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import Database from "better-sqlite3";
import { migrateSchema } from "../db-migrate.js";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import multer from "multer";
import { registerChatRoutes, classifyTopic, type ChatRouteDeps } from "./chat.js";

let db: Database.Database;
let app: ReturnType<typeof express>;
let mistakesDir: string;
let deps: ChatRouteDeps;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
  mistakesDir = mkdtempSync(join(tmpdir(), "chat-test-"));
});

afterAll(() => db.close());

beforeEach(() => {
  // Wipe the session-scoped tables for isolation.
  db.exec("DELETE FROM chat_turns");
  db.exec("DELETE FROM posture_events");
  db.exec("DELETE FROM mistakes");
  db.exec("DELETE FROM sessions");

  app = express();
  app.use(express.json({ limit: "1mb" }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 },
  });

  deps = {
    db,
    logger: silentLogger(),
    visionClient: null,  // by default; tests opt in
    mistakesDir,
    upload,
    callMinimax: async (messages) => {
      // Echo the user's text back so we can assert round-trip.
      const last = messages[messages.length - 1];
      return `echo: ${last?.content || ""}`;
    },
  };

  registerChatRoutes(app, deps);
});

function silentLogger() {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

// --- classifyTopic ---------------------------------------------------

describe("classifyTopic", () => {
  it("classifies learning topics as 'learning'", () => {
    expect(classifyTopic("这道数学题怎么做？")).toBe("learning");
  });

  it("classifies offtopic by keyword", () => {
    expect(classifyTopic("我们玩王者荣耀吧")).toBe("offtopic");
    expect(classifyTopic("我想看B站")).toBe("offtopic");
    expect(classifyTopic("我们来玩原神")).toBe("offtopic");
  });

  it("classifies emotion keywords", () => {
    expect(classifyTopic("我好累")).toBe("emotion");
    expect(classifyTopic("我怕")).toBe("emotion");
  });

  it("defaults to 'learning' for unknown text", () => {
    expect(classifyTopic("你能帮我看看这道题吗")).toBe("learning");
  });
});

// --- POST /api/video-mode --------------------------------------------

describe("POST /api/video-mode", () => {
  it("returns the new state", async () => {
    const r1 = await request(app).post("/api/video-mode").send({ enabled: false });
    expect(r1.status).toBe(200);
    expect(r1.body.videoEnabled).toBe(false);

    const r2 = await request(app).post("/api/video-mode").send({ enabled: true });
    expect(r2.body.videoEnabled).toBe(true);
  });
});

// --- POST /api/voice -------------------------------------------------

describe("POST /api/voice", () => {
  it("returns the placeholder response for v0.1", async () => {
    const res = await request(app)
      .post("/api/voice")
      .attach("audio", Buffer.from("fake-audio"), "voice.webm");
    expect(res.status).toBe(200);
    expect(res.body.text).toBe("");
    expect(res.body.error).toMatch(/STT 还没接/);
  });

  it("returns 400 when no audio file is attached", async () => {
    const res = await request(app).post("/api/voice").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no audio/);
  });
});

// --- POST /api/chat --------------------------------------------------

describe("POST /api/chat", () => {
  it("returns 400 when text is missing", async () => {
    const res = await request(app).post("/api/chat").send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/no text/);
  });

  it("echoes back via the injected callMinimax (round-trip)", async () => {
    const res = await request(app).post("/api/chat").send({ text: "你好" });
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("echo: 你好");
    expect(res.body.topic).toBe("learning");
    expect(res.body.redirected).toBe(false);
  });

  it("auto-creates a session if none is active (issue #28 + #46)", async () => {
    const res = await request(app).post("/api/chat").send({ text: "hi" });
    expect(res.status).toBe(200);
    // A new session was created.
    const row = db.prepare("SELECT id FROM sessions WHERE ended_at IS NULL").get() as { id: string };
    expect(row).toBeDefined();
  });

  it("logs both child and agent turns in chat_turns", async () => {
    await request(app).post("/api/chat").send({ text: "做题" });
    const rows = db.prepare("SELECT role, content FROM chat_turns ORDER BY id").all() as Array<{ role: string; content: string }>;
    expect(rows.length).toBe(2);
    expect(rows[0].role).toBe("child");
    expect(rows[0].content).toBe("做题");
    expect(rows[1].role).toBe("agent");
    expect(rows[1].content).toMatch(/^echo:/);
  });

  it("records redirected=1 when child is offtopic and agent isn't", async () => {
    // Stub returns a learning reply ("echo: 写作业吧") even when
    // the child's input is offtopic — that's the redirected case.
    const a = express();
    a.use(express.json({ limit: "1mb" }));
    registerChatRoutes(a, {
      ...deps,
      callMinimax: async () => "echo: 写作业吧",
    });
    const res = await request(a).post("/api/chat").send({ text: "我们玩王者荣耀" });
    expect(res.body.topic).toBe("offtopic");
    expect(res.body.redirected).toBe(true);
  });
});

// --- POST /api/mistake-photo -----------------------------------------

describe("POST /api/mistake-photo", () => {
  it("returns 503 when no vision client is configured", async () => {
    const res = await request(app)
      .post("/api/mistake-photo")
      .attach("photo", Buffer.from("fake-jpg"), "homework.jpg");
    expect(res.status).toBe(503);
    expect(res.body.error).toMatch(/vision not configured/);
  });

  it("returns 400 when no photo is attached", async () => {
    // Need to mount a fresh app with a vision client, otherwise
    // the route returns 503 before the photo check.
    const a = express();
    a.use(express.json({ limit: "1mb" }));
    registerChatRoutes(a, { ...deps, visionClient: makeStubVision() });
    const res = await request(a).post("/api/mistake-photo").send({});
    expect(res.status).toBe(400);
  });

  it("analyses photo + writes a mistakes row (with stub vision)", async () => {
    const a = express();
    a.use(express.json({ limit: "1mb" }));
    registerChatRoutes(a, {
      ...deps,
      visionClient: makeStubVision({
        problemText: "2 + 2 = ?",
        reasoning: "basic arithmetic",
        model: "MiniMax-M3",
      }),
    });

    const res = await request(a)
      .post("/api/mistake-photo")
      .attach("photo", Buffer.from("fake-jpg"), "homework.jpg");
    expect(res.status).toBe(200);
    expect(res.body.problemText).toBe("2 + 2 = ?");
    expect(res.body.model).toBe("MiniMax-M3");
    expect(res.body.mistakeId).toBeTruthy();

    // Verify DB row.
    const row = db.prepare("SELECT subject, problem FROM mistakes LIMIT 1").get() as
      | { subject: string; problem: string };
    expect(row).toBeDefined();
    expect(row.problem).toBe("2 + 2 = ?");
  });
});

function makeStubVision(returnValue?: { problemText: string; reasoning: string; model: string }) {
  // The chat returns content with the 题目/思路 markers that
  // parseVisionResponse() looks for. Without those markers, the
  // whole content is treated as the problem text.
  const problemText = returnValue?.problemText ?? "(stub)";
  const reasoning = returnValue?.reasoning ?? "stub";
  return {
    async chat(_params: { system: string; user: string; imageBase64: string }) {
      return {
        content: `题目: ${problemText}\n思路: ${reasoning}`,
        raw: { stub: true, model: returnValue?.model ?? "MiniMax-M3" },
      };
    },
  };
}

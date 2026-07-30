import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { handleTool } from "./tools.js";
import { initDb, getDb } from "./db.js";

// fetch stub helper — vi.stubGlobal returns a vi.SinonStub; use vi.fn impl.
let currentFetchStub: ReturnType<typeof vi.fn> | null = null;
function stubFetch(impl: (url: string, init: any) => Promise<Response>) {
  currentFetchStub = vi.fn(impl) as unknown as ReturnType<typeof vi.fn>;
  vi.stubGlobal("fetch", currentFetchStub);
}
function unstubFetch() {
  if (currentFetchStub) {
    currentFetchStub.mockReset();
    currentFetchStub = null;
  }
  vi.unstubAllGlobals();
}

let db: Database.Database;

beforeAll(() => {
  // initDb runs migrations + seeds default child on a fresh in-memory db.
  // We grab the same instance via getDb() so this `db` and the Proxy
  // inside ./tools.js point at the same connection (not two separate
  // :memory: databases).
  initDb(":memory:");
  db = getDb();
});

afterAll(() => {
  db.close();
});

afterEach(() => {
  unstubFetch();
  db.exec("DELETE FROM mistakes");
  db.exec("DELETE FROM sessions");
  db.exec("DELETE FROM game_sessions");
});

describe("get_apps (mcp tool)", () => {
  it("fetches the apps registry from the HTTP server and marks source='server'", async () => {
    stubFetch(async () => {
      return new Response(JSON.stringify({ apps: [{ id: "x", name: "X" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    });
    const result = (await handleTool("get_apps", {})) as any;
    expect(result.source).toBe("server");
    expect(result.apps).toEqual([{ id: "x", name: "X" }]);
  });

  it("falls back to a static list when the HTTP server is unreachable", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    const result = (await handleTool("get_apps", {})) as any;
    expect(result.source).toBe("static-fallback");
    expect(result.apps!.length).toBeGreaterThan(0);
    expect(result.apps!.find((a: any) => a.id === "candy-math-island")).toBeDefined();
  });

  it("falls back when the HTTP server returns 500", async () => {
    stubFetch(async () => {
      return new Response("boom", { status: 500 });
    });
    const result = (await handleTool("get_apps", {})) as any;
    expect(result.source).toBe("static-fallback");
  });
});

describe("get_game_weak_topics (mcp tool)", () => {
  it("aggregates source='game' mistakes by (subject, errorType) within the window", async () => {
    // Seed: one session with three mistakes, two are game, one is study-buddy.
    db.prepare("INSERT INTO sessions (id, child_id) VALUES (?, ?)").run("s1", "default");
    db.prepare(
      "INSERT INTO mistakes (session_id, subject, problem, error_type, source) VALUES (?, ?, ?, ?, 'game')"
    ).run("s1", "math", "5+7=?", "carry");
    db.prepare(
      "INSERT INTO mistakes (session_id, subject, problem, error_type, source) VALUES (?, ?, ?, ?, 'game')"
    ).run("s1", "math", "8+6=?", "carry");
    db.prepare(
      "INSERT INTO mistakes (session_id, subject, problem, error_type, source) VALUES (?, ?, ?, ?, 'study-buddy')"
    ).run("s1", "math", "vision-only", "carry");

    const result = (await handleTool("get_game_weak_topics", { childId: "default", days: 7 })) as any;
    expect(result.scope).toBe("game");
    const topics = result.weakTopics ?? [];
    const carry = topics.find((t: any) => t.errorType === "carry");
    expect(carry).toBeDefined();
    expect(carry!.count).toBe(2);
  });

  it("returns [] when there are no game mistakes", async () => {
    const result = (await handleTool("get_game_weak_topics", {})) as any;
    expect(result.weakTopics ?? []).toEqual([]);
  });
});

describe("get_game_daily_stats (mcp tool)", () => {
  function seedSession(daysAgo: number, total: number, correct: number, appId = "candy-math-island") {
    const startedAt = Date.now() - daysAgo * 24 * 3600 * 1000 - 30_000;
    const endedAt = startedAt + 60_000;
    db.prepare(
      `INSERT INTO game_sessions
         (child_id, app_id, duration_sec, total_questions, correct_count, started_at, ended_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run("default", appId, 60, total, correct, startedAt, endedAt);
  }

  it("returns one row per day with correct rate", async () => {
    seedSession(0, 12, 9);
    seedSession(0, 8, 8);
    seedSession(1, 10, 7);
    const result = (await handleTool("get_game_daily_stats", { childId: "default", days: 7 })) as any;
    expect(result.scope).toBe("game-session");
    const daily = result.daily ?? [];
    expect(daily).toHaveLength(2);
    expect(daily[0].totalQuestions).toBe(20);
    expect(daily[0].correctCount).toBe(17);
    expect(daily[0].correctRate).toBe(85);
  });

  it("returns [] when no sessions exist", async () => {
    const result = (await handleTool("get_game_daily_stats", {})) as any;
    expect(result.daily ?? []).toEqual([]);
  });

  it("can filter by appId", async () => {
    seedSession(0, 10, 8, "candy-math-island");
    seedSession(0, 5, 5, "another-app");
    const candy = (await handleTool("get_game_daily_stats", { appId: "candy-math-island" })) as any;
    const candyDaily = candy.daily ?? [];
    expect(candyDaily).toHaveLength(1);
    expect(candyDaily[0].totalQuestions).toBe(10);
  });
});

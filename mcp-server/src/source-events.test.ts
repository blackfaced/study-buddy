import { beforeEach, describe, expect, it } from "vitest";
import { getDb, initDb } from "./db.js";
import { handleTool } from "./tools.js";

describe("MCP transactional Source Event writes", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  it("publishes chat, mistake, and completed-session writes atomically", async () => {
    const db = getDb();
    const started = await handleTool("start_session", {
      childId: "default",
      subject: "math",
    }) as { sessionId: string };
    await handleTool("log_chat", {
      sessionId: started.sessionId,
      role: "child",
      content: "2 + 2 是多少",
      topic: "learning",
    });
    const firstMistake = await handleTool("log_mistake", {
      sessionId: started.sessionId,
      subject: "math",
      problem: "2 + 2",
      userAnswer: "5",
      correctAnswer: "4",
      errorType: "compute",
    }) as { caseId: string };
    const retryMistake = await handleTool("log_mistake", {
      sessionId: started.sessionId,
      subject: "math",
      problem: "2 + 2",
      userAnswer: "5",
      correctAnswer: "4",
      errorType: "compute",
    }) as { caseId: string };
    // T10 mirror work: log_mistake now returns the closure-loop
    // caseId and skips the legacy `mistakes` mirror. The dedupe
    // contract is "same (child, problem, source) → same caseId".
    expect(retryMistake.caseId).toBe(firstMistake.caseId);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistake_cases").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM learning_attempts").get()).toEqual({ count: 1 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM correction_obligations").get()).toEqual({ count: 1 });
    const completed = await handleTool("end_session", {
      sessionId: started.sessionId,
    }) as { revision: number };

    expect(completed.revision).toBe(1);
    const events = db.prepare(
      `SELECT record_type, event_type, payload_json
       FROM source_events ORDER BY seq`,
    ).all() as Array<{ record_type: string; event_type: string; payload_json: string }>;
    expect(events.map((event) => event.event_type)).toEqual([
      "chat_turn_recorded",
      "learning_attempt_recorded",
      "learning_session_completed",
    ]);
    expect(JSON.parse(events[0].payload_json)).not.toHaveProperty("content");
  });

  it("does not duplicate a completed session event when end_session is retried", async () => {
    const db = getDb();
    const started = await handleTool("start_session", {}) as { sessionId: string };
    const first = await handleTool("end_session", { sessionId: started.sessionId });
    const retry = await handleTool("end_session", { sessionId: started.sessionId });
    expect(retry).toEqual(first);
    expect(db.prepare(
      "SELECT COUNT(*) AS count FROM source_events WHERE record_type = 'learning_session'",
    ).get()).toEqual({ count: 1 });
  });

  it("rolls back an MCP chat row if its Source Event cannot be inserted", async () => {
    const db = getDb();
    const started = await handleTool("start_session", {}) as { sessionId: string };
    db.exec(`
      CREATE TRIGGER fail_mcp_chat_source
      BEFORE INSERT ON source_events
      WHEN NEW.record_type = 'chat_turn'
      BEGIN SELECT RAISE(ABORT, 'forced failure'); END;
    `);
    await expect(handleTool("log_chat", {
      sessionId: started.sessionId,
      role: "child",
      content: "rollback",
      topic: "learning",
    })).rejects.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM chat_turns").get())
      .toEqual({ count: 0 });
  });
});

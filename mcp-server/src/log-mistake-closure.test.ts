// mcp-server/src/log-mistake-closure.test.ts
//
// TDD test for the closure-loop rewrite of MCP `log_mistake` (issue #166
// mirror work on the mcp-server side). T10 retired the legacy
// `/api/game/mistake` endpoint on the server; the mcp-server's
// `log_mistake` tool is the parallel write surface and was still on
// the pre-T1 contract (writing the `mistakes` mirror + a compat
// bridge). These tests pin the new contract: closure-loop is the
// source of truth, mistakes table is no longer touched.

import { beforeEach, describe, expect, it } from "vitest";
import { getDb, initDb } from "./db.js";
import { handleTool } from "./tools.js";

const CHILD = "default";

async function startSession() {
  const r = await handleTool("start_session", {
    childId: CHILD,
    subject: "math",
  }) as { sessionId: string };
  return r.sessionId;
}

describe("MCP log_mistake → closure loop (issue #166 mirror)", () => {
  beforeEach(() => {
    initDb(":memory:");
  });

  it("M-1: requires userAnswer and correctAnswer, missing fields are an error", async () => {
    const sessionId = await startSession();
    const noAnswer = await handleTool("log_mistake", {
      sessionId,
      subject: "math",
      problem: "3 + 4",
      errorType: "compute",
    });
    expect((noAnswer as { isError?: boolean }).isError).toBe(true);

    const noCorrect = await handleTool("log_mistake", {
      sessionId,
      subject: "math",
      problem: "3 + 4",
      errorType: "compute",
      userAnswer: "6",
    });
    expect((noCorrect as { isError?: boolean }).isError).toBe(true);
  });

  it("M-2: writes mistake_cases + learning_attempts (original) + correction_obligations (open)", async () => {
    const sessionId = await startSession();
    const out = await handleTool("log_mistake", {
      sessionId,
      subject: "math",
      problem: "3 + 4",
      userAnswer: "6",
      correctAnswer: "7",
      errorType: "compute",
    }) as { caseId: string; mistakeId: number; created: boolean };
    expect(out.caseId).toMatch(/^case:/);
    // T10 mirror work: MCP writes skip the legacy `mistakes` mirror
    // (mistakeId is 0 because there's no mirror row). The
    // authoritative id is the closure-loop case_id.
    expect(out.mistakeId).toBe(0);
    expect(out.created).toBe(true);

    const db = getDb();
    const caseRow = db
      .prepare(
        "SELECT case_id, child_id, problem, user_answer, correct_answer, error_type, source FROM mistake_cases WHERE case_id = ?",
      )
      .get(out.caseId) as Record<string, unknown> | undefined;
    expect(caseRow).toMatchObject({
      case_id: out.caseId,
      child_id: CHILD,
      problem: "3 + 4",
      user_answer: "6",
      correct_answer: "7",
      error_type: "compute",
      source: "study-buddy",
    });

    const attempt = db
      .prepare(
        "SELECT attempt_kind, is_correct, child_id FROM learning_attempts WHERE case_id = ?",
      )
      .get(out.caseId) as Record<string, unknown> | undefined;
    expect(attempt).toMatchObject({
      attempt_kind: "original",
      is_correct: 0,
      child_id: CHILD,
    });

    const obligation = db
      .prepare("SELECT status, reviewed_count FROM correction_obligations WHERE case_id = ?")
      .get(out.caseId) as { status: string; reviewed_count: number } | undefined;
    expect(obligation).toEqual({ status: "open", reviewed_count: 0 });
  });

  it("M-3: duplicate (child, problem, source) returns same caseId, does not create new case", async () => {
    const sessionId = await startSession();
    const first = await handleTool("log_mistake", {
      sessionId,
      subject: "math",
      problem: "9 - 4",
      userAnswer: "4",
      correctAnswer: "5",
      errorType: "compute",
    }) as { caseId: string; created: boolean };
    expect(first.created).toBe(true);

    const second = await handleTool("log_mistake", {
      sessionId,
      subject: "math",
      problem: "9 - 4",
      userAnswer: "5",
      correctAnswer: "5",
      errorType: "compute",
    }) as { caseId: string; created: boolean };
    expect(second.caseId).toBe(first.caseId);
    expect(second.created).toBe(false);

    const db = getDb();
    const count = db
      .prepare("SELECT COUNT(*) AS c FROM mistake_cases WHERE child_id = ? AND problem = ?")
      .get(CHILD, "9 - 4") as { c: number };
    expect(count.c).toBe(1);
  });

  it("M-4: emits a learning_attempt_recorded source_event with subject/problem/mistakeType in payload", async () => {
    const sessionId = await startSession();
    const out = await handleTool("log_mistake", {
      sessionId,
      subject: "math",
      problem: "6 × 7",
      userAnswer: "36",
      correctAnswer: "42",
      errorType: "carry",
    }) as { caseId: string };
    const db = getDb();
    // out.caseId is already prefixed with "case:"; record_id matches it.
    const events = db
      .prepare(
        `SELECT record_type, event_type, payload_json
           FROM source_events
          WHERE record_id = ?`,
      )
      .all(out.caseId) as Array<{
        record_type: string;
        event_type: string;
        payload_json: string;
      }>;
    expect(events).toHaveLength(1);
    expect(events[0].record_type).toBe("learning_attempt");
    expect(events[0].event_type).toBe("learning_attempt_recorded");
    const payload = JSON.parse(events[0].payload_json);
    expect(payload).toMatchObject({
      kind: "learning_attempt",
      subject: "math",
      problem: "6 × 7",
      submittedAnswer: "36",
      expectedAnswer: "42",
      mistakeType: "carry",
      source: "study-buddy",
    });
  });

  it("M-5: does not write the legacy `mistakes` mirror table", async () => {
    const sessionId = await startSession();
    await handleTool("log_mistake", {
      sessionId,
      subject: "math",
      problem: "100 / 4",
      userAnswer: "20",
      correctAnswer: "25",
      errorType: "compute",
    });
    const db = getDb();
    const mirrorCount = db
      .prepare("SELECT COUNT(*) AS c FROM mistakes")
      .get() as { c: number };
    expect(mirrorCount.c).toBe(0);
  });
});

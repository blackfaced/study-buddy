// server/src/capture-judge.test.ts
//
// Issue #229: vision-sourced mistake cases are inserted with
// correct_answer="" (confirmMistakePhotoDraft), so the exact-text
// answersMatch comparator could never pass — every correction attempt
// on a photo-captured case was judged wrong and the obligation could
// never close (real incident 2026-09-05: kid's correct 竖式谜题
// correction marked is_correct=0).
//
// Fix under test: POST /api/capture/case/:caseId/attempt falls back to
// the LLM judge (answer-judge.ts) when the case has no stored
// correct_answer. Judged-correct closes the obligation AND backfills
// correct_answer with the kid's answer so later review rounds use the
// exact comparator.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { insertMistake } from "./capture-service.js";
import type { VisionClient } from "./vision.js";

const CHILD = "default";

let tmpDir: string;
let db: Database.Database;

/** Seed the exact production shape from the incident: a vision case
 *  with empty user/correct answers, the way confirmMistakePhotoDraft
 *  writes it. Problem must be unique per test (insertMistake dedupes
 *  on child_id+problem+source). */
function seedVisionCase(problem: string): string {
  return insertMistake(db, {
    childId: CHILD,
    problem,
    userAnswer: "",
    correctAnswer: "",
    errorType: "confirmed",
    source: "vision",
    subject: "math",
  }).caseId;
}

function judgeClient(content: string, spy?: { calls: number }): VisionClient {
  return {
    async chat() {
      if (spy) spy.calls += 1;
      return { content, raw: null };
    },
  };
}

function makeApp(visionClient: VisionClient | null) {
  return createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
    visionClient,
  });
}

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-capture-judge-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("POST /api/capture/case/:caseId/attempt with empty correct_answer (issue #229)", () => {
  it("J1 (the real scenario): LLM judges 正确 → isCorrect, obligation verified, correct_answer backfilled", async () => {
    const caseId = seedVisionCase("J1: 2🐰+🐰🐼=62，🐰=？🐼=？");
    const app = makeApp(judgeClient("判定：正确"));
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "小兔子 3 小熊猫 9" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(true);
    expect(res.body.obligationStatus).toBe("verified");
    // Backfill: the case now carries the confirmed answer so future
    // review rounds use the exact comparator instead of the LLM.
    const row = db
      .prepare("SELECT correct_answer FROM mistake_cases WHERE case_id = ?")
      .get(caseId) as { correct_answer: string };
    expect(row.correct_answer).toBe("小兔子 3 小熊猫 9");
  });

  it("J2: LLM judges 错误 → not correct, obligation stays open, no backfill", async () => {
    const caseId = seedVisionCase("J2: 2🐰+🐰🐼=62，🐰=？🐼=？");
    const app = makeApp(judgeClient("判定：错误"));
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "小兔子 4 小熊猫 8" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(false);
    expect(res.body.obligationStatus).toBe("open");
    const row = db
      .prepare("SELECT correct_answer FROM mistake_cases WHERE case_id = ?")
      .get(caseId) as { correct_answer: string };
    expect(row.correct_answer).toBe("");
  });

  it("J3: LLM output unparseable → treated as not proven correct, obligation stays open", async () => {
    const caseId = seedVisionCase("J3: 无法判定的题");
    const app = makeApp(judgeClient("这道题我有点看不懂呢"));
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "42" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(false);
    expect(res.body.obligationStatus).toBe("open");
  });

  it("J4: no visionClient configured → judged false (pre-#229 behavior, no crash)", async () => {
    const caseId = seedVisionCase("J4: 没有 LLM 的题");
    const app = makeApp(null);
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "任何答案" });
    expect(res.status).toBe(200);
    expect(res.body.isCorrect).toBe(false);
    expect(res.body.obligationStatus).toBe("open");
  });

  it("J5: regression guard — case WITH correct_answer still uses answersMatch, LLM never called", async () => {
    const spy = { calls: 0 };
    const { caseId } = insertMistake(db, {
      childId: CHILD,
      problem: "J5: 8+5",
      userAnswer: "12",
      correctAnswer: "13",
      errorType: "compute",
      source: "manual",
      subject: "math",
    });
    const app = makeApp(judgeClient("判定：正确", spy));
    const res = await request(app)
      .post(`/api/capture/case/${caseId}/attempt`)
      .send({ childId: CHILD, answer: "13" });
    expect(res.body.isCorrect).toBe(true);
    expect(spy.calls).toBe(0);
  });
});

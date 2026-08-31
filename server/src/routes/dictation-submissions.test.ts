// server/src/routes/dictation-submissions.test.ts
//
// Dictation submissions → closure loop (issue #197, part of #192).
// A confirmed dictation result produces two INDEPENDENT outcomes:
//   - language result: wrong/pinyin chars go through the unified
//     Capture write path (insertMistake): Mistake Case (subject
//     chinese) + original Learning Attempt + open Correction
//     Obligation + matching Source Event, one transaction.
//   - handwriting result: poor legibility appends a Handwriting
//     Practice Observation — never a mistake case.
// Neither outcome closes or affects the other (AC1).
//
// "Confirmed" here means the kid/parent already confirmed per item in
// the dictation compare UI — the endpoint receives confirmed results
// and never re-confirms.

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp } from "../app.js";
import { migrateSchema } from "../db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-dictation-sub-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  app = createApp({
    db,
    httpsPort: 3000,
    outboxPath: join(tmpDir, "outbox.jsonl"),
  });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

const TABLE_COUNT_SQL = (t: string) => `SELECT COUNT(*) AS n FROM ${t}`;
function count(table: string): number {
  return (db.prepare(TABLE_COUNT_SQL(table)).get() as { n: number }).n;
}

async function createSet(words: string[] = ["苹果", "香蕉"]): Promise<string> {
  const res = await request(app)
    .post("/api/dictation/sets")
    .send({ words, sentence: "我爱吃水果。" });
  expect(res.status).toBe(201);
  return res.body.id;
}

// No beforeEach cleanup: mistake_cases dedupes on (child, problem,
// source), so each test below uses its own unique targets and
// idempotency keys. handwriting_observations is append-only by trigger
// and cannot be deleted anyway.

describe("POST /api/dictation/sets/:id/submissions (issue #197)", () => {
  it("REAL SCENARIO: 10 字默写错 2 个 → 恰好 2 个 Mistake Case，8 个正确字没有任何 obligation", async () => {
    const words = ["苹", "果", "香", "蕉", "春", "风", "明", "月", "山", "水"];
    const setId = await createSet(words);
    const before = {
      cases: count("mistake_cases"),
      attempts: count("learning_attempts"),
      obligations: count("correction_obligations"),
      events: count("source_events"),
    };

    const items = [
      ...words.map((target, i) => ({
        kind: "word",
        target,
        language: i < 2 ? "wrong" : "correct",
        replays: i === 0 ? 3 : 0, // 重听 3 次也绝不计为错误 (#196)
      })),
      { kind: "sentence", target: "我爱吃水果。", language: "correct", replays: 0 },
    ];
    const res = await request(app)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send({ idempotencyKey: "sub-week35-1", items });
    expect(res.status).toBe(201);
    expect(res.body.mistakeCases).toHaveLength(2);

    // Exactly 2 cases, each with an original attempt + open obligation
    // + matching source event. The 8 correct chars (+ the sentence)
    // produced NOTHING in the closure tables.
    expect(count("mistake_cases")).toBe(before.cases + 2);
    expect(count("learning_attempts")).toBe(before.attempts + 2);
    expect(count("correction_obligations")).toBe(before.obligations + 2);
    expect(count("source_events")).toBe(before.events + 2);

    const cases = db.prepare(
      "SELECT problem, subject, source FROM mistake_cases WHERE source = 'dictation' ORDER BY problem",
    ).all() as Array<{ problem: string; subject: string; source: string }>;
    expect(cases).toEqual([
      { problem: "果", subject: "chinese", source: "dictation" }, // 果 U+679C sorts before 苹 U+82F9
      { problem: "苹", subject: "chinese", source: "dictation" },
    ]);
    const openObligations = db.prepare(
      `SELECT co.status FROM correction_obligations co
         JOIN mistake_cases mc ON mc.case_id = co.case_id
        WHERE mc.source = 'dictation'`,
    ).all() as Array<{ status: string }>;
    expect(openObligations).toEqual([{ status: "open" }, { status: "open" }]);
  });

  it("AC1 four combos: wrong+poor → case+observation; wrong+ok → case; correct+poor → observation only; correct+ok → nothing", async () => {
    const setId = await createSet(["对错好", "对错差", "对对差", "对对好"]);
    const res = await request(app)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send({
        idempotencyKey: "sub-combos-1",
        items: [
          { kind: "word", target: "对错差", language: "wrong", handwriting: "poor" },
          { kind: "word", target: "对错好", language: "wrong", handwriting: "ok" },
          { kind: "word", target: "对对差", language: "correct", handwriting: "poor" },
          { kind: "word", target: "对对好", language: "correct", handwriting: "ok" },
          { kind: "sentence", target: "我爱吃水果。", language: "correct" },
        ],
      });
    expect(res.status).toBe(201);
    expect(res.body.mistakeCases).toHaveLength(2);
    expect(res.body.handwritingObservations).toBe(2);

    // Language outcomes: exactly the two wrong words became cases.
    const cases = db.prepare(
      "SELECT problem FROM mistake_cases WHERE source = 'dictation' AND problem LIKE '对错%' ORDER BY problem",
    ).all() as Array<{ problem: string }>;
    expect(cases.map((c) => c.problem)).toEqual(["对错好", "对错差"]);

    // Handwriting outcomes: exactly the two poor ones, incl. the
    // CORRECT-but-sloppy char (对对差) — which has NO case.
    const obs = db.prepare(
      "SELECT char, issue_type, source FROM handwriting_observations ORDER BY char",
    ).all() as Array<{ char: string; issue_type: string; source: string }>;
    expect(obs).toEqual([
      { char: "对对差", issue_type: "poor_legibility", source: "dictation" },
      { char: "对错差", issue_type: "poor_legibility", source: "dictation" },
    ]);

    // Independence: the observation on 对错差 does not touch its case's
    // obligation, and 对对差 has an observation with no case at all.
    const obligationCount = db.prepare(
      `SELECT COUNT(*) AS n FROM correction_obligations co
         JOIN mistake_cases mc ON mc.case_id = co.case_id
        WHERE mc.problem IN ('对错好', '对错差')`,
    ).get() as { n: number };
    expect(obligationCount.n).toBe(2);
    const accidentalCase = db.prepare(
      "SELECT COUNT(*) AS n FROM mistake_cases WHERE problem = '对对差'",
    ).get() as { n: number };
    expect(accidentalCase.n).toBe(0);
  });

  it("AC4: retry with the same idempotencyKey replays the first result, no double write", async () => {
    const setId = await createSet(["幂等字"]);
    const payload = {
      idempotencyKey: "sub-retry-1",
      items: [{ kind: "word", target: "幂等字", language: "wrong", handwriting: "poor" }],
    };
    const before = {
      cases: count("mistake_cases"),
      observations: count("handwriting_observations"),
      submissions: count("dictation_submissions"),
    };
    const first = await request(app)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send(payload);
    expect(first.status).toBe(201);

    const retry = await request(app)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send(payload);
    expect(retry.status).toBe(200);
    expect(retry.body).toEqual(first.body);

    expect(count("mistake_cases")).toBe(before.cases + 1);
    expect(count("handwriting_observations")).toBe(before.observations + 1);
    expect(count("dictation_submissions")).toBe(before.submissions + 1);
  });

  it("one transaction: a source-event failure rolls back cases, observations AND the receipt", async () => {
    const failApp = createApp({
      db,
      httpsPort: 3000,
      outboxPath: join(tmpDir, "outbox-fail.jsonl"),
      beforeSourceEventAppend: () => {
        throw new Error("boom");
      },
    });
    const setId = await createSet(["事务字"]);
    const before = {
      cases: count("mistake_cases"),
      attempts: count("learning_attempts"),
      obligations: count("correction_obligations"),
      observations: count("handwriting_observations"),
      submissions: count("dictation_submissions"),
    };
    const res = await request(failApp)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send({
        idempotencyKey: "sub-tx-1",
        items: [{ kind: "word", target: "事务字", language: "wrong", handwriting: "poor" }],
      });
    expect(res.status).toBe(500);
    expect(count("mistake_cases")).toBe(before.cases);
    expect(count("learning_attempts")).toBe(before.attempts);
    expect(count("correction_obligations")).toBe(before.obligations);
    expect(count("handwriting_observations")).toBe(before.observations);
    expect(count("dictation_submissions")).toBe(before.submissions);
  });

  it("400 on missing idempotencyKey / bad items; 404 on unknown set", async () => {
    const setId = await createSet(["校验字"]);
    const noKey = await request(app)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send({ items: [{ kind: "word", target: "校验字", language: "wrong" }] });
    expect(noKey.status).toBe(400);

    const badItem = await request(app)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send({ idempotencyKey: "sub-val-1", items: [{ kind: "word", target: "校验字", language: "maybe" }] });
    expect(badItem.status).toBe(400);

    const missing = await request(app)
      .post("/api/dictation/sets/dictation:nope/submissions")
      .send({ idempotencyKey: "sub-val-2", items: [{ kind: "word", target: "x", language: "wrong" }] });
    expect(missing.status).toBe(404);
  });

  it("handwriting_observations is append-only (trigger blocks UPDATE/DELETE)", async () => {
    const setId = await createSet(["观察字"]);
    await request(app)
      .post(`/api/dictation/sets/${setId}/submissions`)
      .send({
        idempotencyKey: "sub-appendonly-1",
        items: [{ kind: "word", target: "观察字", language: "correct", handwriting: "poor" }],
      });
    expect(() =>
      db.prepare("UPDATE handwriting_observations SET issue_type = 'x'").run(),
    ).toThrow(/append-only/);
    expect(() =>
      db.prepare("DELETE FROM handwriting_observations").run(),
    ).toThrow(/append-only/);
  });
});

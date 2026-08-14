// web/games/multiplication-drill/pick-gen.test.js
// =====================================================================
// #38 (1-9 multiplication drill) — pick-gen unit tests.
//
// Two pure helpers under test:
//   - pickMultiplicationQuestion(rng) -> { a, b, answer, problem }
//   - makeMultiplicationTable()       -> string
//
// `rng` is injected so the test can drive it deterministically; the
// real UI uses Math.random wrapped in a closure. The function is the
// single source of truth for the question space, so the tests cover
// the range bounds (1..9), arithmetic correctness, the problem
// formatting, and the on-wrong table rendering.
// =====================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickMultiplicationQuestion, makeMultiplicationTable } from "./pick-gen.js";

function makeRng(sequence) {
  let i = 0;
  return () => {
    const v = sequence[i % sequence.length];
    i += 1;
    return v;
  };
}

test("pickMultiplicationQuestion: a and b both fall in [1, 9]", () => {
  // Simulate 200 random picks; every (a, b) must be valid table entries.
  for (let i = 0; i < 200; i += 1) {
    const q = pickMultiplicationQuestion(Math.random);
    assert.ok(Number.isInteger(q.a), "a must be an integer");
    assert.ok(Number.isInteger(q.b), "b must be an integer");
    assert.ok(q.a >= 1 && q.a <= 9, `a out of range: ${q.a}`);
    assert.ok(q.b >= 1 && q.b <= 9, `b out of range: ${q.b}`);
  }
});

test("pickMultiplicationQuestion: answer equals a * b", () => {
  for (let i = 0; i < 100; i += 1) {
    const q = pickMultiplicationQuestion(Math.random);
    assert.equal(q.answer, q.a * q.b);
  }
});

test("pickMultiplicationQuestion: problem string is \"a × b = ?\"", () => {
  for (let i = 0; i < 50; i += 1) {
    const q = pickMultiplicationQuestion(Math.random);
    assert.equal(q.problem, `${q.a} × ${q.b} = ?`);
  }
});

test("pickMultiplicationQuestion: deterministic with seeded rng", () => {
  // rng always returns 0 → 0 * 9 = 0 (floor) + 1 = 1 for both operands
  const q1 = pickMultiplicationQuestion(makeRng([0]));
  const q2 = pickMultiplicationQuestion(makeRng([0]));
  assert.deepEqual(q1, q2);
  assert.equal(q1.a, 1);
  assert.equal(q1.b, 1);
  assert.equal(q1.answer, 1);
  assert.equal(q1.problem, "1 × 1 = ?");
});

test("pickMultiplicationQuestion: rng near 1 picks the high end", () => {
  // rng returns 0.99999 → floor(0.99999 * 9) + 1 = floor(8.99991) + 1 = 8 + 1 = 9
  const q = pickMultiplicationQuestion(makeRng([0.99999]));
  assert.equal(q.a, 9);
  assert.equal(q.b, 9);
  assert.equal(q.answer, 81);
  assert.equal(q.problem, "9 × 9 = ?");
});

test("makeMultiplicationTable: 9 rows of 9 cells each", () => {
  const table = makeMultiplicationTable();
  const lines = table.split("\n");
  assert.equal(lines.length, 9, "expected 9 lines");
  for (const line of lines) {
    const cells = line.split("  ");
    assert.equal(cells.length, 9, `expected 9 cells per line, got: ${line}`);
  }
});

test("makeMultiplicationTable: row 0 is the 1×N table", () => {
  const table = makeMultiplicationTable();
  const lines = table.split("\n");
  assert.equal(lines[0], "1×1=1  1×2=2  1×3=3  1×4=4  1×5=5  1×6=6  1×7=7  1×8=8  1×9=9");
});

test("makeMultiplicationTable: row 8 is the 9×N table (last row)", () => {
  const table = makeMultiplicationTable();
  const lines = table.split("\n");
  // 9×1=9, 9×2=18, ..., 9×9=81
  assert.equal(lines[8], "9×1=9  9×2=18  9×3=27  9×4=36  9×5=45  9×6=54  9×7=63  9×8=72  9×9=81");
});

test("makeMultiplicationTable: cell at row r, col c equals (r+1) * (c+1)", () => {
  const table = makeMultiplicationTable();
  const lines = table.split("\n");
  for (let r = 0; r < 9; r += 1) {
    const cells = lines[r].split("  ");
    for (let c = 0; c < 9; c += 1) {
      const a = r + 1;
      const b = c + 1;
      assert.equal(cells[c], `${a}×${b}=${a * b}`, `row ${r} col ${c} mismatch`);
    }
  }
});

test("makeMultiplicationTable: returns the same string on repeat calls (pure)", () => {
  assert.equal(makeMultiplicationTable(), makeMultiplicationTable());
});

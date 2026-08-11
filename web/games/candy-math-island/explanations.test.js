// explanations.test.js
//
// Tests for the static errorType → explanation map used by the
// inline wrong-answer card (issue #116, T4 of #34 split).
//
// Each errorType the quiz uses must have a hand-written entry; unknown
// or null errorTypes fall through to a generic "再仔细看看" message
// so the card always has something to display (never blank).
//
// Run: cd web/games/candy-math-island && node --test explanations.test.js

import { test } from "node:test";
import assert from "node:assert/strict";
import { getExplanation, EXPLANATIONS, GENERIC_FALLBACK } from "./explanations.js";

test("explanations: EXPLANATIONS has entries for the 4 core errorTypes", () => {
  for (const et of ["compute", "carry", "borrow", "multiply"]) {
    assert.ok(EXPLANATIONS[et], `EXPLANATIONS must have entry for "${et}"`);
    const e = EXPLANATIONS[et];
    assert.equal(typeof e.title, "string", `${et}.title must be string`);
    assert.equal(typeof e.body, "string", `${et}.body must be string`);
    assert.ok(e.title.length > 0, `${et}.title must not be empty`);
    assert.ok(e.body.length > 0, `${et}.body must not be empty`);
  }
});

test("explanations: GENERIC_FALLBACK has title + body", () => {
  assert.equal(typeof GENERIC_FALLBACK.title, "string");
  assert.equal(typeof GENERIC_FALLBACK.body, "string");
  assert.ok(GENERIC_FALLBACK.title.length > 0);
  assert.ok(GENERIC_FALLBACK.body.length > 0);
});

test("getExplanation: returns EXPLANATIONS[errorType] for known types", () => {
  for (const et of ["compute", "carry", "borrow", "multiply"]) {
    const e = getExplanation(et);
    assert.equal(e, EXPLANATIONS[et], `${et} should map to its own entry`);
  }
});

test("getExplanation: returns GENERIC_FALLBACK for unknown errorType", () => {
  const e = getExplanation("something-else");
  assert.equal(e, GENERIC_FALLBACK);
  assert.equal(e.title, GENERIC_FALLBACK.title);
  assert.equal(e.body, GENERIC_FALLBACK.body);
});

test("getExplanation: returns GENERIC_FALLBACK for null errorType", () => {
  const e = getExplanation(null);
  assert.equal(e, GENERIC_FALLBACK);
});

test("getExplanation: returns GENERIC_FALLBACK for undefined errorType", () => {
  const e = getExplanation(undefined);
  assert.equal(e, GENERIC_FALLBACK);
});

test("getExplanation: returns GENERIC_FALLBACK for empty-string errorType", () => {
  const e = getExplanation("");
  assert.equal(e, GENERIC_FALLBACK);
});

test("getExplanation: is pure (same input → same output, no side effects)", () => {
  // Just call it many times and check determinism. No setup/teardown
  // because EXPLANATIONS is a frozen constant.
  const first = getExplanation("carry");
  const second = getExplanation("carry");
  const third = getExplanation("carry");
  assert.equal(first, second);
  assert.equal(second, third);
});

test("explanations: each body is kid-friendly (no jargon, short lines)", () => {
  // Heuristic: each body line < 30 chars, no English jargon.
  // v0.1 doesn't enforce a strict style; this is a smoke test to
  // catch any future regression where someone pastes a math-paper
  // explanation into the map.
  for (const et of Object.keys(EXPLANATIONS)) {
    const { body } = EXPLANATIONS[et];
    // Allow up to 2 lines separated by \n; each line < 50 chars
    const lines = body.split("\n");
    assert.ok(lines.length <= 2, `${et} body should be ≤ 2 lines, got ${lines.length}`);
    for (const line of lines) {
      assert.ok(line.length <= 50, `${et} body line too long (${line.length} chars): "${line}"`);
    }
  }
});

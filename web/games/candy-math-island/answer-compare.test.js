// web/games/candy-math-island/answer-compare.test.js
// =====================================================================
// Tests for `isAnswerCorrect(userInput, correctAnswer)`.
//
// Why this module exists: the picker returns Question objects whose
// `answer` field is `number | string` (regular gen() returns a Number
// like `17`; mistake reviews from /api/game/quiz-context return the
// `correct_answer TEXT` column which is always a String like `"17"`).
// submitAnswer parses the kid's input as a Number, so a strict `===`
// comparison fails on any mistake-review question. This helper is the
// single point that normalises both sides to a Number before compare.
// =====================================================================

import { test } from "node:test";
import assert from "node:assert/strict";
import { isAnswerCorrect } from "./answer-compare.js";

test("isAnswerCorrect: number == number (regular gen path)", () => {
  // Regular pickGenWithBias → gen() returns Number (e.g. 45-28=17).
  assert.equal(isAnswerCorrect("17", 17), true);
  assert.equal(isAnswerCorrect("7", 7), true);
  assert.equal(isAnswerCorrect("100", 100), true);
});

test("isAnswerCorrect: number != number (regular gen path, wrong answer)", () => {
  assert.equal(isAnswerCorrect("18", 17), false);
  assert.equal(isAnswerCorrect("0", 17), false);
});

test("isAnswerCorrect: string answer == numeric input (mistake review path)", () => {
  // /api/game/quiz-context returns answer as TEXT → always String.
  // This is the bug the kid just hit: 45-28=17 marked wrong because
  // strict equality 17 === "17" is false.
  assert.equal(isAnswerCorrect("17", "17"), true);
  assert.equal(isAnswerCorrect("7", "7"), true);
  assert.equal(isAnswerCorrect("100", "100"), true);
});

test("isAnswerCorrect: string answer != different numeric input", () => {
  assert.equal(isAnswerCorrect("18", "17"), false);
  assert.equal(isAnswerCorrect("0", "17"), false);
});

test("isAnswerCorrect: whitespace in user input is trimmed", () => {
  // The kid might hit space on the keypad. We should tolerate
  // surrounding whitespace, matching the .trim() in submitAnswer.
  assert.equal(isAnswerCorrect(" 17 ", 17), true);
  assert.equal(isAnswerCorrect(" 17 ", "17"), true);
});

test("isAnswerCorrect: non-numeric input returns false (not throws)", () => {
  // Garbage input shouldn't crash; submitAnswer pre-validates with
  // parseInt + isNaN, but the helper should still be safe in case
  // it's called from somewhere else.
  assert.equal(isAnswerCorrect("abc", 17), false);
  assert.equal(isAnswerCorrect("", 17), false);
  assert.equal(isAnswerCorrect("1.5", 1.5), true); // floats OK if both sides parse
});

test("isAnswerCorrect: leading zeros are accepted (kid types 007)", () => {
  // Common kid input: leading zero. parseInt("007", 10) === 7.
  assert.equal(isAnswerCorrect("007", 7), true);
  assert.equal(isAnswerCorrect("007", "7"), true);
});

test("isAnswerCorrect: negative numbers (subtraction can yield negative)", () => {
  // e.g. 5 - 12 = -7. The kid types "-7".
  assert.equal(isAnswerCorrect("-7", -7), true);
  assert.equal(isAnswerCorrect("-7", "-7"), true);
  assert.equal(isAnswerCorrect("7", -7), false);
});

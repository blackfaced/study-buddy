// web/shared/numpad.test.js
//
// Tests for the shared number-pad logic (issue #233). Run:
//   node web/shared/numpad.test.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { expectedAnswerLength, shouldAutoSubmit, appendDigit, backspace } from "./numpad.js";

test("expectedAnswerLength: non-negative integers give their digit count", () => {
  assert.equal(expectedAnswerLength(5), 1);
  assert.equal(expectedAnswerLength(0), 1);
  assert.equal(expectedAnswerLength(56), 2);
  assert.equal(expectedAnswerLength(81), 2);
  // mistake-review questions carry correct_answer as TEXT
  assert.equal(expectedAnswerLength("56"), 2);
});

test("expectedAnswerLength: non-integer / negative / garbage answers → null (manual ✓ fallback)", () => {
  assert.equal(expectedAnswerLength(-3), null);
  assert.equal(expectedAnswerLength(3.5), null);
  assert.equal(expectedAnswerLength("abc"), null);
  assert.equal(expectedAnswerLength("3.5"), null);
  assert.equal(expectedAnswerLength(""), null);
  assert.equal(expectedAnswerLength(null), null);
});

test("real scenario: 7×8=56 — first digit does not submit, second digit does", () => {
  let value = "";
  value = appendDigit(value, "5", expectedAnswerLength(56));
  assert.equal(shouldAutoSubmit(value, 56), false);
  value = appendDigit(value, "6", expectedAnswerLength(56));
  assert.equal(value, "56");
  assert.equal(shouldAutoSubmit(value, 56), true);
});

test("appendDigit caps at the expected length so overshoot cannot happen", () => {
  const max = expectedAnswerLength(56);
  let value = appendDigit("", "5", max);
  value = appendDigit(value, "6", max);
  assert.equal(appendDigit(value, "7", max), "56");
});

test("shouldAutoSubmit never fires for non-numeric answers (candy review fallback)", () => {
  assert.equal(shouldAutoSubmit("12", "abc"), false);
  assert.equal(shouldAutoSubmit("1234", "abc"), false);
});

test("shouldAutoSubmit rejects partial and non-digit values", () => {
  assert.equal(shouldAutoSubmit("", 56), false);
  assert.equal(shouldAutoSubmit("5", 56), false);
  assert.equal(shouldAutoSubmit("5a", 56), false);
});

test("backspace drops the last digit", () => {
  assert.equal(backspace("56"), "5");
  assert.equal(backspace("5"), "");
  assert.equal(backspace(""), "");
});

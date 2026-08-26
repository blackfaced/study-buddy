// server/src/hypothesis-validate.test.ts
//
// T06-2: validateHypothesis is a pure helper. Trims input, flags
// sensitive matches against a small allowlist of obvious patterns.
// Anything not in the allowlist returns sensitive=false.

import { describe, it, expect } from "vitest";
import { validateHypothesis } from "./hypothesis-validate.js";

describe("validateHypothesis (T06 PR-C)", () => {
  it("T06-2a: detects 笨蛋 (insult) → sensitive=true", () => {
    const r = validateHypothesis("孩子是笨蛋");
    expect(r.sensitive).toBe(true);
  });

  it("T06-2b: detects 小屁孩 (insult) → sensitive=true", () => {
    expect(validateHypothesis("这小屁孩不专心").sensitive).toBe(true);
  });

  it("T06-2c: detects 身份证 (privacy) → sensitive=true", () => {
    expect(validateHypothesis("身份证号丢了").sensitive).toBe(true);
  });

  it("T06-2d: detects 'password:' (privacy) → sensitive=true", () => {
    expect(validateHypothesis("password: hunter2").sensitive).toBe(true);
  });

  it("T06-2e: normal error-cause text → sensitive=false", () => {
    const r = validateHypothesis("进位的时候忘了加 1");
    expect(r.sensitive).toBe(false);
  });

  it("T06-2f: pure description (compute error) → sensitive=false", () => {
    const r = validateHypothesis("计算粗心 — 7+5 写成了 11");
    expect(r.sensitive).toBe(false);
  });

  it("T06-2g: returns trimmed text", () => {
    expect(validateHypothesis("  粗心  ").text).toBe("粗心");
  });
});

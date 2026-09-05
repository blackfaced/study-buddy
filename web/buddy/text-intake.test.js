// web/buddy/text-intake.test.js
//
// Tests for the photo-only-mode text intake (✍️ 文字描述) merged into the
// buddy page: the parent types a messy description, the server organizes
// it via LLM, and a preview card lets the parent edit the 5 fields before
// 确认录入 POSTs to /api/capture/manual. The module's pure helpers
// (normalize / validate / request-body / inbox rendering) are tested here
// via vm; DOM wiring is covered by e2e/ipad-smoke.test.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import vm from "node:vm";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "text-intake.js"), "utf8");

function loadModule() {
  const window = {};
  vm.runInNewContext(source, vm.createContext({ window }));
  return window.BuddyTextIntake;
}

test("normalizeOrganized fills fields the LLM left out with empty strings", () => {
  const TI = loadModule();
  // The returned object lives in the vm realm — compare via JSON, not
  // deepEqual (realm Object.prototype mismatch).
  assert.deepEqual(JSON.parse(JSON.stringify(TI.normalizeOrganized({ problem: "8+5=?", subject: "math" }))), {
    problem: "8+5=?",
    userAnswer: "",
    correctAnswer: "",
    subject: "math",
    errorType: "",
  });
});

test("normalizeOrganized coerces non-string fields and drops unknown subjects", () => {
  const TI = loadModule();
  const out = TI.normalizeOrganized({ problem: 42, userAnswer: null, subject: "science", errorType: {} });
  assert.equal(out.problem, "42");
  assert.equal(out.userAnswer, "");
  assert.equal(out.subject, "");
  assert.equal(out.errorType, "");
});

test("normalizeOrganized keeps the three valid subjects", () => {
  const TI = loadModule();
  for (const s of ["math", "chinese", "english"]) {
    assert.equal(TI.normalizeOrganized({ subject: s }).subject, s);
  }
});

test("buildManualBody maps an empty errorType to null (server contract: optional field)", () => {
  const TI = loadModule();
  const body = TI.buildManualBody({
    problem: " 8+5=? ",
    userAnswer: "12",
    correctAnswer: "13",
    subject: "math",
    errorType: "  ",
  });
  // JSON round-trip: the vm realm's Object.prototype breaks deepEqual.
  assert.deepEqual(JSON.parse(JSON.stringify(body)), {
    problem: "8+5=?",
    userAnswer: "12",
    correctAnswer: "13",
    subject: "math",
    errorType: null,
  });
});

test("validateFields requires problem/userAnswer/correctAnswer/subject, errorType optional", () => {
  const TI = loadModule();
  const base = { problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "math", errorType: "" };
  assert.equal(TI.validateFields(base), null);
  for (const key of ["problem", "userAnswer", "correctAnswer", "subject"]) {
    const broken = { ...base, [key]: "  " };
    const err = TI.validateFields(broken);
    assert.ok(err, `${key} empty should fail validation`);
  }
  // errorType stays optional
  assert.equal(TI.validateFields({ ...base, errorType: "" }), null);
});

test("real user scenario: inbox entry from GET /api/capture/inbox renders a tappable 订正 link", () => {
  const TI = loadModule();
  // Exact shape returned by GET /api/capture/inbox (routes/capture.ts).
  const entry = {
    caseId: "case:abc",
    mistakeId: 7,
    problem: "8+5=?",
    userAnswer: "12",
    correctAnswer: "13",
    errorType: "进位加法错误",
    source: "manual",
    subject: "math",
    status: "open",
    openedAt: 1757000000000,
  };
  const html = TI.renderInboxEntry(entry);
  assert.ok(html.includes("8+5=?"));
  assert.ok(html.includes("数学"), "subject label should be 数学");
  assert.ok(html.includes("/review/?caseId=case%3Aabc"), "entry links to the review workspace");
});

test("renderInboxEntry escapes HTML in the problem text", () => {
  const TI = loadModule();
  const html = TI.renderInboxEntry({ caseId: "case:x", problem: "<script>alert(1)</script>", subject: "math" });
  assert.ok(!html.includes("<script>alert"));
  assert.ok(html.includes("&lt;script&gt;"));
});

test("renderInboxEntry renders 未分科 when subject is missing", () => {
  const TI = loadModule();
  const html = TI.renderInboxEntry({ caseId: "case:x", problem: "1+1", subject: null });
  assert.ok(html.includes("未分科"));
});

test("emptyInboxCopy is a non-empty Chinese hint", () => {
  const TI = loadModule();
  assert.ok(TI.emptyInboxCopy().length > 0);
});

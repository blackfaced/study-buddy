// server/src/mistake-photo-workflow.test.ts
//
// Tests for the MistakePhotoWorkflow's confidence signal propagation
// and the multi-item draft store (items / reviseItem / markConfirmed).
// The draft response should expose `confidence: "ok" | "low"` so the
// client can render a "重拍或手改" affordance when the vision model
// returned no usable items, and an `items` array with one entry per
// wrong spot for the parent to confirm or revise one by one.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MistakePhotoWorkflow } from "./mistake-photo-workflow.js";
import type { MistakeItem } from "./vision.js";

const TWO_ITEMS: MistakeItem[] = [
  { problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "math", errorType: "进位", reasoning: "r1" },
  { problem: "抄写「已」", userAnswer: "己", correctAnswer: "已", subject: "chinese", errorType: "形近字", reasoning: "r2" },
];

let rootDir: string;
let workflow: MistakePhotoWorkflow;

beforeEach(() => {
  rootDir = mkdtempSync(join(tmpdir(), "study-buddy-workflow-test-"));
  workflow = new MistakePhotoWorkflow({ rootDir });
});

async function analyzeOnce(content: string, confidence?: "ok" | "low") {
  return await workflow.analyze({
    id: "draft_1",
    sessionId: "sess_1",
    childId: "default",
    deviceId: "dev_1",
    bytes: Buffer.from("fake-jpeg"),
    extension: "jpg",
    analyze: async () => ({ problemText: content, model: "MiniMax-M3", confidence }),
  });
}

describe("MistakePhotoWorkflow confidence propagation", () => {
  it("stores 'ok' when the analyzer returns a normal problem with confidence 'ok'", async () => {
    const draft = await analyzeOnce("1 + 1 = ?", "ok");
    expect(draft.proposedProblem).toBe("1 + 1 = ?");
    expect(draft.confidence).toBe("ok");
  });

  it("stores 'low' when the analyzer returns '无法识别' with confidence 'low'", async () => {
    const draft = await analyzeOnce("无法识别", "low");
    expect(draft.proposedProblem).toBe("无法识别");
    expect(draft.confidence).toBe("low");
  });

  it("defaults to 'ok' when the analyzer doesn't supply a confidence field", async () => {
    // Backward compat with test fakes that only return { problemText, model }.
    const draft = await analyzeOnce("1 + 1 = ?");
    expect(draft.confidence).toBe("ok");
  });

  it("preserves the analyzer's confidence even when problemText is empty", async () => {
    const draft = await analyzeOnce("", "low");
    expect(draft.proposedProblem).toBe("");
    expect(draft.confidence).toBe("low");
  });
});

describe("MistakePhotoWorkflow items", () => {
  async function analyzeWithItems(items: MistakeItem[]) {
    return await workflow.analyze({
      id: "draft_items",
      sessionId: "sess_1",
      childId: "default",
      deviceId: "dev_1",
      bytes: Buffer.from("fake-jpeg"),
      extension: "jpg",
      analyze: async () => ({
        problemText: items[0]?.problem ?? "",
        model: "MiniMax-M3",
        confidence: items.length > 0 ? "ok" as const : "low" as const,
        items,
      }),
    });
  }

  it("stores the analyzer's item list on the draft", async () => {
    const draft = await analyzeWithItems(TWO_ITEMS);
    expect(draft.items).toEqual(TWO_ITEMS);
    expect(draft.confirmedIndexes).toEqual([]);
  });

  it("derives a single item from problemText for legacy analyzers without items", async () => {
    const draft = await analyzeOnce("1 + 1 = ?", "ok");
    expect(draft.items).toEqual([
      { problem: "1 + 1 = ?", userAnswer: "", correctAnswer: "", subject: "", errorType: "", reasoning: "" },
    ]);
  });

  it("reviseItem replaces one item and leaves the others untouched", async () => {
    const draft = await analyzeWithItems(TWO_ITEMS.map((i) => ({ ...i })));
    const revised: MistakeItem = { ...TWO_ITEMS[0], subject: "chinese" };
    const result = await workflow.reviseItem("draft_items", 0, async () => revised);
    expect(result).toEqual(revised);
    expect(draft.items[0]).toEqual(revised);
    expect(draft.items[1]).toEqual(TWO_ITEMS[1]);
  });

  it("reviseItem returns null for an unknown draft or out-of-range index", async () => {
    await analyzeWithItems(TWO_ITEMS);
    expect(await workflow.reviseItem("draft_nope", 0, async () => TWO_ITEMS[0])).toBeNull();
    expect(await workflow.reviseItem("draft_items", 5, async () => TWO_ITEMS[0])).toBeNull();
  });

  it("markConfirmed tracks confirmed item indexes without duplicates", async () => {
    const draft = await analyzeWithItems(TWO_ITEMS);
    workflow.markConfirmed("draft_items", 0);
    workflow.markConfirmed("draft_items", 0);
    workflow.markConfirmed("draft_items", 1);
    expect(draft.confirmedIndexes).toEqual([0, 1]);
  });
});

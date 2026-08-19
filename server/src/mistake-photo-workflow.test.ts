// server/src/mistake-photo-workflow.test.ts
//
// Tests for the MistakePhotoWorkflow's confidence signal propagation.
// The draft response should expose `confidence: "ok" | "low"` so the
// client can render a "重拍或手改" affordance when the vision model
// returned "无法识别", an empty string, or a very short problem.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MistakePhotoWorkflow } from "./mistake-photo-workflow.js";

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

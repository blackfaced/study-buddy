// server/src/vision-page.test.ts
//
// Tests for the page-layout VLM prompt + parser (SB124-T04 #128).
// Page-photo mode lets a parent take ONE photo of a homework page
// and extract N candidate mistakes (each with a bounding box).
// This file covers the pure-function pieces — the prompt builder
// and the response parser. Network calls (analyzeMistakeImage on
// each cropped region) are tested separately in the workflow test.
//
// Strategy B: layout analysis first, then per-region OCR.

import { describe, it, expect } from "vitest";
import {
  buildPageLayoutPrompt,
  parsePageLayoutResponse,
  evaluateLayoutConfidence,
  analyzePageLayout,
  type LayoutRegion,
  type VisionClient,
} from "./vision-page.js";

describe("buildPageLayoutPrompt", () => {
  it("returns system + user prompts (no model invocation here)", () => {
    const prompts = buildPageLayoutPrompt();
    expect(prompts.system).toMatch(/版面|题目|区域/);
    expect(prompts.user).toBeTruthy();
  });
});

describe("parsePageLayoutResponse", () => {
  it("parses a clean JSON array of regions", () => {
    const content = JSON.stringify([
      { index: 1, bbox: [0.05, 0.10, 0.95, 0.20], subject: "math" },
      { index: 2, bbox: [0.05, 0.30, 0.95, 0.40], subject: "math" },
    ]);
    const result = parsePageLayoutResponse(content);
    expect(result.regions).toEqual([
      { index: 1, bbox: [0.05, 0.10, 0.95, 0.20], subject: "math" },
      { index: 2, bbox: [0.05, 0.30, 0.95, 0.40], subject: "math" },
    ]);
    expect(result.confidence).toBe("ok");
  });

  it("accepts JSON wrapped in a markdown code block", () => {
    const content = "```json\n" + JSON.stringify([
      { index: 1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "chinese" },
    ]) + "\n```";
    const result = parsePageLayoutResponse(content);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].subject).toBe("chinese");
  });

  it("returns empty array + low confidence on empty / '无法识别' input", () => {
    expect(parsePageLayoutResponse("").regions).toEqual([]);
    expect(parsePageLayoutResponse("无法识别").regions).toEqual([]);
    expect(parsePageLayoutResponse("无法识别").confidence).toBe("low");
    expect(parsePageLayoutResponse("   ").regions).toEqual([]);
    expect(parsePageLayoutResponse("   ").confidence).toBe("low");
  });

  it("returns empty array + low confidence on malformed JSON", () => {
    const result = parsePageLayoutResponse("not json at all { broken");
    expect(result.regions).toEqual([]);
    expect(result.confidence).toBe("low");
  });

  it("returns empty array when the JSON is not an array", () => {
    const result = parsePageLayoutResponse(JSON.stringify({ not: "an array" }));
    expect(result.regions).toEqual([]);
  });

  it("filters out regions with out-of-range bbox (must be 0-1)", () => {
    const content = JSON.stringify([
      { index: 1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
      { index: 2, bbox: [-0.1, 0.1, 0.9, 0.2], subject: "math" }, // x1 < 0
      { index: 3, bbox: [0.1, 0.1, 1.1, 0.2], subject: "math" }, // x2 > 1
      { index: 4, bbox: [0.5, 0.5, 0.3, 0.3], subject: "math" }, // x2 < x1
    ]);
    const result = parsePageLayoutResponse(content);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].index).toBe(1);
  });

  it("filters out regions with non-positive or non-integer index", () => {
    const content = JSON.stringify([
      { index: 0, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
      { index: -1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
      { index: 1.5, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
      { index: "1", bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
      { index: 2, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
    ]);
    const result = parsePageLayoutResponse(content);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].index).toBe(2);
  });

  it("filters out regions with unknown subject (defaults to 'other' on a known value)", () => {
    const content = JSON.stringify([
      { index: 1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
      { index: 2, bbox: [0.1, 0.1, 0.9, 0.2], subject: "made-up-subject" },
      { index: 3, bbox: [0.1, 0.1, 0.9, 0.2] }, // missing subject
    ]);
    const result = parsePageLayoutResponse(content);
    expect(result.regions).toHaveLength(1);
    expect(result.regions[0].subject).toBe("math");
  });

  it("sorts regions by index (model may emit out of order)", () => {
    const content = JSON.stringify([
      { index: 3, bbox: [0.1, 0.5, 0.9, 0.6], subject: "math" },
      { index: 1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
      { index: 2, bbox: [0.1, 0.3, 0.9, 0.4], subject: "math" },
    ]);
    const result = parsePageLayoutResponse(content);
    expect(result.regions.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  it("low confidence when ALL regions have no subject (rejects unparseable page)", () => {
    const content = JSON.stringify([
      { index: 1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "weird" },
    ]);
    const result = parsePageLayoutResponse(content);
    expect(result.regions).toEqual([]);
    expect(result.confidence).toBe("low");
  });
});

describe("evaluateLayoutConfidence", () => {
  it("returns 'low' when regions is empty", () => {
    expect(evaluateLayoutConfidence([])).toBe("low");
  });

  it("returns 'ok' when there is at least one region", () => {
    const regions: LayoutRegion[] = [
      { index: 1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
    ];
    expect(evaluateLayoutConfidence(regions)).toBe("ok");
  });
});

describe("analyzePageLayout", () => {
  it("sends the system + user prompt + image to the client", async () => {
    let captured: { system: string; user: string; imageBase64: string } | null = null;
    const client: VisionClient = {
      async chat(params) {
        captured = params;
        return { content: "[]", raw: { id: "test" } };
      },
    };
    await analyzePageLayout(client, "BASE64DATA");
    expect(captured).not.toBeNull();
    expect(captured!.system).toContain("版面");
    expect(captured!.user.length).toBeLessThan(80);
    expect(captured!.imageBase64).toBe("BASE64DATA");
  });

  it("returns parsed regions + model + raw from the client", async () => {
    const client: VisionClient = {
      async chat() {
        return {
          content: JSON.stringify([
            { index: 1, bbox: [0.1, 0.1, 0.9, 0.2], subject: "math" },
          ]),
          raw: { id: "resp-1" },
        };
      },
    };
    const result = await analyzePageLayout(client, "BASE64");
    expect(result.regions).toHaveLength(1);
    expect(result.confidence).toBe("ok");
    expect(result.model).toBe("MiniMax-M3");
    expect(result.raw).toEqual({ id: "resp-1" });
  });

  it("returns empty regions + low confidence on '无法识别'", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "无法识别", raw: null };
      },
    };
    const result = await analyzePageLayout(client, "BASE64");
    expect(result.regions).toEqual([]);
    expect(result.confidence).toBe("low");
  });
});

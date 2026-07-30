// server/src/extract-chars.test.ts
//
// Unit tests for the chars-extract vision helper. TDD scaffold for
// issue #57 v0.2. Mirrors the pattern from vision.test.ts:
// buildCharsPrompt() + parseCharsResponse() + extractCharsImage().
//
// The chars prompt is intentionally different from the mistake prompt:
// - Output is a flat, deduplicated list of CJK characters
// - We don't need reasoning, just enumeration
// - The agent + user confirm the list before commit
import { describe, expect, it } from "vitest";
import {
  buildCharsPrompt,
  parseCharsResponse,
  extractCharsImage,
  type VisionClient,
} from "./vision.js";

describe("buildCharsPrompt", () => {
  it("system prompt asks for a flat CJK list (no reasoning needed)", () => {
    const { system } = buildCharsPrompt();
    expect(system).toMatch(/汉字|字符|CJK/);
    // No problem / reasoning scaffolding — chars are simpler.
    expect(system).not.toMatch(/思路/);
  });

  it("system prompt asks to skip punctuation, pinyin, numbers, ASCII", () => {
    const { system } = buildCharsPrompt();
    expect(system).toMatch(/标点|拼音|数字|英文/);
  });

  it("system prompt asks to dedupe (each char once)", () => {
    const { system } = buildCharsPrompt();
    expect(system).toMatch(/去重|不重复|每个.*一次/);
  });
});

describe("parseCharsResponse", () => {
  it("extracts a space-separated list of CJK chars", () => {
    const r = parseCharsResponse("永 泳 远 处");
    expect(r).toEqual(["永", "泳", "远", "处"]);
  });

  it("deduplicates within the response", () => {
    const r = parseCharsResponse("永 泳 永 远 永 处");
    expect(r).toEqual(["永", "泳", "远", "处"]);
  });

  it("strips punctuation, pinyin, digits, ASCII, whitespace", () => {
    const r = parseCharsResponse("永 (yǒng) 泳 1 远  ?  处 ");
    expect(r).toEqual(["永", "泳", "远", "处"]);
  });

  it("returns empty array for empty / whitespace-only response", () => {
    expect(parseCharsResponse("")).toEqual([]);
    expect(parseCharsResponse("   ")).toEqual([]);
  });

  it("returns empty array for non-CJK-only response", () => {
    expect(parseCharsResponse("hello 123 !@#")).toEqual([]);
  });

  it("preserves the order from the response (insertion order)", () => {
    const r = parseCharsResponse("三 一 二");
    expect(r).toEqual(["三", "一", "二"]);
  });
});

describe("extractCharsImage", () => {
  it("calls the vision client with system+user+imageBase64 and returns parsed words", async () => {
    let captured: any = null;
    const client: VisionClient = {
      async chat(params) {
        captured = params;
        return { content: "永 泳 远 处", raw: { stub: true } };
      },
    };
    const result = await extractCharsImage(client, "BASE64DATA");
    expect(captured).toMatchObject({
      imageBase64: "BASE64DATA",
    });
    expect(captured.system).toBeTruthy();
    expect(captured.user).toBeTruthy();
    expect(result).toEqual({
      words: ["永", "泳", "远", "处"],
      raw: { stub: true },
    });
  });

  it("returns empty words array when vision returns no CJK", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "hello 123", raw: {} };
      },
    };
    const result = await extractCharsImage(client, "BASE64");
    expect(result.words).toEqual([]);
  });
});

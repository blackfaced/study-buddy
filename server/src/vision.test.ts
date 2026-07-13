import { describe, expect, it } from "vitest";
import {
  buildMistakePrompt,
  parseVisionResponse,
  analyzeMistakeImage,
  type VisionClient,
} from "./vision.js";

describe("buildMistakePrompt", () => {
  it("system prompt forbids giving the final answer", () => {
    const { system } = buildMistakePrompt();
    expect(system).toMatch(/不要给.*答案/);
    expect(system).toMatch(/不要给.*最终答案|不要给.*答案/);
  });

  it("system prompt targets 8-year-olds (matches existing system_prompt tone)", () => {
    const { system } = buildMistakePrompt();
    expect(system).toMatch(/8\s*岁|二年级/);
  });

  it("system prompt requires structured output (题目 / 思路)", () => {
    const { system } = buildMistakePrompt();
    expect(system).toContain("题目");
    expect(system).toContain("思路");
  });

  it("system prompt tells the model to admit blurry / non-problem images", () => {
    const { system } = buildMistakePrompt();
    expect(system).toMatch(/无法识别|看不清|模糊/);
  });

  it("user prompt is a short instruction (image data goes through the API channel, not the prompt)", () => {
    const { user } = buildMistakePrompt();
    expect(user.length).toBeLessThan(50);
  });
});

describe("parseVisionResponse", () => {
  it("extracts problemText and reasoning from a well-formed response", () => {
    const content = "题目：1 + 1 = ?\n思路：把两个手指头加起来";
    expect(parseVisionResponse(content)).toEqual({
      problemText: "1 + 1 = ?",
      reasoning: "把两个手指头加起来",
    });
  });

  it("handles multi-line problem text", () => {
    const content = "题目：小明有 3 个苹果\n妈妈又给他 2 个\n他一共有多少个？\n思路：把两次的数量加起来";
    const { problemText, reasoning } = parseVisionResponse(content);
    expect(problemText).toContain("小明有 3 个苹果");
    expect(problemText).toContain("妈妈又给他 2 个");
    expect(reasoning).toBe("把两次的数量加起来");
  });

  it("handles multi-line reasoning", () => {
    const content = "题目：钟表问题\n思路：先看时针\n再看分针\n最后算差";
    const { problemText, reasoning } = parseVisionResponse(content);
    expect(problemText).toBe("钟表问题");
    expect(reasoning).toBe("先看时针\n再看分针\n最后算差");
  });

  it("returns '无法识别' as problemText and empty reasoning when model gives up", () => {
    const content = "无法识别";
    expect(parseVisionResponse(content)).toEqual({
      problemText: "无法识别",
      reasoning: "",
    });
  });

  it("trims whitespace from both fields", () => {
    const content = "  题目：  1+1   \n思路：   数一数   ";
    expect(parseVisionResponse(content)).toEqual({
      problemText: "1+1",
      reasoning: "数一数",
    });
  });

  it("returns empty fields if response is empty", () => {
    expect(parseVisionResponse("")).toEqual({ problemText: "", reasoning: "" });
  });

  it("returns empty fields if response is missing the 思路: section", () => {
    // defensive: model might forget the structured format
    const content = "题目：1+1";
    expect(parseVisionResponse(content)).toEqual({ problemText: "1+1", reasoning: "" });
  });
});

describe("analyzeMistakeImage", () => {
  it("sends the system + user prompt and image to the client", async () => {
    let captured: { system: string; user: string; imageBase64: string } | null = null;
    const client: VisionClient = {
      async chat(params) {
        captured = params;
        return {
          content: "题目：1+1\n思路：数一数",
          raw: { id: "test" },
        };
      },
    };
    await analyzeMistakeImage(client, "BASE64DATA");
    expect(captured).not.toBeNull();
    expect(captured!.system).toContain("思路");
    expect(captured!.user.length).toBeLessThan(50);
    expect(captured!.imageBase64).toBe("BASE64DATA");
  });

  it("returns a structured MistakeAnalysis with parsed fields + client raw", async () => {
    const client: VisionClient = {
      async chat() {
        return {
          content: "题目：钟表\n思路：先看时针",
          raw: { id: "resp-1" },
        };
      },
    };
    const result = await analyzeMistakeImage(client, "BASE64");
    expect(result.problemText).toBe("钟表");
    expect(result.reasoning).toBe("先看时针");
    expect(result.raw).toEqual({ id: "resp-1" });
  });

  it("preserves model identifier on the result", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "题目：x\n思路：y", raw: {} };
      },
    };
    const result = await analyzeMistakeImage(client, "BASE64", { model: "MiniMax-M3" });
    expect(result.model).toBe("MiniMax-M3");
  });
});

import { describe, expect, it } from "vitest";
import {
  buildMistakePrompt,
  parseVisionResponse,
  analyzeMistakeImage,
  analyzeMistakeItems,
  parseMistakeItems,
  reviseMistakeItem,
  evaluateVisionConfidence,
  type MistakeItem,
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
    let captured: { system: string; user: string; imageBase64?: string } | null = null;
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

  it("marks confidence 'ok' for a well-formed problem text", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "题目：1 + 1 = ?\n思路：加法", raw: {} };
      },
    };
    const result = await analyzeMistakeImage(client, "BASE64");
    expect(result.confidence).toBe("ok");
  });

  it("marks confidence 'low' when the model returns '无法识别'", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "无法识别", raw: {} };
      },
    };
    const result = await analyzeMistakeImage(client, "BASE64");
    expect(result.problemText).toBe("无法识别");
    expect(result.confidence).toBe("low");
  });

  it("marks confidence 'low' when the problemText is empty", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "", raw: {} };
      },
    };
    const result = await analyzeMistakeImage(client, "BASE64");
    expect(result.problemText).toBe("");
    expect(result.confidence).toBe("low");
  });

  it("marks confidence 'low' when the problemText is too short (< 2 codepoints)", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "题目：1\n思路：? ", raw: {} };
      },
    };
    const result = await analyzeMistakeImage(client, "BASE64");
    expect(result.problemText).toBe("1");
    expect(result.confidence).toBe("low");
  });
});

describe("parseMistakeItems", () => {
  it("parses a well-formed reply into one item per mistake", () => {
    const content = JSON.stringify({
      mistakes: [
        {
          problem: "8 + 5 = ?",
          userAnswer: "12",
          correctAnswer: "13",
          subject: "math",
          errorType: "进位加法错误",
          reasoning: "个位相加满十要进一",
        },
        {
          problem: "把「已」抄一遍",
          userAnswer: "己",
          correctAnswer: "已",
          subject: "chinese",
          errorType: "形近字混淆",
          reasoning: "「已」和「己」字形相近",
        },
      ],
    });
    expect(parseMistakeItems(content)).toEqual([
      {
        problem: "8 + 5 = ?",
        userAnswer: "12",
        correctAnswer: "13",
        subject: "math",
        errorType: "进位加法错误",
        reasoning: "个位相加满十要进一",
      },
      {
        problem: "把「已」抄一遍",
        userAnswer: "己",
        correctAnswer: "已",
        subject: "chinese",
        errorType: "形近字混淆",
        reasoning: "「已」和「己」字形相近",
      },
    ]);
  });

  it("strips ```json fences and surrounding prose before parsing", () => {
    const content = "好的，识别结果如下：\n```json\n{\"mistakes\":[{\"problem\":\"3×4=?\",\"userAnswer\":\"13\",\"correctAnswer\":\"12\",\"subject\":\"math\",\"errorType\":\"乘法口诀记错\",\"reasoning\":\"三四十二\"}]}\n```\n以上。";
    const items = parseMistakeItems(content);
    expect(items).toHaveLength(1);
    expect(items[0].problem).toBe("3×4=?");
  });

  it("normalizes Chinese subject aliases (数学 → math, 语文 → chinese)", () => {
    const content = JSON.stringify({
      mistakes: [
        { problem: "a", subject: "数学" },
        { problem: "b", subject: "语文" },
        { problem: "c", subject: "English" },
      ],
    });
    const items = parseMistakeItems(content);
    expect(items.map((i) => i.subject)).toEqual(["math", "chinese", "english"]);
  });

  it("drops unknown subjects and missing fields to empty strings", () => {
    const content = JSON.stringify({
      mistakes: [{ problem: "1+1=?", subject: "物理" }],
    });
    expect(parseMistakeItems(content)).toEqual([
      {
        problem: "1+1=?",
        userAnswer: "",
        correctAnswer: "",
        subject: "",
        errorType: "",
        reasoning: "",
      },
    ]);
  });

  it("returns [] when the reply is not JSON at all", () => {
    expect(parseMistakeItems("完全不是 JSON")).toEqual([]);
    expect(parseMistakeItems("")).toEqual([]);
  });

  it("returns [] when mistakes is not an array and skips non-object entries", () => {
    expect(parseMistakeItems(JSON.stringify({ mistakes: "none" }))).toEqual([]);
    expect(parseMistakeItems(JSON.stringify({ other: 1 }))).toEqual([]);
    const items = parseMistakeItems(
      JSON.stringify({ mistakes: ["junk", { problem: "ok" }] }),
    );
    expect(items).toEqual([
      { problem: "ok", userAnswer: "", correctAnswer: "", subject: "", errorType: "", reasoning: "" },
    ]);
  });
});

describe("analyzeMistakeItems", () => {
  it("sends the photo and returns one parsed item per mistake", async () => {
    let captured: { system: string; user: string; imageBase64?: string } | null = null;
    const client: VisionClient = {
      async chat(params) {
        captured = params;
        return {
          content: JSON.stringify({
            mistakes: [
              { problem: "8+5=?", userAnswer: "12", correctAnswer: "13", subject: "math", errorType: "进位", reasoning: "r1" },
              { problem: "抄写「已」", userAnswer: "己", correctAnswer: "已", subject: "语文", errorType: "形近字", reasoning: "r2" },
            ],
          }),
          raw: { id: "resp" },
        };
      },
    };
    const result = await analyzeMistakeItems(client, "BASE64");
    expect(captured!.imageBase64).toBe("BASE64");
    expect(result.items).toHaveLength(2);
    expect(result.items[1].subject).toBe("chinese");
    expect(result.confidence).toBe("ok");
    expect(result.raw).toEqual({ id: "resp" });
  });

  it("marks confidence 'low' when no mistake item could be parsed", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "看不清这张照片", raw: {} };
      },
    };
    const result = await analyzeMistakeItems(client, "BASE64");
    expect(result.items).toEqual([]);
    expect(result.confidence).toBe("low");
  });
});

describe("reviseMistakeItem", () => {
  const current: MistakeItem = {
    problem: "8+5=?",
    userAnswer: "12",
    correctAnswer: "13",
    subject: "math",
    errorType: "进位加法错误",
    reasoning: "个位满十进一",
  };

  it("sends the current fields + parent instruction and returns the revised item", async () => {
    let captured: { system: string; user: string; imageBase64?: string } | null = null;
    const client: VisionClient = {
      async chat(params) {
        captured = params;
        return {
          content: JSON.stringify({ ...current, subject: "chinese" }),
          raw: {},
        };
      },
    };
    const revised = await reviseMistakeItem(client, current, "学科改成语文");
    expect(revised.subject).toBe("chinese");
    expect(revised.problem).toBe("8+5=?");
    // Text-only call: no image is re-sent; the instruction and current
    // field values must be in the prompt.
    expect(captured!.imageBase64).toBeUndefined();
    expect(captured!.user).toContain("学科改成语文");
    expect(captured!.user).toContain("8+5=?");
  });

  it("throws when the model reply is not parseable JSON", async () => {
    const client: VisionClient = {
      async chat() {
        return { content: "随便聊几句", raw: {} };
      },
    };
    await expect(reviseMistakeItem(client, current, "改学科")).rejects.toThrow();
  });
});

describe("evaluateVisionConfidence", () => {
  it("returns 'low' for empty text", () => {
    expect(evaluateVisionConfidence("")).toBe("low");
  });

  it("returns 'low' for the '无法识别' surrender token", () => {
    expect(evaluateVisionConfidence("无法识别")).toBe("low");
  });

  it("returns 'low' for text containing only whitespace", () => {
    expect(evaluateVisionConfidence("   ")).toBe("low");
  });

  it("returns 'low' for very short text (< 2 codepoints after trim)", () => {
    expect(evaluateVisionConfidence("1")).toBe("low");
    // "ab" is 2 codepoints, accepted as a real (if unlikely) problem
    expect(evaluateVisionConfidence("ab")).toBe("ok");
  });

  it("returns 'ok' for normal-length problem text", () => {
    expect(evaluateVisionConfidence("1 + 1 = ?")).toBe("ok");
    expect(evaluateVisionConfidence("汉字")).toBe("ok");
  });
});

import { describe, expect, it } from "vitest";
import { reviewHandwritingImage } from "./handwriting-review.js";

describe("reviewHandwritingImage", () => {
  it("asks only for a short structure suggestion and preserves the local hard verdict", async () => {
    const prompts: Array<{
      system: string;
      user: string;
      imageBase64: string;
    }> = [];
    const client = {
      async chat(input: { system: string; user: string; imageBase64: string }) {
        prompts.push(input);
        return { content: "左右两边再靠近一点。", raw: { ok: true } };
      },
    };
    const localAssessment = {
      band: "基本正确",
      breakdown: {
        structure: 0.6,
        placement: 0.8,
        strokeQuality: 0.9,
        shape: 0.7,
      },
      reasons: [{ code: "stroke_order_wrong", message: "笔顺改对了" }],
    };

    const result = await reviewHandwritingImage(
      client,
      "abc123",
      localAssessment,
    );

    expect(result).toMatchObject({
      status: "completed",
      suggestion: "左右两边再靠近一点。",
      model: "MiniMax-M3",
    });
    expect(prompts[0].imageBase64).toBe("abc123");
    expect(prompts[0].system).toContain("不得评价或改写笔顺");
    expect(prompts[0].user).not.toContain("孩子");
  });

  it("drops model text that tries to override local stroke-order rules", async () => {
    const client = {
      async chat() {
        return { content: "笔顺写错了，应该先写竖。", raw: {} };
      },
    };

    const result = await reviewHandwritingImage(client, "abc123", {
      breakdown: { structure: 0.6 },
    });

    expect(result.suggestion).toBe("结构暂时无法复评");
  });
});

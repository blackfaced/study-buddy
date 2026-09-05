// server/src/answer-judge.test.ts
//
// Tests for the LLM answer judge (issue #229). Vision-sourced mistake
// cases have no stored correct_answer (confirmMistakePhotoDraft writes
// ""), so the exact-text answersMatch comparator can never pass and the
// correction obligation could never close. When correct_answer is empty,
// the review attempt route falls back to asking the LLM to judge the
// kid's answer against the problem text.
//
// Seam (pure, directly unit-tested):
//   - buildJudgePrompt(problem, answer) → { system, user }
//   - parseJudgeResponse(content) → true | false | null (null = can't tell)
//   - judgeAnswer(client, problem, answer) → Promise<boolean | null>

import { describe, it, expect } from "vitest";
import {
  buildJudgePrompt,
  parseJudgeResponse,
  judgeAnswer,
} from "./answer-judge.js";
import type { VisionClient } from "./vision.js";

describe("buildJudgePrompt", () => {
  it("embeds the problem and the kid's answer", () => {
    const { system, user } = buildJudgePrompt("1+1=？", "2");
    expect(user).toContain("1+1=？");
    expect(user).toContain("2");
    // The judge must be a classifier, not a coach: strict output contract.
    expect(system).toContain("判定");
  });

  it("the actual #229 scenario: animal vertical puzzle with a multi-part answer", () => {
    const problem = "2🐰 + 🐰🐼 = 62，🐰=？🐼=？";
    const answer = "小兔子 3 小熊猫 9";
    const { user } = buildJudgePrompt(problem, answer);
    expect(user).toContain(problem);
    expect(user).toContain(answer);
  });
});

describe("parseJudgeResponse", () => {
  it("正确 → true", () => {
    expect(parseJudgeResponse("判定：正确")).toBe(true);
  });

  it("错误 → false", () => {
    expect(parseJudgeResponse("判定：错误")).toBe(false);
  });

  it("tolerates surrounding explanation and full-width/half-width colons", () => {
    expect(parseJudgeResponse("我来算一下……23+39=62。\n判定: 正确")).toBe(true);
    expect(parseJudgeResponse("判定：错误\n兔子和熊猫的和不对。")).toBe(false);
  });

  it("unparseable / refusal / empty → null (never guesses)", () => {
    expect(parseJudgeResponse("")).toBe(null);
    expect(parseJudgeResponse("无法判断")).toBe(null);
    expect(parseJudgeResponse("这道题出得不太好")).toBe(null);
  });

  it("判定：无法判断 (the canonical third verdict) → null", () => {
    expect(parseJudgeResponse("判定：无法判断")).toBe(null);
  });

  it("contradictory markers → null (first marker wins would hide model confusion)", () => {
    expect(parseJudgeResponse("判定：正确\n等等，判定：错误")).toBe(null);
  });
});

describe("judgeAnswer", () => {
  function fakeClient(content: string): VisionClient {
    return {
      async chat() {
        return { content, raw: null };
      },
    };
  }

  it("returns true/false/null straight from parseJudgeResponse", async () => {
    await expect(judgeAnswer(fakeClient("判定：正确"), "p", "a")).resolves.toBe(true);
    await expect(judgeAnswer(fakeClient("判定：错误"), "p", "a")).resolves.toBe(false);
    await expect(judgeAnswer(fakeClient("???"), "p", "a")).resolves.toBe(null);
  });
});

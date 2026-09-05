// server/src/answer-judge.ts
//
// LLM answer judge for correction attempts on cases with no stored
// correct_answer (issue #229). Vision-sourced mistake cases are
// inserted with correct_answer="" (confirmMistakePhotoDraft), so the
// exact-text answersMatch comparator can never pass and the correction
// obligation could never close — a correct kid correction was always
// judged wrong. When the case has no canonical answer, the review
// attempt route calls judgeAnswer() instead of answersMatch().
//
// Seam mirrors vision.ts: two pure functions (buildJudgePrompt /
// parseJudgeResponse) plus one impure wiring function (judgeAnswer).

import type { VisionClient } from "./vision.js";

const JUDGE_SYSTEM_PROMPT = `你是一位小学数学老师，负责判断孩子的订正答案是否答对了题目。

规则：
- 自己先把题算对，再和孩子的答案核对
- 孩子答案的表述形式可以和标准答案不同（语序、空格、单位、文字描述），只要数值和含义正确就算对
- 题目本身缺条件、无法确定答案时，判"无法判断"

输出格式（严格遵守，只输出一行）：
判定：正确 / 判定：错误 / 判定：无法判断`;

export function buildJudgePrompt(
  problem: string,
  answer: string,
): { system: string; user: string } {
  return {
    system: JUDGE_SYSTEM_PROMPT,
    user: `题目：\n${problem}\n\n孩子的订正答案：\n${answer}`,
  };
}

/**
 * Parse the model's one-line verdict. Returns null when the model
 * refused, produced garbage, or contradicted itself — the caller must
 * treat null as "not proven correct", never as correct.
 */
export function parseJudgeResponse(content: string): boolean | null {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return null;
  // Colon may be full-width or half-width, with optional spaces.
  const matches = [...trimmed.matchAll(/判定\s*[:：]\s*(正确|错误|无法判断)/g)];
  if (matches.length !== 1) return null;
  const verdict = matches[0][1];
  if (verdict === "正确") return true;
  if (verdict === "错误") return false;
  return null;
}

/**
 * Ask the LLM whether the kid's answer solves the problem.
 * Text-only chat (no image) — the problem text is already in the case.
 */
export async function judgeAnswer(
  client: VisionClient,
  problem: string,
  answer: string,
): Promise<boolean | null> {
  const { system, user } = buildJudgePrompt(problem, answer);
  const { content } = await client.chat({ system, user });
  return parseJudgeResponse(content);
}

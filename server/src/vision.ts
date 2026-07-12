// src/vision.ts
//
// v0.5: vision client for analyzing mistake photos. Wraps the MiniMax M3
// /v1/vl/chat/completions endpoint behind a small interface so the rest of
// the server (and tests) can talk to it without depending on the live API.
//
// Two pure functions, both directly tested:
//   - buildMistakePrompt()   : the system + user prompts we send
//   - parseVisionResponse()  : extract (problemText, reasoning) from the
//                              model's structured reply
//
// Plus one impure function that wires them together:
//   - analyzeMistakeImage()  : takes a VisionClient + base64 image, returns
//                              a structured MistakeAnalysis.

export interface VisionClient {
  /**
   * Send a vision chat request. `imageBase64` is the raw base64 of the image
   * (no data: prefix). Returns the assistant's content + the raw response
   * for logging / debugging.
   */
  chat(params: {
    system: string;
    user: string;
    imageBase64: string;
  }): Promise<{ content: string; raw: unknown }>;
}

export interface MistakeAnalysis {
  problemText: string;
  reasoning: string;
  model: string;
  raw: unknown;
}

const MISTAKE_SYSTEM_PROMPT = `你是一个陪伴小学二年级孩子写作业的学习助手"小书童"。

你正在看孩子用相机拍的一道错题图片。你的任务分两步：

第一步（读题）：把图片里的题目原文抄出来。如果图片模糊 / 不是题目 / 看不清，回复"无法识别"。

第二步（讲思路）：用 2-3 句话给孩子讲思路。规则：
- **绝对不要给最终答案**，只讲思路
- 用 8 岁孩子能听懂的话
- 提到关键步骤时用问句（比如"你想想，这一步要算什么？"）
- 如果题目需要公式或计算，让孩子在草稿纸上自己算，你只讲思路
- 永远不要假装看清了模糊的图片

输出格式（严格遵守）：
题目：[抄出来的题目]
思路：[你的思路]`;

export function buildMistakePrompt(): { system: string; user: string } {
  return {
    system: MISTAKE_SYSTEM_PROMPT,
    user: "请看这张图片。",
  };
}

/**
 * Parse the model's structured reply. Tolerant of:
 *   - leading/trailing whitespace
 *   - multi-line problem text and reasoning
 *   - missing 思路: section (returns empty reasoning)
 *   - "无法识别" (the "I give up" reply)
 *   - empty input
 *
 * Strict in:
 *   - requires "题目：" to start the problem field
 */
export function parseVisionResponse(content: string): { problemText: string; reasoning: string } {
  const trimmed = content.trim();
  if (!trimmed) return { problemText: "", reasoning: "" };

  // Find the 题目: marker. If absent, treat the whole thing as problem text.
  const problemIdx = trimmed.indexOf("题目");
  if (problemIdx < 0) {
    return { problemText: trimmed, reasoning: "" };
  }

  // Find 思路: marker (search after 题目: section)
  const reasoningIdx = trimmed.indexOf("思路");

  if (reasoningIdx < 0) {
    // Only problem section
    const problemPart = trimmed.slice(problemIdx).replace(/^题目[:：]\s*/, "").trim();
    return { problemText: problemPart, reasoning: "" };
  }

  // Both sections present. Slice between them.
  const problemPart = trimmed
    .slice(problemIdx, reasoningIdx)
    .replace(/^题目[:：]\s*/, "")
    .trim();
  const reasoningPart = trimmed
    .slice(reasoningIdx)
    .replace(/^思路[:：]\s*/, "")
    .trim();

  return { problemText: problemPart, reasoning: reasoningPart };
}

export async function analyzeMistakeImage(
  client: VisionClient,
  imageBase64: string,
  options: { model?: string } = {},
): Promise<MistakeAnalysis> {
  const { system, user } = buildMistakePrompt();
  const { content, raw } = await client.chat({ system, user, imageBase64 });
  const { problemText, reasoning } = parseVisionResponse(content);
  return {
    problemText,
    reasoning,
    model: options.model ?? "MiniMax-M3",
    raw,
  };
}

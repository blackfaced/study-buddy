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
    signal?: AbortSignal;
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
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<MistakeAnalysis> {
  const { system, user } = buildMistakePrompt();
  const { content, raw } = await client.chat({ system, user, imageBase64, signal: options.signal });
  const { problemText, reasoning } = parseVisionResponse(content);
  return {
    problemText,
    reasoning,
    model: options.model ?? "MiniMax-M3",
    raw,
  };
}

// v0.7 (issue #57 v0.2): extract individual CJK characters from a photo
// (e.g. a textbook page or a handwritten word list). Different from
// analyzeMistakeImage in that the output is a flat list, no reasoning.
//
// The user (parent) confirms the list with the agent before any of
// these characters are added to the word library — see the
// add-words-from-photo Mavis skill for the confirmation flow.
const CHARS_SYSTEM_PROMPT = `你是一个图片转文字助手。给你一张图片（课本/默写纸/生字表/字帖），请提取图片里所有**独立的单个汉字**。

严格遵守：
- 只输出汉字（CJK 统一汉字 U+4E00–U+9FFF）
- 忽略标点符号、拼音、阿拉伯数字、英文字母、连字符、空格
- 每个字只输出一次（去重），按图片里出现的顺序排列
- 字与字之间用一个空格分隔
- 如果图片里没有汉字，只回一个空字符串

不要加任何解释、前缀或后缀。只回汉字列表。`;

export function buildCharsPrompt(): { system: string; user: string } {
  return {
    system: CHARS_SYSTEM_PROMPT,
    user: "请提取这张图片里的所有汉字。",
  };
}

/**
 * Parse the model's reply into a deduplicated, in-order list of CJK
 * characters. Tolerant of:
 *   - extra whitespace, newlines, commas
 *   - non-CJK characters mixed in (silently dropped)
 *   - duplicate occurrences (first one wins, preserves order)
 */
export function parseCharsResponse(content: string): string[] {
  if (!content) return [];
  // Drop everything that isn't a CJK char, then dedupe while
  // preserving the order in which the model emitted them.
  const seen = new Set<string>();
  const out: string[] = [];
  for (const ch of content) {
    if (!/^[\u4E00-\u9FFF]$/.test(ch)) continue;
    if (seen.has(ch)) continue;
    seen.add(ch);
    out.push(ch);
  }
  return out;
}

export interface CharsExtraction {
  words: string[];
  raw: unknown;
}

export async function extractCharsImage(
  client: VisionClient,
  imageBase64: string,
): Promise<CharsExtraction> {
  const { system, user } = buildCharsPrompt();
  const { content, raw } = await client.chat({ system, user, imageBase64 });
  const words = parseCharsResponse(content);
  return { words, raw };
}

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

import { normalizeSubject } from "./capture-organize.js";

export interface VisionClient {
  /**
   * Send a vision chat request. `imageBase64` is the raw base64 of the image
   * (no data: prefix); omit it for text-only calls (e.g. /api/capture/organize).
   * Returns the assistant's content + the raw response for logging / debugging.
   */
  chat(params: {
    system: string;
    user: string;
    imageBase64?: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; raw: unknown }>;
}

export type VisionConfidence = "ok" | "low";

export interface MistakeAnalysis {
  problemText: string;
  reasoning: string;
  model: string;
  raw: unknown;
  /**
   * Heuristic confidence signal for the client. "low" means the model
   * either returned "无法识别", an empty/very-short problem, or other
   * failure markers — the parent portal should surface a "重拍或手改"
   * affordance. "ok" means a normal problem text was parsed.
   *
   * The threshold is intentionally conservative: better to nudge the
   * parent to double-check than to silently accept garbage.
   */
  confidence: VisionConfidence;
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
    confidence: evaluateVisionConfidence(problemText),
  };
}

/**
 * Heuristic: classify a vision-parsed problem text as "ok" (parent can
 * accept with reasonable confidence) or "low" (parent should retake the
 * photo or type manually). Pure function, unit-tested separately.
 *
 *   empty / whitespace / "无法识别" / shorter than 3 chars after trim
 *   → "low"
 *   anything else
 *   → "ok"
 *
 * Note: this is intentionally permissive on the upper bound — a long
 * "题目: ..." field with surrounding commentary is still "ok" because
 * the parent will see the whole text and can edit. The check is about
 * catching obvious failure modes, not validating accuracy.
 */
export function evaluateVisionConfidence(problemText: string): VisionConfidence {
  const trimmed = (problemText ?? "").trim();
  if (!trimmed) return "low";
  if (trimmed === "无法识别") return "low";
  // Codepoint count (not UTF-16 code-unit count) so a 2-char CJK phrase
  // like "汉字" doesn't trip the "too short" rule. 1-codepoint results
  // are almost always a model error (e.g. "1" from a garbled read).
  if ([...trimmed].length < 2) return "low";
  return "ok";
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

// =====================================================================
// Multi-item mistake photo analysis (拍错题 v2). Unlike
// analyzeMistakeImage above — which stays untouched for the page-photo
// path (ADR-0001) — this path asks the model to split EVERY wrong spot
// on the homework photo into its own structured item, so the parent can
// confirm them one by one instead of hand-editing a single blob.
// =====================================================================

export interface MistakeItem {
  problem: string;
  userAnswer: string;
  correctAnswer: string;
  subject: string;
  errorType: string;
  reasoning: string;
}

const MISTAKE_ITEMS_SYSTEM_PROMPT = `你是错题整理助手。家长拍了一张孩子的作业照片，你要把照片里**每一个错误点**拆成一条独立记录。

输出严格的 JSON（不要 markdown 代码块，不要任何解释）：
{
  "mistakes": [
    {
      "problem": "该错误点对应的题目原文",
      "userAnswer": "孩子写的错误答案，尽量从照片里的笔迹读出来；读不出留空字符串",
      "correctAnswer": "正确答案（你能确定就填，不确定留空字符串）",
      "subject": "学科，只能是 math / chinese / english 之一；判断不了留空字符串",
      "errorType": "错因（如 进位加法错误、形近字混淆）；判断不了留空字符串",
      "reasoning": "一句话说明为什么错，给家长看"
    }
  ]
}

规则：
- 只输出 JSON，第一个字符是 {，最后一个字符是 }
- 照片里有几个错误点，mistakes 数组就有几条；一条都不能漏，也不要把多个错误点合并
- 任何字段判断不了就用空字符串 ""，家长会逐条确认和修改
- 如果照片模糊 / 不是作业 / 看不清，返回 {"mistakes": []}`;

export function buildMistakeItemsPrompt(): { system: string; user: string } {
  return {
    system: MISTAKE_ITEMS_SYSTEM_PROMPT,
    user: "请把这张作业照片里的每个错误点拆成一条记录。",
  };
}

function asItemString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Parse the model's reply into one MistakeItem per wrong spot. Tolerant of:
 *   - ```json fences and leading/trailing prose (takes the first {...} block)
 *   - missing fields (filled with "")
 *   - Chinese subject names (数学 → math, …); unknown subjects drop to ""
 *   - non-object entries in the mistakes array (silently skipped)
 * Strict in:
 *   - the reply must contain a JSON object with a mistakes array —
 *     anything else is []
 */
export function parseMistakeItems(content: string): MistakeItem[] {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return [];
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return [];
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return [];
  const mistakes = (parsed as Record<string, unknown>).mistakes;
  if (!Array.isArray(mistakes)) return [];
  const items: MistakeItem[] = [];
  for (const entry of mistakes) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) continue;
    const obj = entry as Record<string, unknown>;
    items.push({
      problem: asItemString(obj.problem),
      userAnswer: asItemString(obj.userAnswer),
      correctAnswer: asItemString(obj.correctAnswer),
      subject: normalizeSubject(obj.subject),
      errorType: asItemString(obj.errorType),
      reasoning: asItemString(obj.reasoning),
    });
  }
  return items;
}

export interface MistakeItemsAnalysis {
  items: MistakeItem[];
  model: string;
  raw: unknown;
  /** "low" when no item could be parsed — the parent should retake. */
  confidence: VisionConfidence;
}

export async function analyzeMistakeItems(
  client: VisionClient,
  imageBase64: string,
  signal?: AbortSignal,
): Promise<MistakeItemsAnalysis> {
  const { system, user } = buildMistakeItemsPrompt();
  const { content, raw } = await client.chat({ system, user, imageBase64, signal });
  const items = parseMistakeItems(content);
  return {
    items,
    model: "MiniMax-M3",
    raw,
    confidence: items.length > 0 ? "ok" : "low",
  };
}

// Text-only revise: the parent asks in natural language to fix one item
// ("学科改成语文"), the model returns the corrected item in the same
// single-object JSON shape. No image is re-sent.

const REVISE_ITEM_SYSTEM_PROMPT = `你是错题整理助手。家长会给你一条已经拆好的错题记录（JSON）和一句修改要求，你要按修改要求更新这条记录。

输出严格的 JSON（不要 markdown 代码块，不要任何解释），字段与输入完全一致：
{
  "problem": "题目原文",
  "userAnswer": "孩子写的错误答案",
  "correctAnswer": "正确答案",
  "subject": "学科，只能是 math / chinese / english 之一；判断不了留空字符串",
  "errorType": "错因",
  "reasoning": "一句话说明为什么错"
}

规则：
- 只输出 JSON，第一个字符是 {，最后一个字符是 }
- 只按家长的要求改对应字段，其他字段原样保留
- 任何字段判断不了就用空字符串 ""`;

export function buildReviseItemPrompt(
  item: MistakeItem,
  instruction: string,
): { system: string; user: string } {
  return {
    system: REVISE_ITEM_SYSTEM_PROMPT,
    user: `当前记录：${JSON.stringify(item)}\n\n家长的修改要求：${instruction}`,
  };
}

/**
 * Revise one draft item from the parent's natural-language instruction.
 * Throws when the model call fails or the reply isn't a parseable item —
 * the route maps that to 502 (same contract as /api/capture/organize).
 */
export async function reviseMistakeItem(
  client: VisionClient,
  item: MistakeItem,
  instruction: string,
): Promise<MistakeItem> {
  const { system, user } = buildReviseItemPrompt(item, instruction);
  const { content } = await client.chat({ system, user });
  const trimmed = (content ?? "").trim();
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start >= 0 && end > start) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      parsed = undefined;
    }
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const obj = parsed as Record<string, unknown>;
      return {
        problem: asItemString(obj.problem),
        userAnswer: asItemString(obj.userAnswer),
        correctAnswer: asItemString(obj.correctAnswer),
        subject: normalizeSubject(obj.subject),
        errorType: asItemString(obj.errorType),
        reasoning: asItemString(obj.reasoning),
      };
    }
  }
  throw new Error("revise returned non-JSON");
}

// server/src/chat-signal.ts
//
// W1 hotfix（issue #28 + #46 #4）：
// - emotion parsing: 从 LLM 回复末尾解析 ::emotion:: 标签
// - loop detection: 检查最近 5 轮 child 消息是否僵持同一话题
//
// 7/28 痛点：糖糖说"我叫糖糖" 30 次，LLM 没能"察觉"自己在循环
// 期望：检测到循环 → 引导"问问爸爸妈妈"，同时写 outbox 通知家长

const VALID_EMOTIONS = new Set(["happy", "neutral", "sad", "angry", "fearful", "anxious"]);

/**
 * 从 LLM 回复末尾解析 ::emotion:: 标签。
 *
 * 格式：`...回复内容::emotion::happy::`
 *
 * @param reply - LLM 完整回复
 * @returns { cleanReply, emotion } - 去掉标签的回复 + 情绪
 *
 * 防御：
 * - 标签不在末尾 → 当作没标签
 * - 标签是未知值 → 当作 neutral
 * - 标签格式不对 → 当作没标签
 */
export function parseEmotionTag(reply: string): { cleanReply: string; emotion: string } {
  if (!reply || typeof reply !== "string") {
    return { cleanReply: "", emotion: "neutral" };
  }
  // 匹配末尾的 ::emotion::标签::
  const match = reply.match(/::emotion::(\w+)::\s*$/);
  if (!match) {
    return { cleanReply: reply, emotion: "neutral" };
  }
  const tag = match[1].toLowerCase();
  if (!VALID_EMOTIONS.has(tag)) {
    return { cleanReply: reply, emotion: "neutral" };
  }
  // 去掉标签 + 任何尾部空白
  const cleanReply = reply.slice(0, match.index!).trimEnd();
  return { cleanReply, emotion: tag };
}

/**
 * 循环检测（启发式）
 *
 * 判断标准（任一满足即认为 loop）：
 * 1. 窗口里 **3 条以上** child 消息是 **短 yes/no 回复**
 *    （≤ 4 字符 + 含"对/不/是/否/好/嗯"之一 — "是"/"不对"/"嗯" 之类）
 * 2. 窗口里 **3 条以上** 消息**含"对/不"字**（语义上的肯定/否定循环 — 5+ 字符的"对的"/"不对你说的"也算）
 *
 * 不用 LLM，纯字符串统计，避免误判。
 *
 * @param childTexts - 最近 N 轮 child 消息（按时间正序）
 * @returns true = 检测到循环
 */
export function detectLoopFromTexts(childTexts: string[]): boolean {
  if (!Array.isArray(childTexts) || childTexts.length < 5) {
    return false;
  }
  // 只看最近 5 轮
  const recent = childTexts.slice(-5);
  let shortYesNoCount = 0;
  let semanticYesNoCount = 0;
  for (const t of recent) {
    const text = String(t || "").trim();
    if (text.length === 0) continue;
    // 短 yes/no: ≤ 4 字符 + 含"对/不/是/否/好/嗯"之一
    if (text.length <= 4 && /[对不是否好嗯]/.test(text)) shortYesNoCount++;
    // 语义 yes/no: 含"对"或"不"字（5+ 字符也算）
    if (/[对不]/.test(text)) semanticYesNoCount++;
  }
  return shortYesNoCount >= 3 || semanticYesNoCount >= 3;
}

/**
 * 哪些 emotion 算"重要"，需要推 IM 给家长？
 * - happy/neutral：不需要（孩子正常）
 * - sad/angry/fearful/anxious：需要（可能需要家长介入）
 */
export const NOTIFIABLE_EMOTIONS = new Set(["sad", "angry", "fearful", "anxious"]);

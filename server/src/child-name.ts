// server/src/child-name.ts
//
// W1 hotfix #2（issue #46）：孩子可以改名字
//
// 7/28 糖糖说"我叫糖糖" 30 次，LLM 只 5 次用，其他 25 次仍叫"小宝"
// 期望：检测"我叫X"/"叫我X"等 pattern → 更新 children.name → 跨 session 持久

/**
 * 检测孩子消息里"我在告诉你我叫 X"的意图，返回 X。
 * 返回 null 表示没有名字变更意图。
 *
 * 严格匹配"自称"模式：
 * - 我的小名叫 X
 * - 我叫 X
 * - 叫我 X
 * - 我大名叫 X
 * - 我的名字是 X / 我名字叫 X
 *
 * 启发式过滤：
 * - 2-4 个汉字（或 1-2 个英文单词）
 * - 不是"吃了X" / "他叫X"等非自称上下文
 * - 5+ 字符 / 纯数字 / 单字 拒绝
 */
export function detectNameChange(text: string): string | null {
  if (!text || typeof text !== "string") return null;

  // 匹配模式（按"自我"语境排）
  // 严格 self-context：必须以"我"开头 / 显式"叫我"（避免"他叫小明"误判）
  // 名字长度 2-3 汉字（常见中文名）或 1-10 个英文字母
  // 名字后必须接空白/句末/标点（避免"我叫一只小猫"误捕成"一只小"）
  const patterns: RegExp[] = [
    /我的(?:小名|大名|名字)\s*(?:是|叫)\s*([\u4e00-\u9fa5]{2,3}|[A-Za-z]{1,10})(?=\s|$|[，。！？、])/,
    /我(?:大|小)名叫\s*([\u4e00-\u9fa5]{2,3}|[A-Za-z]{1,10})(?=\s|$|[，。！？、])/,
    /我叫\s*([\u4e00-\u9fa5]{2,3}|[A-Za-z]{1,10})(?=\s|$|[，。！？、])/,
    /叫我\s*([\u4e00-\u9fa5]{2,3}|[A-Za-z]{1,10})(?=\s|$|[，。！？、])/,
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m && m[1]) {
      return m[1];
    }
  }
  return null;
}

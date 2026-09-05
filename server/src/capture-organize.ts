// server/src/capture-organize.ts
//
// Buddy 文字描述 intake (capture app merge): an LLM structures a parent's
// messy one-line description ("昨天小宝算 8+5 写成 12") into the 5 fields
// /api/capture/manual needs. Both functions here are pure so they're
// unit-testable without an LLM:
//
//   buildOrganizePrompt(text)     : the system + user prompts we send
//   parseOrganizeResponse(content): strict-JSON reply → OrganizedMistake,
//                                   null on garbage (route maps to 502)
//
// The model is asked for strict JSON; fields it can't fill come back as
// "" and the parent edits them in the buddy preview UI before 确认录入.

export interface OrganizedMistake {
  problem: string;
  userAnswer: string;
  correctAnswer: string;
  subject: string;
  errorType: string;
}

const SUBJECTS = ["math", "chinese", "english"] as const;
const SUBJECT_ALIASES: Record<string, (typeof SUBJECTS)[number]> = {
  数学: "math",
  语文: "chinese",
  英语: "english",
};

const ORGANIZE_SYSTEM_PROMPT = `你是错题录入助手。家长用一两句口语描述孩子做错的一道题，你要把它整理成结构化字段。

输出严格的 JSON（不要 markdown 代码块，不要任何解释），字段如下：
{
  "problem": "题目原文，尽量补全为完整题目",
  "userAnswer": "孩子写的错误答案",
  "correctAnswer": "正确答案（你能确定就填，不确定留空字符串）",
  "subject": "学科，只能是 math / chinese / english 之一；判断不了留空字符串",
  "errorType": "错因（如 进位加法错误、看错题目）；判断不了留空字符串"
}

规则：
- 只输出 JSON，第一个字符是 {，最后一个字符是 }
- 任何字段判断不了就用空字符串 ""，家长会手动补`;

export function buildOrganizePrompt(text: string): { system: string; user: string } {
  return {
    system: ORGANIZE_SYSTEM_PROMPT,
    user: `家长的描述：${text}`,
  };
}

function asString(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function normalizeSubject(v: unknown): string {
  const s = asString(v).toLowerCase();
  if ((SUBJECTS as readonly string[]).includes(s)) return s;
  const alias = SUBJECT_ALIASES[asString(v)];
  return alias ?? "";
}

/**
 * Parse the model's reply into the 5 intake fields. Tolerant of:
 *   - ```json fences and leading/trailing prose
 *   - missing fields (filled with "")
 *   - Chinese subject names (数学 → math, …)
 *   - unknown subjects (dropped to "")
 * Strict in:
 *   - the reply must contain a JSON object — anything else is null
 */
export function parseOrganizeResponse(content: string): OrganizedMistake | null {
  const trimmed = (content ?? "").trim();
  if (!trimmed) return null;
  // Strip ```json ... ``` fences / prose: take the first {...} block.
  const start = trimmed.indexOf("{");
  const end = trimmed.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed.slice(start, end + 1));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  return {
    problem: asString(obj.problem),
    userAnswer: asString(obj.userAnswer),
    correctAnswer: asString(obj.correctAnswer),
    subject: normalizeSubject(obj.subject),
    errorType: asString(obj.errorType),
  };
}

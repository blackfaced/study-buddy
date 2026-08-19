// src/vision-page.ts
//
// v0.5 (issue #128 / SB124-T04): page-layout VLM prompt + parser for
// 整页照片批量确认. Strategy B: layout analysis first (return N
// text regions with bounding boxes), then per-region OCR (reusing the
// existing analyzeMistakeImage on each crop). This file is the pure
// half — the prompt + response parser. The I/O half (calling the
// vision API, cropping, stitching results) lives in the workflow.

export interface VisionClient {
  chat(params: {
    system: string;
    user: string;
    imageBase64: string;
    signal?: AbortSignal;
  }): Promise<{ content: string; raw: unknown }>;
}

/**
 * A region of a homework page identified by the layout pass. Bounding
 * box is in normalized coordinates (0-1 of the image's width/height),
 * so it can be applied to any image size with sharp.extract().
 *
 *   bbox[0] = left   (x1)
 *   bbox[1] = top    (y1)
 *   bbox[2] = right  (x2)
 *   bbox[3] = bottom (y2)
 *
 * subject is the model's best guess of which subject the question
 * belongs to. v0.1 only stores this for future filtering — the
 * current inbox surfaces problem text, not subject.
 */
export interface LayoutRegion {
  index: number;
  bbox: [number, number, number, number];
  subject: PageSubject;
}

export type PageSubject = "math" | "chinese" | "english" | "other";
const KNOWN_SUBJECTS: ReadonlySet<PageSubject> = new Set([
  "math",
  "chinese",
  "english",
  "other",
]);

export type VisionConfidence = "ok" | "low";

export interface PageLayoutAnalysis {
  regions: LayoutRegion[];
  confidence: VisionConfidence;
  raw: unknown;
}

const PAGE_LAYOUT_SYSTEM_PROMPT = `你是一个小学作业版面分析助手,服务于 1-3 年级的家长。

你的任务:看这张作业照片,识别出照片里**每一道独立的题目**。一张照片里可能有 1 到 N 道题(N 一般 1-10)。

输出严格的 JSON 数组(只能输出 JSON, 不要任何解释 / 前缀 / markdown 代码块 / 标点符号):

[
  {"index": 1, "bbox": [x1, y1, x2, y2], "subject": "math" | "chinese" | "english" | "other"},
  {"index": 2, "bbox": [x1, y1, x2, y2], "subject": "..."},
  ...
]

字段规则:
- **index**: 从 1 开始的整数, 顺序按从上到下、从左到右
- **bbox**: 归一化坐标 [0, 1] 范围, [x1, y1, x2, y2] = (左边距, 上边距, 右边距, 下边距), 必须满足 0 ≤ x1 < x2 ≤ 1, 0 ≤ y1 < y2 ≤ 1
- **subject**: 只能是 "math" / "chinese" / "english" / "other" 四个值之一

识别规则:
- **每道题独立**, 不要把多道题合成一道, 也不要拆一道为多道
- 应用题和计算题都算独立题
- 选择题 / 填空题 / 判断题 / 解答题 各自独立
- 同一题的小问 (如 1.(1), 1.(2)) 算同一道, bbox 包整题
- 页眉、页脚、姓名、学号、班级 都不算题
- 草稿、涂改、印章 不算题

如果:
- 照片模糊, 看不清题目 → 返 []
- 照片不是作业 / 题目页 → 返 []
- 整页没看到独立题目 (比如只是封面 / 目录) → 返 []

返回 [] 时, 直接写 "无法识别" 也可以, 我会自己判断。`;

export function buildPageLayoutPrompt(): { system: string; user: string } {
  return {
    system: PAGE_LAYOUT_SYSTEM_PROMPT,
    user: "请分析这张作业照片的版面,识别出每一道独立的题目。",
  };
}

/**
 * Parse the model's reply into a deduplicated, in-order list of layout
 * regions. Tolerant of:
 *   - leading/trailing whitespace
 *   - JSON wrapped in a ```json ... ``` code block
 *   - non-array JSON (returns empty)
 *   - missing subject (drops the region)
 *   - extra fields (ignored)
 *   - duplicate indexes (keeps the first)
 *   - out-of-order indexes (sorts by index ascending)
 *
 * Strict in:
 *   - bbox must be 4 numbers in [0, 1] with x1 < x2 and y1 < y2
 *   - index must be a positive integer
 *   - subject must be a known value
 */
export function parsePageLayoutResponse(content: string): PageLayoutAnalysis {
  const trimmed = (content ?? "").trim();
  if (!trimmed) {
    return { regions: [], confidence: "low", raw: null };
  }
  if (trimmed === "无法识别") {
    return { regions: [], confidence: "low", raw: null };
  }

  const json = extractJson(trimmed);
  if (json === null) {
    return { regions: [], confidence: "low", raw: trimmed };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return { regions: [], confidence: "low", raw: trimmed };
  }

  if (!Array.isArray(parsed)) {
    return { regions: [], confidence: "low", raw: trimmed };
  }

  const seen = new Set<number>();
  const regions: LayoutRegion[] = [];
  for (const raw of parsed) {
    const region = coerceRegion(raw);
    if (!region) continue;
    if (seen.has(region.index)) continue;
    seen.add(region.index);
    regions.push(region);
  }
  regions.sort((a, b) => a.index - b.index);

  return {
    regions,
    confidence: evaluateLayoutConfidence(regions),
    raw: trimmed,
  };
}

/**
 * Heuristic: classify a parsed layout as "ok" (parent can review the
 * candidates) or "low" (parent should retake or type manually). Pure
 * function. Empty region list → "low"; any region(s) → "ok".
 */
export function evaluateLayoutConfidence(regions: LayoutRegion[]): VisionConfidence {
  return regions.length > 0 ? "ok" : "low";
}

/**
 * Call the vision client with the page-layout prompt + image, return
 * the parsed analysis. Thin wrapper — the parsing rules live in
 * parsePageLayoutResponse (unit-tested separately).
 */
export async function analyzePageLayout(
  client: VisionClient,
  imageBase64: string,
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<PageLayoutAnalysis & { model: string }> {
  const { system, user } = buildPageLayoutPrompt();
  const { content, raw } = await client.chat({ system, user, imageBase64, signal: options.signal });
  const parsed = parsePageLayoutResponse(content);
  return {
    regions: parsed.regions,
    confidence: parsed.confidence,
    model: options.model ?? "MiniMax-M3",
    // Propagate the original client raw — same convention as
    // analyzeMistakeImage. parsePageLayoutResponse's internal `raw`
    // is the trimmed content for debug, not what callers want.
    raw,
  };
}

// ------------------- internals -------------------

function extractJson(text: string): string | null {
  // Strip a leading ```json / ``` fence if present
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/m.exec(text);
  if (fence) return fence[1];
  // Otherwise assume the whole text is JSON
  return text;
}

function coerceRegion(raw: unknown): LayoutRegion | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const index = coercePositiveInt(r.index);
  if (index === null) return null;
  const bbox = coerceBbox(r.bbox);
  if (!bbox) return null;
  const subject = coerceSubject(r.subject);
  if (!subject) return null;
  return { index, bbox, subject };
}

function coercePositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return null;
  return value;
}

function coerceBbox(value: unknown): [number, number, number, number] | null {
  if (!Array.isArray(value) || value.length !== 4) return null;
  const [a, b, c, d] = value;
  if (![a, b, c, d].every((n) => typeof n === "number" && Number.isFinite(n))) return null;
  const x1 = a as number;
  const y1 = b as number;
  const x2 = c as number;
  const y2 = d as number;
  if (x1 < 0 || x1 >= 1) return null;
  if (x2 <= x1 || x2 > 1) return null;
  if (y1 < 0 || y1 >= 1) return null;
  if (y2 <= y1 || y2 > 1) return null;
  return [x1, y1, x2, y2];
}

function coerceSubject(value: unknown): PageSubject | null {
  if (typeof value !== "string") return null;
  if (!KNOWN_SUBJECTS.has(value as PageSubject)) return null;
  return value as PageSubject;
}

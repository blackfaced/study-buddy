import type { VisionClient } from "./vision.js";

export interface HandwritingReview {
  status: "completed";
  suggestion: string;
  model: string;
}

const SYSTEM_PROMPT = `你只复评一个方格内单个硬笔汉字的间架结构和部件比例。

规则：
- 只给一句不超过 24 个汉字、可以立刻照做的建议
- 只谈宽窄、高低、疏密、重心或部件比例
- 不打分，不给评价档位
- 不得评价或改写笔顺、笔画方向、完整性或方格绝对位置
- 看不清或没有可靠建议时只回复“结构暂时无法复评”
- 不输出前缀、列表或解释`;

export async function reviewHandwritingImage(
  client: VisionClient,
  imageBase64: string,
  localAssessment: Record<string, unknown>,
  options: { model?: string; signal?: AbortSignal } = {},
): Promise<HandwritingReview> {
  const structure = isRecord(localAssessment.breakdown)
    ? localAssessment.breakdown.structure
    : null;
  const { content } = await client.chat({
    system: SYSTEM_PROMPT,
    user: `本地结构可信度：${typeof structure === "number" ? structure.toFixed(2) : "未知"}。请只看图片给结构建议。`,
    imageBase64,
    signal: options.signal,
  });
  return {
    status: "completed",
    suggestion: sanitizeSuggestion(content),
    model: options.model ?? "MiniMax-M3",
  };
}

function sanitizeSuggestion(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  if (!compact) return "结构暂时无法复评";
  if (/(笔顺|顺序|方向|倒笔|先写|后写|漏笔|少.{0,3}笔|多.{0,3}笔|完整性|方格|位置|分数|评分|档位)/u.test(compact)) {
    return "结构暂时无法复评";
  }
  return Array.from(compact).slice(0, 30).join("");
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

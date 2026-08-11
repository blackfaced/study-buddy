export type SafetyCategory =
  | "bullying"
  | "abuse"
  | "self_harm"
  | "sexual"
  | "severe_symptom"
  | "personal_info";

export type SafetyUrgency = "attention" | "imminent";

export interface ChildSafetyMatch {
  category: SafetyCategory;
  urgency: SafetyUrgency;
  reply: string;
}

const RULES: Array<{ category: SafetyCategory; patterns: RegExp[] }> = [
  { category: "severe_symptom", patterns: [/喘不过气/, /呼吸不了/, /胸口(很|特别)?痛/, /流(了)?很多血/, /昏倒/, /失去意识/] },
  { category: "self_harm", patterns: [/不想活/, /想死/, /杀死自己/, /伤害自己/, /割腕/, /跳楼/, /结束生命/] },
  { category: "sexual", patterns: [/让我脱衣服/, /要我脱衣服/, /摸我.*(隐私|下面|胸)/, /隐私部位/, /发裸照/, /性侵/] },
  { category: "abuse", patterns: [/(爸爸|妈妈|家里人|大人).*(打我|踢我|掐我)/, /把我锁起来/, /不让我吃饭/, /用东西打我/] },
  { category: "bullying", patterns: [/欺负我/, /霸凌/, /同学.*(打我|踢我|威胁我|不让我)/, /被同学.*(打|骂|威胁)/] },
  {
    category: "personal_info",
    patterns: [
      /(问|要|让我|叫我).*(家庭地址|住址|学校名|学校名字|电话号码|手机号|密码|秘密)/,
      /(家庭地址|住址|学校名|学校名字|电话号码|手机号|密码).*(告诉|发给|给他|给她|给别人)/,
      /1[3-9]\d{9}/,
    ],
  },
];

const IMMINENT_MARKERS = /现在|马上|正在|已经|准备|要去|今天就/;

export function classifyChildSafety(text: string): ChildSafetyMatch | null {
  const normalized = text.trim().replace(/\s+/g, "");
  for (const rule of RULES) {
    if (!rule.patterns.some((pattern) => pattern.test(normalized))) continue;
    const urgency: SafetyUrgency =
      rule.category === "severe_symptom" ||
      (rule.category === "self_harm" && IMMINENT_MARKERS.test(normalized))
        ? "imminent"
        : "attention";
    return { category: rule.category, urgency, reply: buildSafetyReply(rule.category, urgency) };
  }
  return null;
}

function buildSafetyReply(category: SafetyCategory, urgency: SafetyUrgency): string {
  if (urgency === "imminent") {
    return "先别一个人待着，马上去找身边信任的大人。如果你现在会受伤或身体很危险，请让大人立即拨打 120 或 110；我不能替你联系。";
  }
  if (category === "personal_info") {
    return "不要把地址、学校、电话、密码或秘密告诉我或网上的人。请马上把这件事告诉身边信任的大人。";
  }
  return "这件事很重要，请现在去告诉身边信任的大人，比如爸爸妈妈、老师或其他照顾你的人。你不用继续向我讲细节。";
}

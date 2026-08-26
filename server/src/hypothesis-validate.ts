// server/src/hypothesis-validate.ts
//
// T06: pure helper for validating + flagging a free-text error-cause
// hypothesis before it lands in case_hypotheses. The "sensitive" flag
// is the kid-facing-view filter: if a parent types something that's
// personal / insulting / risky to surface to the kid, we mark it
// sensitive and the kid-facing view drops it.
//
// v0.1 砍半: a small allowlist of obvious sensitive patterns. Real
// LLM moderation lives in the LLM-based small tutor slice (T08).

const SENSITIVE_PATTERNS: ReadonlyArray<RegExp> = [
  // Insults. Use Chinese-char lookaround instead of \b (Chinese is
  // not an ASCII word char, so \b never matches between CJK chars).
  /笨蛋/,
  /小屁孩/,
  /傻瓜/,
  /弱智/,
  /废物/,
  // 滚 / 蠢 alone are too short (1 char) — false-positive city
  // names like "滚" alone don't exist but "笨蛋" is the common
  // form. Skip single-char patterns to keep noise down.
  // privacy markers
  /家里电话/,
  /家庭住址/,
  /身份证/,
  /password\s*[:=]/i,
];

export interface ValidatedHypothesis {
  text: string;
  sensitive: boolean;
}

export function validateHypothesis(text: string): ValidatedHypothesis {
  const trimmed = text.trim();
  const sensitive = SENSITIVE_PATTERNS.some((p) => p.test(trimmed));
  return { text: trimmed, sensitive };
}

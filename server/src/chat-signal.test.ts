// server/src/chat-signal.test.ts
//
// W1 hotfix（issue #28 + #46 #4）：
// - emotion parsing: 从 LLM 回复末尾解析 ::emotion:: 标签
// - loop detection: 检查最近 5 轮 child 消息是否僵持同一话题
//
// 7/28 痛点：糖糖说"我叫糖糖" 30 次，LLM 没能"察觉"自己在循环
// 期望：检测到循环 → 引导"问问爸爸妈妈"，同时写 outbox 通知家长

import { describe, it, expect } from "vitest";
import { parseEmotionTag, detectLoopFromTexts } from "./chat-signal.js";

describe("parseEmotionTag", () => {
  it("happy 标签正常解析", () => {
    const r = parseEmotionTag("哈哈，你答对了！::emotion::happy::");
    expect(r.emotion).toBe("happy");
    expect(r.cleanReply).toBe("哈哈，你答对了！");
  });

  it("sad 标签正常解析（前后可能有空格/换行）", () => {
    const r = parseEmotionTag("听起来你不太开心。::emotion::sad::");
    expect(r.emotion).toBe("sad");
    expect(r.cleanReply).toBe("听起来你不太开心。");
  });

  it("没标签 → emotion = neutral", () => {
    const r = parseEmotionTag("我们先看看这道题。");
    expect(r.emotion).toBe("neutral");
    expect(r.cleanReply).toBe("我们先看看这道题。");
  });

  it("空字符串 → neutral", () => {
    const r = parseEmotionTag("");
    expect(r.emotion).toBe("neutral");
    expect(r.cleanReply).toBe("");
  });

  it("标签在中间（不解析） → neutral（防御）", () => {
    const r = parseEmotionTag("前面 ::emotion::sad:: 后面");
    expect(r.emotion).toBe("neutral");
    expect(r.cleanReply).toBe("前面 ::emotion::sad:: 后面");
  });

  it("未知标签 → neutral（防御）", () => {
    const r = parseEmotionTag("回复 ::emotion::boredom::");
    expect(r.emotion).toBe("neutral");
    expect(r.cleanReply).toBe("回复 ::emotion::boredom::");
  });

  it("angry 标签", () => {
    const r = parseEmotionTag("我知道你很生气。::emotion::angry::");
    expect(r.emotion).toBe("angry");
    expect(r.cleanReply).toBe("我知道你很生气。");
  });

  it("fearful 标签", () => {
    const r = parseEmotionTag("听起来你有点担心。::emotion::fearful::");
    expect(r.emotion).toBe("fearful");
    expect(r.cleanReply).toBe("听起来你有点担心。");
  });
});

describe("detectLoopFromTexts", () => {
  it("5 短回复（连续是/不是）→ loop", () => {
    const msgs = ["是", "不是", "是", "不对", "才不是"];
    expect(detectLoopFromTexts(msgs)).toBe(true);
  });

  it("5 长回复（正常对话）→ not loop", () => {
    const msgs = [
      "今天数学写完了",
      "接下来写语文",
      "这首诗有点难",
      "拼音我会读",
      "我想看一会儿书",
    ];
    expect(detectLoopFromTexts(msgs)).toBe(false);
  });

  it("3 短非 yes/no + 2 长 → not loop（短回复没对/不）", () => {
    const msgs = [
      "好的",
      "嗯",
      "写完了",
      "今天作业多",
      "我想休息一下",
    ];
    expect(detectLoopFromTexts(msgs)).toBe(false);
  });

  it("3 短 + 2 长 但全部包含'对'或'不' → loop（语义循环）", () => {
    const msgs = [
      "对",
      "不对",
      "对这个不对那个",
      "不对你说的",
      "你说的不对",
    ];
    expect(detectLoopFromTexts(msgs)).toBe(true);
  });

  it("窗口小于 5 → not loop", () => {
    const msgs = ["是", "不是", "是"];
    expect(detectLoopFromTexts(msgs)).toBe(false);
  });

  it("空数组 → not loop", () => {
    expect(detectLoopFromTexts([])).toBe(false);
  });

  it("全是同一个词 '不' → loop", () => {
    const msgs = ["不", "不", "不", "不", "不"];
    expect(detectLoopFromTexts(msgs)).toBe(true);
  });
});

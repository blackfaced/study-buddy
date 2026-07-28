// server/src/llm-prompt.test.ts
//
// 验证 LLM system prompt 的"称谓"规则（issue #29 / OPT-S1）：
// - 提示里必须包含孩子的名字（让 LLM 知道怎么称呼）
// - 提示里必须禁止"小朋友/小同学/宝贝/乖乖"等通用称呼
// - 默认名字是"小宝"（来自 db-migrate.ts 的 default child）
//
// 抽成 module 是为了能在 vitest 里 require（原来在 app.ts 内部 const 不可测）。

import { describe, it, expect } from "vitest";
import { buildSystemPrompt, buildChatPrompt } from "./llm-prompt.js";

describe("buildSystemPrompt (写作业模式)", () => {
  it("包含孩子名字", () => {
    const p = buildSystemPrompt("小宝");
    expect(p).toContain("小宝");
  });

  it("禁止'小朋友'", () => {
    const p = buildSystemPrompt("小宝");
    expect(p).toMatch(/不用.*小朋友|不要.*小朋友|禁止.*小朋友/);
  });

  it("禁止'小同学'", () => {
    const p = buildSystemPrompt("小宝");
    expect(p).toMatch(/不用.*小同学|不要.*小同学|禁止.*小同学/);
  });

  it("禁止'宝贝'", () => {
    const p = buildSystemPrompt("小宝");
    expect(p).toMatch(/不用.*宝贝|不要.*宝贝|禁止.*宝贝/);
  });

  it("禁止'乖乖'", () => {
    const p = buildSystemPrompt("小宝");
    expect(p).toMatch(/不用.*乖乖|不要.*乖乖|禁止.*乖乖/);
  });

  it("可配置孩子名字（不写死 '小宝'）", () => {
    const p = buildSystemPrompt("小明");
    expect(p).toContain("小明");
    expect(p).not.toContain("小宝");
  });

  it("保留原有的核心规则（不直接给答案 / 8 岁能听懂）", () => {
    const p = buildSystemPrompt("小宝");
    // 7/28 hotfix: 限定为"不直接给数学/事实题答案"（避免把作业问答也覆盖掉）
    expect(p).toMatch(/不直接给.*答案/);
    expect(p).toContain("8 岁");
  });
});

describe("buildChatPrompt (写完作业后自由陪聊)", () => {
  it("包含孩子名字", () => {
    const p = buildChatPrompt("小宝");
    expect(p).toContain("小宝");
  });

  it("禁止'小朋友'", () => {
    const p = buildChatPrompt("小宝");
    expect(p).toMatch(/不用.*小朋友|不要.*小朋友|禁止.*小朋友/);
  });

  it("可配置孩子名字", () => {
    const p = buildChatPrompt("小明");
    expect(p).toContain("小明");
    expect(p).not.toContain("小宝");
  });

  it("保留原有的'绝对不聊'列表", () => {
    const p = buildChatPrompt("小宝");
    expect(p).toContain("游戏");
    expect(p).toContain("动画");
  });
});

describe("W1 hotfix #1: 作业问答不要收口 (#46)", () => {
  // 7/28 糖糖问"伞像蘑菇圆圆的行不行"被 LLM 答"我们先看看这道题"（逃避）
  // 期望：孩子问"X 行不行"必须先答对/错，再说为什么

  it("buildSystemPrompt 含【作业问答】规则段", () => {
    const p = buildSystemPrompt("糖糖");
    expect(p).toContain("作业问答");
  });

  it("【作业问答】规则要求直接评判对错", () => {
    const p = buildSystemPrompt("糖糖");
    // 期望：prompt 里有"行"或"对"或"错" + "直接评判"或"先答"
    expect(p).toMatch(/行不行|对不对|先答|直接评判/);
  });

  it("禁止把'先看看这道题'当逃避", () => {
    const p = buildSystemPrompt("糖糖");
    // 不能写死禁止（因为这是合理的转场），但 prompt 必须明确"问 X 行不行" → 答
    expect(p).not.toMatch(/不知道.*先看看这道题|这个我们写完作业再说，问你.*对不对/);
  });
});

describe("W1 hotfix #3: 孩子诉求不要硬挡 (#46)", () => {
  // 7/28 糖糖说"你不能叫我小宝"，LLM 答"这是系统规则决定的"（硬挡）
  // 期望：引导"你想让爸爸改成什么？"

  it("buildSystemPrompt 含【诉求处理】规则段", () => {
    const p = buildSystemPrompt("糖糖");
    expect(p).toContain("诉求");
  });

  it("【诉求处理】规则禁止直接说'不能改'", () => {
    const p = buildSystemPrompt("糖糖");
    // prompt 自身不应该写"不能改"作为推荐回答
    expect(p).not.toMatch(/你不能改|不能给你改|不能.*改.*名字/);
  });

  it("【诉求处理】规则引导找家长", () => {
    const p = buildSystemPrompt("糖糖");
    // 期望 prompt 里有"让爸爸/让妈妈/找家长" + "改"
    expect(p).toMatch(/让爸爸|让妈妈|让.*改/);
  });

  it("【诉求处理】规则问孩子想要什么", () => {
    const p = buildSystemPrompt("糖糖");
    // 期望 prompt 里有"你想要"或"你想改成"等引导
    expect(p).toMatch(/你想要|你想改成/);
  });
});

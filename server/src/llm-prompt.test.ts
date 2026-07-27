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
    expect(p).toContain("不直接给答案");
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

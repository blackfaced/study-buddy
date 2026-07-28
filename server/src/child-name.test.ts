// server/src/child-name.test.ts
//
// W1 hotfix #2（issue #46）：孩子可以改名字
// 7/28 糖糖说"我叫糖糖" 30 次，LLM 只 5 次用，其他 25 次仍叫"小宝"
// 期望：检测"我叫X"/"叫我X"等 pattern → 更新 children.name → 跨 session 持久

import { describe, it, expect } from "vitest";
import { detectNameChange } from "./child-name.js";

describe("detectNameChange", () => {
  describe("标准 pattern（必须识别）", () => {
    it("'我的小名叫糖糖' → 糖糖", () => {
      expect(detectNameChange("我的小名叫糖糖")).toBe("糖糖");
    });

    it("'我叫糖糖' → 糖糖", () => {
      expect(detectNameChange("我叫糖糖")).toBe("糖糖");
    });

    it("'叫我糖糖' → 糖糖", () => {
      expect(detectNameChange("叫我糖糖")).toBe("糖糖");
    });

    it("'我大名叫韩林怡' → 韩林怡", () => {
      expect(detectNameChange("我大名叫韩林怡")).toBe("韩林怡");
    });

    it("'我的名字是糖糖' → 糖糖", () => {
      expect(detectNameChange("我的名字是糖糖")).toBe("糖糖");
    });
  });

  describe("长名字（3 汉字）", () => {
    it("'我叫林黛玉' → 林黛玉", () => {
      expect(detectNameChange("我叫林黛玉")).toBe("林黛玉");
    });
  });

  describe("负向 case（不能误判）", () => {
    it("'我今天吃了糖糖' → null (不是名字)", () => {
      // 上下文是吃糖糖，不是说"我叫糖糖"
      expect(detectNameChange("我今天吃了糖糖")).toBeNull();
    });

    it("'他叫小明' → null (不是自己叫)", () => {
      expect(detectNameChange("他叫小明")).toBeNull();
    });

    it("'什么是名字' → null", () => {
      expect(detectNameChange("什么是名字")).toBeNull();
    });

    it("'我喜欢' → null (没名字)", () => {
      expect(detectNameChange("我喜欢")).toBeNull();
    });

    it("'我叫' → null (没具体名字)", () => {
      expect(detectNameChange("我叫")).toBeNull();
    });

    it("'写作业' → null", () => {
      expect(detectNameChange("写作业")).toBeNull();
    });
  });

  describe("不合理的名字（拒绝）", () => {
    it("'我叫一只小猫坐在地上' → null (4 字符以上不像名字)", () => {
      // 4 字符以上 + 后跟其他内容 → 不是单纯名字
      expect(detectNameChange("我叫一只小猫坐在地上")).toBeNull();
    });

    it("'我叫123' → null (纯数字)", () => {
      expect(detectNameChange("我叫123")).toBeNull();
    });
  });
});

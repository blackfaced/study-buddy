# 优化 Backlog (v1, 2026-07-27)

> ⚠️ 2026-08-31：聊天已隐藏（`BUDDY_CHAT_ENABLED=false`，PR #191），项目定位转为家长运营的学习闭环（见 AGENTS.md "Positioning" + issue #192）。下方 **OPT-S1~S8（聊天改进）整体不再适用**；本文档保留作历史记录。
>
> 数据依据：7/27 糖果数学 1 局 (6/6, 100%) + 7/27 聊天 1 个 session 13 分钟
>
> 详细改动 + 估时见各 issue。原文备份：`~/Documents/study-buddy-backlog-2026-07-27.md`

---

## 🍬 子应用 1：糖果数学 (candy-math-island)

| # | 改动 | 估时 | issue |
|---|------|:---:|------|
| OPT-C1 🔥 | 难度自适应（5 局 ≥95% → +1） | 3-4h | [#30](https://github.com/blackfaced/study-buddy/issues/30) |
| OPT-C2 ✅ | 错题本机制（间隔重复） | 已 ship（SB124 closure loop + T08 延迟回放） | [#31](https://github.com/blackfaced/study-buddy/issues/31) |
| OPT-C3 ⚠️ | 跟写作业联动（数学完成 → 弹游戏） | 2-3h | [#32](https://github.com/blackfaced/study-buddy/issues/32) |
| OPT-C4 ⚠️ | 题目按年级分级（1 年级下 = 20 以内+表内乘除+应用题） | 4-5h | [#33](https://github.com/blackfaced/study-buddy/issues/33) |
| OPT-C5 ✅ | 错题讲评动画 | 4-6h | [#34](https://github.com/blackfaced/study-buddy/issues/34) |
| OPT-C6 ⏸️ | 连击奖励 / 短局拖长（7 天数据后评估） | - | [#41](https://github.com/blackfaced/study-buddy/issues/41) |

## 💬 子应用 2：小书童聊天 (study-buddy chat)

| # | 改动 | 估时 | issue |
|---|------|:---:|------|
| OPT-S1 🔥 | 称谓修复（叫"小宝"不用"小朋友"） | 1-2h | [#29](https://github.com/blackfaced/study-buddy/issues/29) |
| OPT-S2 🔥 | 情绪识别 + 通知家长 | 3-4h | [#28](https://github.com/blackfaced/study-buddy/issues/28) |
| OPT-S3 🔥 | 坐姿提醒改视觉/音效 | 2-3h | [#35](https://github.com/blackfaced/study-buddy/issues/35) |
| OPT-S4 ⚠️ | offtopic 拉回话术变化 | 1h | [#36](https://github.com/blackfaced/study-buddy/issues/36) |
| OPT-S5 ⚠️ | 数学题难度自适应 | 2-3h | [#37](https://github.com/blackfaced/study-buddy/issues/37) |
| OPT-S6 ⚠️ | 乘法表填空训练 | 3-4h | [#38](https://github.com/blackfaced/study-buddy/issues/38) |
| OPT-S7 ✅ | 任务进度条 | 2-3h | [#39](https://github.com/blackfaced/study-buddy/issues/39) |
| OPT-S8 ⏸️ | 长期记忆引用（需 MemoryNexus 跑起来） | 2h | [#40](https://github.com/blackfaced/study-buddy/issues/40) |

## 📋 排期（数据驱动）

| 周 | 改动 | 估时 | issues |
|:--:|------|:---:|--------|
| **W1 (7/27-8/2)** | OPT-S2 + OPT-S1 | 5h | [#28](https://github.com/blackfaced/study-buddy/issues/28) + [#29](https://github.com/blackfaced/study-buddy/issues/29) |
| **W2 (8/3-8/9)** | OPT-C1 + OPT-C2 | 6h | [#30](https://github.com/blackfaced/study-buddy/issues/30) + [#31](https://github.com/blackfaced/study-buddy/issues/31) |
| **W3 (8/10-8/16)** | OPT-S3 + OPT-S4 + OPT-C3 | 6h | [#35](https://github.com/blackfaced/study-buddy/issues/35) + [#36](https://github.com/blackfaced/study-buddy/issues/36) + [#32](https://github.com/blackfaced/study-buddy/issues/32) |
| **W4 (8/17-8/23)** | OPT-S5 + OPT-S6 + OPT-C4 | 9h | [#37](https://github.com/blackfaced/study-buddy/issues/37) + [#38](https://github.com/blackfaced/study-buddy/issues/38) + [#33](https://github.com/blackfaced/study-buddy/issues/33) |
| **未来** | OPT-S7 + OPT-C5 + OPT-S8 + OPT-C6 | 8h+ | [#39](https://github.com/blackfaced/study-buddy/issues/39) + [#34](https://github.com/blackfaced/study-buddy/issues/34) + [#40](https://github.com/blackfaced/study-buddy/issues/40) + [#41](https://github.com/blackfaced/study-buddy/issues/41) |

## 🔥 优先级解释

- **🔥 必做** — 数据已证实痛点（6/6 太简单、叫"小朋友"被拒、提到"妈妈打我"无通知）
- **⚠️ 应该做** — 体验改进（重复话术、难度匹配、行为闭环）
- **✅ 锦上添花** — 长期价值高但非紧急（动画、换装）
- **⏸️ 暂缓** — 数据不足或前置依赖没准备好（连击奖励只有 1 局数据；S8 需 MemoryNexus 服务先跑）

## 维护规则

- 每改完一个 → close issue + 在这表里填上 issue 编号（#XX）
- 每周 cron 周一 09:30 提醒本周要做的项（沿用组合管理方法论）
- 任何"5 分钟看不出能不能做完"的项 → 先 PR 化最小可行版本，再迭代

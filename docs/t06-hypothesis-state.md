# T06 Hypothesis State Machine (SB124 #130)

> T05 review workspace (PR #170) 让 kid 重新订正题目。T06 加错因假设的
> 状态机：parent 看到 "系统观察到的错因" 跟 "待确认的错因假设"
> 区分开；kid 或 parent 可 confirm / modify / reject 假设；未确认的
> 假设不会进 report。

## Scope (first slice)

只做 hypothesis state machine 后端，**不做**：
- 客户端 review workspace UI 改造（minimal text-only OK，v0.1 砍半）
- 小书童 LLM 助手（second slice）
- 报告层把 hypothesis 写入 parent report（second slice，T09/T10 范围）
- hypothesis 自动 suggest（依赖 LLM）

## Acceptance criteria (per issue #130)

- [ ] 错因观察（系统 derived from errorType）vs 错因假设（parent/kid 标注）schema 区分
- [ ] 假设可 confirm / modify / reject；未确认假设不进 report（暂不读，但 DB 状态可见）
- [ ] 敏感标签过滤：kid-facing 视图不返 sensitive=true 的 hypothesis
- [ ] 测试覆盖：状态机、敏感过滤、跨 child 隔离

## Schema

新表 `case_hypotheses`：
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `case_id TEXT NOT NULL` (FK → mistake_cases.case_id)
- `child_id TEXT NOT NULL` (FK → children.id)
- `hypothesis TEXT NOT NULL` (短文本，描述错因)
- `label TEXT` (compute / carry / borrow / multiply / OTHER)
- `source TEXT NOT NULL CHECK (source IN ('system', 'parent', 'kid'))`
- `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'rejected', 'modified'))`
- `parent_hypothesis_id INTEGER` (FK self，用于 modified 指向原始)
- `sensitive INTEGER NOT NULL DEFAULT 0` (boolean，敏感标签过滤)
- `created_at INTEGER NOT NULL`
- `confirmed_at INTEGER`

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| **T06-1** | `case_hypotheses` 表存在 + 列对 | fresh DB migrate + schema introspection |
| **T06-2a** | `validateHypothesis` 检测敏感词 → 标 sensitive | "小屁孩" "笨蛋" 等 → sensitive=true |
| **T06-2b** | 普通文本 → sensitive=false | "compute 错" → sensitive=false |
| **T06-3a** | workflow addHypothesis 写入 (source=parent) | DB row 存在 + 字段对 |
| **T06-3b** | confirm / reject / modify 状态机正确 | 3 个 transition + 1 个 idempotent |
| **T06-4** | API 4 个 endpoint 端到端 + 跨 child 403 | supertest |
| **T06-5** | kid-facing view 过滤 sensitive | 1 sensitive + 1 normal → kid GET 只返 1 |

## TDD red→green order

1. T06-1: db-migrate ALTER + CREATE TABLE + 1 test
2. T06-2: pure `validateHypothesis(text) → { text, sensitive }` + 2 tests
3. T06-3: workflow `addHypothesis` / `confirmHypothesis` / `rejectHypothesis` / `modifyHypothesis` + tests
4. T06-4: API 4 endpoints + auth + cross-child + sensitive-in-kid-view
5. 跑全 test + typecheck + oxlint

## Out of scope (second slice)

- 客户端 review workspace UI 改造（T07 #131）
- 小书童 LLM 助手（T08 #132, 需要 LLM client + 不阻断 fallback）
- report 把 hypothesis 写入（T09 #133）
- hypothesis 自动 suggest（依赖 LLM，T10 #134）

## Files touched

- `server/src/db-migrate.ts` — CREATE TABLE case_hypotheses
- `server/src/hypothesis-validate.ts` (new) — pure validateHypothesis
- `server/src/hypothesis-validate.test.ts` (new) — T06-2
- `server/src/hypothesis-workflow.ts` (new) — add/confirm/reject/modify
- `server/src/hypothesis-workflow.test.ts` (new) — T06-3
- `server/src/routes/capture.ts` — 4 endpoints + kid view 过滤 sensitive
- `server/src/capture-hypothesis.test.ts` (new) — T06-4, T06-5

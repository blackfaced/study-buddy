# T07 Similar Problems (SB124 #131)

> 订正完成后，对支持数学题型生成 1-2 道同知识点同错误陷阱
> 的相似题。每题作为 Reinforcement Attempt 留痕，答错回到讲解
> 状态，有上限防无限练习。

## Scope (first slice)

只做支持数学题型（2-数加减）同知识点变种生成，**不做**：
- 应用题 (multi-step word problems)
- 3 数运算 / 乘除 (后续切片)
- LLM 生成 (deterministic 规则生成，按 issue 要求)

## Schema

新表 `reinforcement_attempts`:
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `case_id TEXT NOT NULL` (FK → mistake_cases)
- `child_id TEXT NOT NULL`
- `attempt_index INTEGER NOT NULL` (1, 2, ...)
- `problem TEXT NOT NULL` (生成的相似题)
- `correct_answer TEXT NOT NULL`
- `user_answer TEXT` (null = 没答)
- `is_correct INTEGER` (0/1, null = pending)
- `started_at INTEGER`
- `submitted_at INTEGER`
- `UNIQUE(case_id, attempt_index)`

新表 `case_reinforcement_state`:
- `case_id TEXT PRIMARY KEY` (FK → mistake_cases)
- `reinforcement_attempts_made INTEGER NOT NULL DEFAULT 0`
- `last_reinforcement_correct_at INTEGER`
- `max_attempts INTEGER NOT NULL DEFAULT 3`

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| **T07-1** | db-migrate 加 2 表 + FK | schema introspection |
| **T07-2a** | pure `generateSimilarProblems("3+4=?", "compute", count=2)` 返回 2 道加法变种 | 数字替换 + 同操作符 |
| **T07-2b** | `generateSimilarProblems("12-7=?", "borrow", count=2)` | 大数减法 + 退位保留 |
| **T07-2c** | 不支持题型 (空 problem / 非数学) 返回空数组 | 优雅降级 |
| **T07-3** | workflow `recordReinforcementAttempt` 写 row + 增 attempts_made | DB 验证 |
| **T07-4** | `recordReinforcementAttempt` 达 max_attempts → 抛 MaxAttemptsReached | 5 case + idempotency |
| **T07-5a** | API POST /api/capture/case/:caseId/reinforcement 返 { problem, correctAnswer, attemptIndex } | supertest |
| **T07-5b** | API POST submit answer → 返 { isCorrect, attemptsRemaining } | supertest |

## TDD order

1. T07-1: db-migrate
2. T07-2: pure generateSimilarProblems + 3 tests
3. T07-3 + T07-4: workflow + tests
4. T07-5: API 2 endpoints

## Files

- `server/src/db-migrate.ts` — ALTER + CREATE 2 new tables
- `server/src/similar-problems.ts` (new) — pure generateSimilarProblems
- `server/src/similar-problems.test.ts` (new) — T07-2
- `server/src/reinforcement-workflow.ts` (new) — recordReinforcementAttempt
- `server/src/reinforcement-workflow.test.ts` (new) — T07-3, T07-4
- `server/src/routes/capture.ts` — 2 endpoints
- `server/src/capture-reinforcement.test.ts` (new) — T07-5

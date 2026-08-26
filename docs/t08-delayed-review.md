# T08 Delayed Review (SB124 #132)

> 完成相似题巩固 (T07) 后 1/3/7 天有界回放，结果记 Mastery
> Evidence 而非永久标签。失败 re-open 教学状态，成功不显示
> "已掌握"。

## Scope (first slice)

只做回放的 schedule + record + 1 个 query endpoint，**不做**：
- 重新打开的复杂 teaching state 切换（记录 attempts_made > 0 即可）
- 永久"已掌握"标签（永远不显示）
- 时区边界（v0.1 用 server-local time, 后续切片）
- cron 提醒（用现有 `/api/capture/case/:caseId/reviews` 查询 + UI 触发）

## Schema

新表 `review_schedules`:
- `id INTEGER PRIMARY KEY AUTOINCREMENT`
- `case_id TEXT NOT NULL` (FK → mistake_cases)
- `child_id TEXT NOT NULL`
- `scheduled_at INTEGER NOT NULL` (epoch ms)
- `notified_at INTEGER` (null = 未到期提醒)
- `completed_at INTEGER` (null = 没做完/没做)
- `completed_is_correct INTEGER` (0/1/null)
- `reopened_count INTEGER NOT NULL DEFAULT 0` (失败触发 re-open 次数)
- `created_at INTEGER NOT NULL`
- `FOREIGN KEY (case_id, child_id)`

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| **T08-1** | db-migrate 加 review_schedules + 列对 | schema introspection |
| **T08-2a** | pure `scheduleReview(caseId, completedAt)` 返 3 个 due dates (1/3/7 天) | deterministic clock mock |
| **T08-2b** | scheduleReview 边界：completed_at 0 → 3 due dates 都基于此 | edge case |
| **T08-3a** | `completeReviewAttempt(scheduleId, isCorrect)` 写 completed_at + is_correct | success path |
| **T08-3b** | completeReviewAttempt 失败 → reopened_count++ 标记 re-open | failure path |
| **T08-3c** | 重复 complete throws AlreadyCompleted (idempotency guard) | 409 |
| **T08-4** | API GET /api/capture/case/:caseId/reviews 返 3 pending schedules | supertest |
| **T08-5a** | API POST /api/capture/review/:reviewId/complete 成功 → 200 | supertest |
| **T08-5b** | API POST 完成失败 → reopened_count++ 写库 | supertest + DB |

## Files

- `server/src/db-migrate.ts` — ALTER + CREATE TABLE review_schedules
- `server/src/review-schedule.ts` (new) — pure scheduleReview
- `server/src/review-schedule.test.ts` (new) — T08-2
- `server/src/review-workflow.ts` (new) — completeReviewAttempt
- `server/src/review-workflow.test.ts` (new) — T08-3
- `server/src/routes/capture.ts` — 2 endpoints
- `server/src/capture-review.test.ts` (new) — T08-4, T08-5

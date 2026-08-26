# T04-C Confirm/Discard (SB124 #128 PR-C)

> T04-B 跑了 per-region OCR，把 candidate 写进 `mistake_photo_candidates`。
> T04-C 接在它后面：parent 选 candidate，写 kid 答案，confirm 后落
> mistake_cases 进入 closure loop；不要的 discard。

## Scope (first slice)

只做"per-candidate confirm/discard"这一步，**不做**：
- 客户端 confirm/discard UI（T04-D 负责）
- bulk confirm-all（second slice）
- 取消整个 draft 的 cancel 流程（T04-A cancel endpoint 已存在，跨过）
- candidates 状态枚举扩展（只 pending/confirmed/discarded，v0.1 不引入 `requires_retake` 等）

## Acceptance criteria

- `mistake_photo_candidates` 加 `status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'confirmed', 'discarded'))`
- `mistake_photo_candidates` 加 `confirmed_case_id TEXT` (nullable, FK → `mistake_cases.case_id`)
- 加 `UNIQUE INDEX mistake_photo_candidates_draft_region ON mistake_photo_candidates (draft_id, region_index)` (idempotency anchor)
- `confirmCandidate` workflow：load candidate → 校验 ownership → `insertMistake` (走 SB124-T01 closure loop) → 写 `confirmed_case_id` + `status='confirmed'`
- `discardCandidate` workflow：load → 校验 → 写 `status='discarded'`
- 两条 idempotent：重复 confirm/discard 不报错，返 same caseId / 200 no-op
- 跨 child 隔离：candidate 不属于 caller child → 404（不 leak 存在性）
- 重复 confirm 已 confirmed → 200 返 existing caseId，不创建第二条 mistake
- 重复 discard 已 discarded → 200 返 `{ discarded: true }`
- confirm 一个已 discarded 的 candidate → 409 Conflict

## TDD test plan (5 case first slice, ~10 actual)

| Test | 验什么 | 怎么验 |
|---|---|---|
| **T04C-1** | db-migrate 后 `mistake_photo_candidates` 有 status + confirmed_case_id 列 + UNIQUE index | fresh DB migrate + schema introspection |
| **T04C-2a** | pure `promoteCandidateToMistakeCase` builds the right `insertMistake` payload | mock insertMistake → 记录 call args |
| **T04C-2b** | promote 接受 errorType 透传给 insertMistake | 同上但带 errorType |
| **T04C-3a** | `confirmCandidate` happy path：1 candidate → 1 mistake_case + status='confirmed' | supertest POST + DB query |
| **T04C-3b** | confirm 重复：第二次返 same caseId，不创建第二条 | POST 2 次 + DB count |
| **T04C-4a** | `discardCandidate` happy path：1 candidate → status='discarded' | supertest POST + DB query |
| **T04C-4b** | discard 重复：第二次 200 no-op | POST 2 次 |
| **T04C-5a** | confirm cross-child 404 (candidate belongs to bob, caller is default) | supertest + DB |
| **T04C-5b** | confirm 已 discarded candidate → 409 | 先 discard 再 confirm |
| **T04C-5c** | 404 当 candidateId 不存在 | supertest |

## TDD red→green order

1. T04C-1: db-migrate ALTER + test
2. T04C-2: pure `promoteCandidateToMistakeCase` + 2 tests
3. T04C-3: workflow `confirmCandidate` + 2 tests
4. T04C-4: workflow `discardCandidate` + 2 tests
5. T04C-5: API confirm + discard endpoints + auth/409/idempotency 边界

## Out of scope (next slice)

- bulk `confirm-all` (parent 一次性确认整页所有 candidate) → T04-D 一起做（UI 强依赖）
- 取消整个 draft 的 cancel 流程（draft.cancel 已存在 T04-A）→ 不动
- candidates → mistake_cases 字段扩展（userAnswer / correctAnswer 由 parent 填，这里只透传）→ 已支持

## Files touched

- `server/src/db-migrate.ts` — ALTER + CREATE UNIQUE INDEX
- `server/src/candidate-promotion.ts` (new) — pure promoteCandidateToMistakeCase
- `server/src/candidate-promotion.test.ts` (new) — T04C-2
- `server/src/candidate-workflow.ts` (new) — confirmCandidate + discardCandidate
- `server/src/candidate-workflow.test.ts` (new) — T04C-3, T04C-4
- `server/src/routes/mistake-page-photo.ts` — 加 2 个 endpoint
- `server/src/page-photo-candidate.test.ts` (new) — T04C-5

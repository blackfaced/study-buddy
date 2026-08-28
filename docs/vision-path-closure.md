# Vision path uses insertMistake directly (issue #166)

> `server/src/routes/mistake-photo.ts` 当前 vision confirm 流程走的是
> legacy `ensureMistakeCompatibility(db, { ... })` 路径写入三张 compat 表。
> T10 之后 closure loop 是 source of truth, vision path 切到 `insertMistake()`。

## 现状 (8/28 验证)

`server/src/routes/mistake-photo.ts` 确认路径:
1. SELECT existing mistakes (idempotent retry)
2. INSERT OR IGNORE INTO mistakes (legacy mirror)
3. ensureMistakeCompatibility (compat bridge) → mirror 到 mistake_cases + learning_attempts + correction_obligations
4. appendLearningAttemptSourceEvent
5. INSERT mistake_photo_confirmations
6. Return { mistakeId, problemText, confirmationMethod }

跟 `server/src/routes/mistake-api.ts:insertMistake()` (PR-B #153 ship) 重复造轮子, 而且走的是 T10 退役的 mirror-first 路径。

## 目标

1. `mistake-photo.ts` vision confirm 改用 `insertMistake()` 直接调, 不再 INSERT mistakes + ensureMistakeCompatibility
2. `insertMistake()` 内部会: INSERT mistakes mirror (满足 mistake_photo_confirmations FK) + INSERT mistake_cases + learning_attempts (original) + correction_obligations (open) + appendLearningAttemptSourceEvent
3. 只在外面 INSERT mistake_photo_confirmations 一次
4. 删 `import { ensureMistakeCompatibility } from "../db-migrate.js"`

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| V-1 | confirm vision → 1 mistake_cases + 1 learning_attempts (original) + 1 correction_obligations (open) | 现有 mistake-photo.test.ts 扩 |
| V-2 | 重复 confirm 同一 draft (idempotent retry) → 同 caseId, 不新建 case | 双 confirm |
| V-3 | source_event 走 closure loop 路径 (record_id = `case:...`, payload submittedAnswer/expectedAnswer) | source_events 表 |
| V-4 | mistake_photo_confirmations FK 仍满足 (mistake_id 引用 mistakes mirror) | confirmations 表 |
| V-5 | explicit_correction (parent edited) → 写 closure loop (separate case by problem text) | 改字后 confirm |

## Files

- `server/src/routes/mistake-photo.ts` — 改 confirm 路径
- `server/src/mistake-photo.test.ts` — 5 case 覆盖
- `server/src/mistake-api.ts` — 不改, insertMistake 已 ship

## 跟其他 ticket 关系

- 跟 PR #184 (mcp-server log_mistake) 配套, 同一个原则: closure loop 是 source of truth, compat bridge 退役
- 不依赖 #165 (PR-D v2.4) — 这次只动 vision path 的写入逻辑, mistakes mirror 还在 (给 mistake_photo_confirmations FK 兜底)
- #165 ship 后, vision path 可以再删 mirror 行 (本 PR 留 mirror)

## Verification

- 73+ server tests pass
- typecheck + oxlint clean
- Live: 启 3002, simulate vision confirm via curl, 查 3 张 closure loop 表

# T10 Mistakes Deprecation (SB124 #134)

> 收口删除式错题生命周期。closure loop (mistake_cases +
> correction_obligations + review_schedules) 已经是 source of
> truth，mistakes table 降级为 read-only mirror。

## Endpoint 410 已回滚（重要更新）

T10 最初把两个旧 game endpoint 改成 410-only stub + `X-Sunset` header。
**该方案已回滚**：唯一的生产客户端（candy-math-island、
multiplication-drill）仍在调用这两个 endpoint，且其错误处理在非
2xx 时静默丢弃队列数据 —— sunset window 没有保护任何人，反而把每
一条游戏错题和订正记录全部丢掉了。

现在这两个 endpoint 是**长期存在的 compat adapter**：

| Endpoint | 行为 |
|---|---|
| `POST /api/game/mistake` | 适配器，委托 `insertMistake()`（source 固定为 `game`）。201 `{id, caseId, created:true}` / 200 `{id, caseId, created:false}`（dedupe 命中）/ 400 |
| `POST /api/game/mistake-review` | 适配器，委托 `recordCorrectionAttempt()`（`server/src/attempt-recorder.ts`，从 handleAttempt 抽取）。body `{childId?, results:[{mistakeId, correct, userAnswer?}]}`；通过 `mistake_cases.original_mistake_id` 解析 case，校验 child，记录 correction attempt（correct=true 时 verify obligation + 删 legacy mirror）。body 合法时永远 200，逐条返回 `{mistakeId, status: "recorded"\|"skipped"}`（客户端遇非 2xx 会丢整个队列，单条坏数据不能拖垮整批）；仅顶层 body 畸形才 400 |

旧的 `reviewed_count` CAS + 3-cascade-delete 语义**没有**恢复——那个
概念已被 closure loop 取代（且 `correction_obligations.reviewed_count`
列已物理删除）。

## mistakes mirror table 弃用（不受影响，仍然有效）

schema 层面的弃用保持不变（PR-D #159–#165）：

- `mistakes` table 有 `is_archived` 列；旧 row 标 1（历史 mirror），
  新写路径 (`insertMistake`) 写 0 (active)
- `mistakes` 只是 thin mirror，dedupe 和读路径都走 `mistake_cases`
- 未来仍可在客户端全部迁移后 DROP `mistakes` table（不属于本 task）

## Read-only 历史访问

`/api/mistake/:id` (server 内部用 + 调试) 返 archived mistake row 完整
raw data。closure-loop 读者不应走这条路 —— mistake_cases 才是 source。

## Files

- `server/src/routes/mistake-api.ts` — 两个 compat adapter + `insertMistake()`
- `server/src/attempt-recorder.ts` — `recordCorrectionAttempt()`（handleAttempt
  的 post-validation 核心，多写包裹在单个 `db.transaction` 里）
- `server/src/routes/capture.ts` — handleAttempt 委托 recordCorrectionAttempt
- `server/src/mistake-api.test.ts` / `server/src/mistake-review.test.ts` /
  `server/src/game-api.test.ts` / `server/src/closure-loop-regression.test.ts`
  — adapter 行为 + 端到端回归测试
- `server/src/archived-mistake.ts` — `readArchivedMistake`（诊断用）

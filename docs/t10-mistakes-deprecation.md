# T10 Mistakes Deprecation (SB124 #134)

> 收口删除式错题生命周期。closure loop (mistake_cases +
> correction_obligations + review_schedules) 已经是 source of
> truth，mistakes table 降级为 read-only mirror。

## Scope (first slice)

只做 server 端 deprecate + 历史 archive + 完整回归，**不做**：
- 客户端 candy-math-island 改用新 endpoint (separate v0.5.x task)
- mistakes table 完全 DROP (保留 schema 以支持旧 client + 历史 read)
- 旧 `/api/game/mistake` redirect 到 `/api/capture/manual` (走 410 + deprecation header)
- Source Event feed emit "old path retired" 事件

## Schema

`mistakes` table 加 `is_archived` 列：
- `ALTER TABLE mistakes ADD COLUMN is_archived INTEGER NOT NULL DEFAULT 0`
- 一次性 backfill: 旧 row 全部标 `is_archived=1` (提示"已是历史 mirror，不该被新路径写")
- 新写路径 (`insertMistake` via closure loop) 写 0 (active)

## Endpoint 收口

| 旧 endpoint | 新行为 |
|---|---|
| `POST /api/game/mistake` | **410 Gone** + `X-Sunset: 2026-12-31` + JSON `{ error, replacement: "/api/capture/manual" }` |
| `POST /api/game/mistake-review` | **410 Gone** + `X-Sunset: 2026-12-31` + JSON `{ error, replacement: "/api/capture/case/:caseId/attempt" }` |

理由: 旧 endpoint 走 reviewed_count 旧 contract (T3 cascade delete)，新路径是 closure loop (T1-T5)。Client 迁完可以删 endpoint。

## Read-only 历史访问

`/api/mistake/:id` (新 endpoint, server 内部用 + 调试) 返 archived mistake row 完整 raw data。 
- 不动 closure loop (返 0 row 也行 — mistake_cases 才是 source)
- 调试用：诊断老 row 还能不能读、closure loop 是不是 mirror 完整

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| **T10-1** | db-migrate 加 `mistakes.is_archived` + 旧 row 标 1 | schema introspection + UPDATE count |
| **T10-2** | pure `auditFile(filePath, content)` 扫单文件 + 报所有 reviewed_count 引用 | unit test (3 case) |
| **T10-3a** | 旧 `/api/game/mistake` 返 410 + replacement path | supertest |
| **T10-3b** | 旧 `/api/game/mistake-review` 返 410 + replacement path | supertest |
| **T10-4** | 完整回归: capture / game / mistake / photo / review endpoints 跑通 | supertest 矩阵 |
| **T10-5** | `readArchivedMistake` 读 archived row 返 raw 字段 | DB seed + helper call |

## Files

- `server/src/db-migrate.ts` — ALTER mistakes + is_archived + backfill
- `server/src/audit-reviewed-count.ts` (new) — pure audit
- `server/src/audit-reviewed-count.test.ts` (new) — T10-2
- `server/src/archived-mistake.ts` (new) — pure readArchivedMistake
- `server/src/archived-mistake.test.ts` (new) — T10-5
- `server/src/routes/mistake-api.ts` — 2 endpoint 改 410
- `server/src/mistake-api.test.ts` — 新 410 test (T10-3) + 旧测试更新
- `server/src/closure-loop-regression.test.ts` (new) — 端点矩阵 (T10-4)

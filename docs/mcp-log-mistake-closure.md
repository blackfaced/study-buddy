# MCP log_mistake 切到 closure loop (issue #166 镜像)

> 修 mcp-server 的 `log_mistake` tool, 跟 T10 之后的 server 端 closure loop
> 对齐: 不再直接写 `mistakes` mirror + `ensureMistakeCompatibility`, 改走
> server `insertMistake()` 完整路径。

## 现状 (8/28 验证)

`mcp-server/src/tools.ts` `log_mistake` 实现:
- 直接 `INSERT INTO mistakes (...)` + `ensureMistakeCompatibility(...)`
- inputSchema required: `[sessionId, subject, problem, errorType]`
- 缺 `userAnswer` / `correctAnswer` (T03 #127 contract 必需)
- 写的是 mirror 表 (T10 退役), 不走 closure loop
- 跟 T10 之后 server 端 `/api/capture/manual` (走 `insertMistake()`) 不一致

## 目标 (Path A 第一 slice)

1. `log_mistake` inputSchema 加 `userAnswer` + `correctAnswer` (required)
2. 实现切到 `insertMistake(db, { childId, problem, userAnswer, correctAnswer, errorType, source: "study-buddy", subject })`
3. 行为对齐 server 端: dedupe by (child_id, problem, source), 重复时返同 caseId
4. source_event 走 closure loop 路径 (不再用 mcp-server 自己的 `appendMcpMistakeSourceEvent`)
5. mcp-server 端删除 `ensureMistakeCompatibility` import (T10 之后已 dead)

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| M-1 | log_mistake 必填 userAnswer / correctAnswer, 缺一返 400 | handleTool 返 isError |
| M-2 | 新 (child, problem) → 写 closure loop (mistake_cases + learning_attempts original + correction_obligations open) | handleTool 后 SELECT 3 张表 |
| M-3 | dedupe: 重复 (child, problem, source='study-buddy') → 返同 caseId, 不新建 case | handleTool 2 次, 比 caseId |
| M-4 | source_event 走 closure loop 路径 (subject / problem / mistakeType 在 payload) | handleTool 后 SELECT source_events |
| M-5 | mcp-server 端不再写 mistakes 表 (mirror), 也不再调 ensureMistakeCompatibility | SELECT mistakes, 应为空 |

## Files

- `mcp-server/src/tools.ts` — inputSchema + handleTool case "log_mistake" 切到 insertMistake
- `mcp-server/src/tools.test.ts` — 5 case 覆盖 (新)
- `mcp-server/src/db.ts` — 删 ensureMistakeCompatibility export (如果 dead)
- (server/src 不改, server 的 insertMistake 已经存在)

## 跟其他 ticket 的关系

- 解锁 **Mavis 路径 A 整体**: log_mistake 走 closure loop 后, Mavis 端可以放心调
- 不依赖 #165 (PR-D v2.4) — 这次只动 mcp-server, mistakes mirror 还在 (T10 没 drop)
- 是 #166 (vision path insertMistake) 的镜像工作 — 同一个原则: closure loop 写源, compat bridge 退役

## Verification

- mcp-server `vitest run` 全过
- typecheck + oxlint clean
- Live: 启 study-buddy, 起 mcp-server stdio, 通过 MCP 调 log_mistake, 查 3 张表 + source_events

# T09 Parent Summary (SB124 #133)

> 把原始错误、订正尝试、巩固尝试、延迟回放结果作为独立
> Source Record 发布到 Source Event feed，并生成受限的家长错题
> 摘要（含 6 统计 + 反复出现的 Error Observations 聚合）。
> Feed/报告/日志不含 raw chat/image/OCR reasoning/凭证/直接身份。

## Scope (first slice)

只做家长摘要 aggregation + endpoint + 安全检查，**不做**：
- 写新 Source Event（已有 PR #10 写错题相关 source_events）
- 跨孩子的家长视角
- 推送（飞书/微信/MN）— 是输出层
- 时间范围筛选（v0.1 返 all-time summary）

## 6 统计

- **newMistakes** (since last summary? — v0.1 简化为 all-time openedAt > now-30d)  — Mistake Cases opened in the last 30 days
- **pendingReview** — Mistake Cases with status='open' obligation AND reviewed_count < 3
- **alreadyCorrected** — Mistake Cases with status='verified' obligation
- **pendingReplay** — review_schedules with completed_at IS NULL AND scheduled_at <= now (i.e. ready / overdue)
- **reopened** — review_schedules with completed_is_correct = 0 AND reopened_count > 0
- **evidenceGaps** — Mistake Cases opened in last 30d with no learning_attempts (i.e. never re-solved)

## Error Observations 聚合

按 `mc.error_type` 分组，过滤掉 null/empty，只返 `count >= 2` 的（避免把孤立的一次性错误当 pattern）。每个 entry 包含：
- `errorType: string`
- `count: number` (cases with that error_type)
- `recentCaseIds: string[]` (最近 3 个 caseId 用于 drill-down)

## 端点

`GET /api/capture/parent-summary?childId=default`

Response:
```json
{
  "childId": "default",
  "generatedAt": 1234567890,
  "stats": {
    "newMistakes": 4,
    "pendingReview": 2,
    "alreadyCorrected": 7,
    "pendingReplay": 1,
    "reopened": 0,
    "evidenceGaps": 1
  },
  "recurringErrorObservations": [
    {"errorType": "borrow", "count": 3, "recentCaseIds": ["case:abc", "case:def"]}
  ]
}
```

## 安全约束 (test 必须验)

Response **不能**含以下字段：
- `vision_input`, `vision_reasoning`, `image_path`
- `raw_*`, `*_raw`
- chat turn text, OCR text
- BUDDY_PIN, INTEGRATION_API_TOKEN, paired_devices 任何字段

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| **T09-1a** | pure `aggregateParentSummary(db, childId)` 返 6 统计对 | seed 5 cases 不同状态, 跑聚合, 验 count |
| **T09-1b** | errorType 聚合：borrow × 3 + compute × 1 → 只返 borrow (count >= 2) | DB seed |
| **T09-2** | GET /api/capture/parent-summary 返完整 shape | supertest |
| **T09-3** | 响应不含 vision_input / image_path / raw / chat 等敏感字段 | supertest + 字符串搜索 |
| **T09-4** | 跨 child 隔离：bob 的数据不进 default summary | supertest + 2 child seed |
| **T09-5** | reopened + pendingReplay 联动：fail 一次 → reopened_count++, 仍然在 pendingReplay 列表（如果 scheduled_at <= now） | workflow 验证 + summary |

## Files

- `server/src/parent-summary.ts` (new) — pure aggregateParentSummary
- `server/src/parent-summary.test.ts` (new) — T09-1
- `server/src/routes/capture.ts` — 1 endpoint + 安全 check
- `server/src/capture-parent-summary.test.ts` (new) — T09-2/3/4/5

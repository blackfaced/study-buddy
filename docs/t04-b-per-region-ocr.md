# T04-B Per-Region OCR (SB124 #128 PR-B)

> v0.5 page-photo 流程的 per-region OCR 步骤。
> T04-A (PR #171) 已经把 layout analysis 跑通：draf 写进
> `mistake_photo_page_drafts`，含 `image_bytes` + `layout_regions_json`。
> T04-B 接在它后面：拿 draft 切每个 region，调 vision 读题，
> 结果写到新表 `mistake_photo_candidates`。

## Scope (first slice)

只做"per-region OCR → candidates 表"这一段，**不做**：
- 确认/丢弃 UX（T04-C 负责）
- 客户端 UI（T04-D 负责）
- candidates → mistake_cases 的最终写入（T04-C 一起做）

## Acceptance criteria

- 新表 `mistake_photo_candidates` 通过 db-migrate 创建（fresh + legacy DB 都走 ALTER 加列）
- `cropRegion(imageBytes, bbox, extension)` 是 pure 函数：拿 image bytes + normalized bbox (0-1) 切出 region，返回 cropped bytes (jpeg)
- `runRegionOcr(draft, visionClient, db)` 是 workflow：取 draft 的 image + regions，循环 crop + analyzeMistakeImage，INSERT candidate rows
- `POST /api/capture/page-photo-draft/:draftId/regions` 触发 OCR（device+session auth 跟 T04-A 一致）
- 返回 `{ candidates: [{ regionIndex, subject, problem, userAnswer, correctAnswer, errorType, confidence, visionModel }] }`

## TDD test plan (5 case first slice)

| Test | 验什么 | 怎么验 |
|---|---|---|
| **T04B-1** | db-migrate 后 `mistake_photo_candidates` 表存在 + 列对 | fresh DB migrate + `SELECT * FROM sqlite_master WHERE name=?` |
| **T04B-2** | `cropRegion` pure：给定固定 input 返回固定 cropped bytes | mock image bytes (16x16 png 红) + bbox [0.5, 0.5, 1.0, 1.0] → bytes.length > 0 + 首字节是 jpeg (`ff d8 ff`) |
| **T04B-3** | `runRegionOcr` 把 N regions 全部 crop + insert candidate 行 | mock vision client 返回 2 个 region fake analysis → 1 个 draft + 2 regions → 2 row in candidates |
| **T04B-4** | OCR 失败一个 region 不影响其他（partial success） | mock vision throw on region 1 → 1 row in candidates (region 0) + 其他 0 |
| **T04B-5** | `POST /api/capture/page-photo-draft/:draftId/regions` 端到端 | supertest 200 + candidates 数组长度对 + 字段对 |

## TDD red→green order

1. T04B-1: db-migrate ALTER + CREATE TABLE → red（表不存在）→ green
2. T04B-2: pure `cropRegion` → red（fn 不存在）→ green
3. T04B-3: workflow `runRegionOcr` → red → green
4. T04B-4: partial failure test → red → green（要加 try/catch）
5. T04B-5: API 端到端 → red → green

## Out of scope (next slice / next PR)

- idempotency: `UNIQUE (draft_id, region_index)` + re-run skip existing（移到 T04-C 一起做，因为 UX 跟 confirm/discard 同步）
- auth 失败路径（cross-device 403 / cross-session 403 / wrong child 403）→ 已有 PR #170 review-workspace 的 coverage 模式可参考，留 T04-C
- candidates → mistake_cases promotion → T04-C

## Files touched

- `server/src/db-migrate.ts` — ALTER + CREATE TABLE mistake_photo_candidates
- `server/src/region-crop.ts` (new) — pure cropRegion
- `server/src/region-crop.test.ts` (new) — T04B-2
- `server/src/region-ocr-workflow.ts` (new) — runRegionOcr
- `server/src/region-ocr-workflow.test.ts` (new) — T04B-3, T04B-4
- `server/src/routes/page-photo-region.ts` (new) — POST endpoint
- `server/src/page-photo-region.test.ts` (new) — T04B-5 + T04B-1
- `server/src/app.ts` — register routes

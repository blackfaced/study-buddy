# #34b v0.5 — static expansion of errorType templates

## Context

v0.1 of #34b (shipped in #116) had 4 hand-written errorType
templates in `web/games/candy-math-island/explanations.js`:
`compute`, `carry`, `borrow`, `multiply`. Everything else fell
through to a `GENERIC_FALLBACK` "再仔细看看题目" card.

The real kid data (14 real mistakes, last 8 weeks) shows:
- 8 vision_pending (VLM hasn't classified the error yet)
- 2 borrow
- 2 compute
- 1 carry
- 1 审题 (read-the-question-wrong)
- 1 钟表 (clock question)
- 5 null (no errorType at all)

The 4 "core" types cover **5 of 14** real kid mistakes. The other
9 (64%) all show the generic fallback. v0.5 closes that gap by
adding 4 more hand-written entries covering the meta errorTypes
that were hitting the fallback most.

## Scope (v0.5 only)

Just the explanations map. No new endpoints, no LLM, no per-mistake
personalization. v0.5 is a 1-file content expansion that costs 0
LLM tokens and improves the user-visible explanation card for
~64% of real kid mistakes.

## What's in this slice

- `explanations.js`: add 4 new entries to EXPLANATIONS:
  - `审题` — "看清题目" (read-the-question-wrong)
  - `钟表` — "钟表题" (clock question, hour/minute hands)
  - `应用题` — "应用题" (word problem, turn it into an equation)
  - `vision_pending` — "拍题确认" (VLM hasn't classified; nudge
    the kid to use the photo-confirm flow)
- `explanations.test.js`: extend the "has entries" + "returns own
  entry" tests to cover all 8, plus a spot-check that each new
  entry has distinct kid-friendly content (not aliasing the
  fallback).

## What's NOT in this slice (deferred)

- LLM-generated per-question explanations (v1.0)
- Server endpoint `/api/game/explanation` (no LLM dependency yet
  — there's nothing to serve that the client can't already load
  from the static module)
- Per-mistake personalization (would need LLM call per wrong
  answer; cost/latency not justified at this scale)
- i18n (English translation) — bilingual UI is a separate workstream

## v0.1 砍半 preserved

Still 0 LLM calls. Per-request cost is unchanged. The "v0.1 砍半"
principle (static templates over LLM) stays intact — v0.5 just
covers more ground with the same approach.

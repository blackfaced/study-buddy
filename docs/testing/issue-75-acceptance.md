# Issue #75 — home-Mac acceptance record

Date: 2026-09-12 (Asia/Shanghai). Scope: make the existing three-page shared-app
verifier reproducible; exercise AI Workbench's `setup-aiwb` on a real project.
This is not a full `implement-batch` or live Study Buddy acceptance.

Candidate: `codex/issue-75-aiwb-trial`, based on
`d6de0dd8679fef4391f6155da919e3c6f2dedac3`. The local results below include the
uncommitted #75 diff subsequently submitted for review; use the associated PR's
head and CI run for immutable candidate identity.

Environment: home Mac, Node 22.23.1, Playwright 1.63.0, managed WebKit. Root/server
dependency symlinks were removed and both packages installed from their lockfiles;
`HUSKY=0` suppressed hook installation during this dependency-only check.
`npx playwright install webkit` completed using the existing managed browser cache.
No `.env` or live credentials were copied. Linux/browser download from an empty
cache is covered by CI, not claimed from this local run.

## Acceptance evidence

| Requirement                             | Evidence                                                                                                                                                             |
| --------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Fresh-checkout setup runs the verifier  | Fresh root + server `npm ci`, WebKit install check, then `npm run test:shared-app`: 4/4 pass. Setup documented in [integration.md](integration.md).                  |
| Command listed alongside relevant suite | Root `test:shared-app` script; integration guide lists it beside the isolated writing test and separates live `test:e2e`. Deployment guide links to it.              |
| Deterministic test or CI coverage       | The test invokes the real CLI against an ephemeral loopback fixture with this checkout's three real pages. CI runs the same package command after installing WebKit. |

Regression sequence: the supported package command first failed with “Missing
script: test:shared-app”. After adding it and portable WebKit, the three-page check
passed. The invalid-target regression then failed with a generic browser error;
explicit HTTP(S)-origin validation made it pass. Additional checks cover absent
targets (no implicit production URL) and a deliberately missing shared helper
(nonzero exit, not timeout, no success marker). The latter corrupts only the
fixture response, never source files or live service data.

## Broader validation and limits

- Shared verifier + existing isolated writing layout: **11/11 pass**.
- MCP suite: **52/52 pass**.
- Client/shared/reminder logic tests: **314/314 pass**, run separately because the
  first server command stopped before its chained client suites.
- Both package typechecks pass. Server lint exits 0 with three existing warnings
  in untouched test files.
- First default-parallel server run: **836/837 pass**; namespace-isolation test
  expected 200 but received 401. Its file alone then passed **12/12**.
- Second default-parallel candidate run: **836/837 pass**, a different failure:
  `integration-session-source.test.ts`, withdrawal retry, `read ECONNRESET`.
- Untouched base `d6de0dd` in a separate worktree: default server **837/837 pass**,
  followed by all **314** client/shared/reminder checks passing.
- Candidate diagnostic with `vitest run --fileParallelism=false`: **837/837 pass**.
  This one-variable contrast does not replace the default parallel gate or prove
  why either intermittent failure occurred.
- The candidate has no changes under `server/`, `web/`, `bin/`, or `mcp-server/`.
  These observations show intermittent failures, not a proven root cause. Do not
  report the default local server suite as consistently green. Track new evidence
  under [#187](https://github.com/blackfaced/study-buddy/issues/187); no retries or
  unrelated server fixes were added to this patch.

Raw local logs are retained under the repository's Git common directory,
`aiwb-trial-issue75-20260912/`: `server-tests.log`,
`candidate-server-tests-second.log`, `baseline-server-tests.log`,
`quiz-context-isolated.log`, `mcp-tests.log`, `client-tests.log`, and
`browser-tests.log`, plus `candidate-server-serial.log`. They contain synthetic fixture data, not child production
records. The PR and CI provide the shareable evidence.

## Isolation and remaining acceptance

All new fixture servers and verifier browsers exited, including the negative
test. Worktrees, installed dependencies, browser cache, and diagnostic logs are
retained for inspection. Production 3000, shared test 3002, their data, and the
stale launchd configuration were not changed or restarted. The main checkout
was not updated, because it serves shared instances.

The isolated test verifies script loading and shared helper behavior, with API
responses and speech output simulated. iPad hardware, HTTPS trust, camera/audio,
LLM calls, Feishu delivery, and real learning workflows remain **UNVERIFIED** by
this trial. #222 was inspected but not implemented; this trial completes one
small issue, not two.

## Skill experience

`setup-aiwb` successfully turned scattered package/CI/deployment knowledge into a
reusable test guide and exposed an unsafe implicit production target. It did not
require a global runtime or the retired orchestrator. Study Buddy's existing TDD
and parallel Standards/Spec review remain the delivery workflow.

Follow-up improvements for AI Workbench: document this lightweight single-issue
path beside the explicit batch workflow, and show separate evidence levels for
installed, natively discoverable, executed, isolated-tested, and live-accepted.
Keep these as opt-in guidance; do not claim that this trial validated multi-issue
integration or execution in another client.

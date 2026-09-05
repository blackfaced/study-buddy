# study-buddy — Agent Configuration

## Project overview

Personal learning companion for a kid, deployed on a single Mac mini (M4, macOS 26.4).
The repo holds a tiny self-hosted stack: a Node.js MCP server (agent queries) and a Node.js HTTP server (browser/iPad client) sharing one SQLite file, plus a single-page web UI. v0.1 ships a chat-only MVP; v0.5 adds VLM-based homework help (photo → MiniMax-M3 vision → coaching); **v0.5b+ turns it into an application platform (hub)**: shared mistake ledger, apps registry, first hung app is 糖果口算岛 (Candy Math Island). Cadence: ship v0.1 first, iterate from real use. No gamification, no points, no badge noise in the kid-facing UI.

## Positioning (2026-08, issue #192)

This is a **parent-operated family learning-operations loop**, not a kid-facing AI companion: capture real wrong answers → correction → weekend review → bounded parent evidence. Kid-facing apps (games, writing) are execution surfaces inside the loop; the chat buddy is deprecated as a touchpoint (hidden by default via `BUDDY_CHAT_ENABLED=false`, PR #191). Success metric: real Mistake Cases closed per week, not kid engagement. Chat-improvement backlog items (OPT-S1~S8) are superseded.

## Repo layout

```
study-buddy/
├── mcp-server/      # Node.js + TypeScript MCP server (Mavis agent queries)
├── server/          # Node.js + TypeScript HTTP server (iPad/safari client)
├── web/             # static HTML (portal + chat + camera UI, served by server/)
│   └── games/       # hung apps (v0.5b+); first: candy-math-island/
├── data/            # SQLite (study.db) + logs/ + preserved legacy JSONL
├── bin/             # server control + guarded source-feed cutover scripts
└── docs/            # engineering skill docs + apps.md (platform architecture)
```

## Deploy

The HTTP server is managed by `bin/study-buddy-server.sh` (no system service manager required).

```bash
bin/study-buddy-server.sh start   # background-launch npm start, capture logs
bin/study-buddy-server.sh status  # PID + port + log line count
bin/study-buddy-server.sh logs    # tail -f data/logs/study-buddy-server.log
bin/study-buddy-server.sh stop    # SIGTERM → 5s → SIGKILL
```

Legacy JSONL is migration input only. Inventory it before a coordinated source-feed cutover:

```bash
bin/source-feed-cutover.sh inventory
bin/source-feed-cutover.sh enable
```

Server logs go to `data/logs/study-buddy-server.log` (5MB rotation, 3 generations kept). One JSON-meta line per request: `INFO request {"method":"GET","path":"/api/pair","status":200,"durationMs":0.4,...}`. Status → level mapping: 2xx/3xx → info, 4xx → warn, 5xx → error.

The mcp-server is a child of the mavis daemon (`mavis mcp add`); don't manage it from the script. See `docs/deploy.md` for the full reference, env vars, and a launchd plist for boot-time start.

### Two instances on the Mac mini (2026-09)

- **3000 = production.** Managed by `bin/study-buddy-server.sh`, DB at `data/study.db`. This is the one the kid's iPad uses.
- **3002 = test.** A second long-running `server/src/index.ts` process (`HTTPS_PORT=3002`, `HTTP_PORT=3003`, `STUDY_DB=data/test-runtime/study.db`) running from the same checkout. Test data goes to the separate test-runtime DB — never point it at `data/study.db`.
- Note: both serve the same working tree, so a code pull changes what 3002 serves too (after restart). Don't treat 3002 as a frozen version.

There is also a stale launchd plist `com.studybuddy.server` pointing at the old `/Users/mac/study-buddy` path — the real server is the script-managed one above; don't "fix" the plist by pointing it at the repo without checking with the user first.

## Platform architecture (v0.5b+)

study-buddy is a **hub**: one shared backend (HTTP server + mcp-server + SQLite) + multiple hung apps under `web/<app-dir>/`. The portal page (`web/index.html`) lists all `status: "ready"` apps; kid clicks one to enter.

- **Apps registry** (`server/src/app.ts → APPS` const) is the single source of truth. `GET /api/apps` returns it; the mcp-server tool `get_apps` fetches it via HTTP (with a static fallback when the HTTP server is down).
- **Shared mistake ledger**: every app writes through `server/src/capture-service.ts` (`insertMistake`) — one Mistake Case + open Correction Obligation + original Learning Attempt + Source Event per wrong answer (see `CONTEXT.md` for the vocabulary). `mistake_cases` is the source of truth; the legacy `mistakes` table is a thin mirror pending removal in PR-D (#159–#165). Legacy game clients use the compat adapters `POST /api/game/mistake*` (see `docs/t10-mistakes-deprecation.md`).
- **Two-way game sync** (game ↔ server) is in `server/src/game-sync.ts` + `web/games/<app>/...`. Auto-creates a session if none is active; syncs on `onload` / `pagehide` / `visibilitychange`.
- **External integration is provider-owned and loose-coupled**: eligible domain rows and immutable `source_events` commit in one SQLite transaction. Authenticated loopback APIs expose monotonic pages and bounded chat turns; consumers own cursors and delivery.
- **mcp-server db refactor** (`mcp-server/src/db.ts`): `initDb(path)` + `getDb()` + `db` Proxy so tests can use `:memory:` without touching the real file. `handleTool` is in `tools.ts` so tests don't trigger the stdio transport.

For the full platform design (data flow, code layout, "how to add a new app"), see **`docs/apps.md`**.

## Conventions

- **No gamification in v0.1.** No stars, badges, encouragement animations, progress bars, or focus timers visible to the kid. The HTTP server is allowed to log/compute scores, but nothing kid-facing should display them.
- **Apps are HTML under `web/<app-dir>/`.** No new monorepo workspace, no separate npm packages. Share backend code via HTTP endpoints, not via a shared `src/` TypeScript package (YAGNI).
- **Loose coupling for external services.** Write Study Buddy concepts to the transactional Source feed. Keep consumer credentials, acknowledgements, retries, and MemoryNexus concepts outside this repository's domain path.
- **Prefer integration with Mavis over standalone UIs.** Schedule reports via mavis cron; build interactive surfaces as Mavis skills / MCP tools; use the existing Mavis IM channel for parent notifications. Don't add a separate parent dashboard, email digest, or PWA shell unless the user asks.
- **Run minimal, iterate from real use.** Don't pre-build v0.5 (VLM photo help, etc.) until the user signals the v0.1 has settled. Same for v0.6+ — wait for v0.5b to be actually used.
- **Multi-process SQLite = WAL.** mcp-server (stdio) and server (HTTP) both read/write `data/study.db`; both open it with `journal_mode = WAL`. Schema changes must be applied to every process at startup (idempotent `ALTER ... ADD COLUMN` with try/catch).
- **Restart all DB-touching processes after a schema change.** server (HTTP), mcp-server (stdio), and any future workers all hold a long-lived connection. tsx does not hot-reload a daemon-held MCP stdio server.
- **HTTPS is local mkcert.** `mcp-server/server.cert` and `mcp-server/server.key` are self-signed for `mac-mini.local`; both are gitignored. Safari treats `*.local` as a secure context; Chrome does not — tell the user to use Safari or accept the Chrome flag.
- **iPad Safari page cache.** When the HTML is changed and re-deployed, iPad Safari may serve the old version from its bfcache. The server's `GET /` 302-redirects to a `?v=…` query string to force a fresh fetch. See `docs/deploy.md` for the pattern.
- **`BUDDY_CHAT_ENABLED=false` hides the /buddy/ chat UI.** Photo capture (拍错题) stays — it's the mistake ledger's main intake. Default (unset/empty/"true") keeps chat on. The server surfaces the flag via `GET /api/buddy/status` (`chatEnabled`); the buddy page hides the chat DOM (code stays, recoverable by flipping the env back) and the portal swaps the buddy entry copy to 拍错题. Photo-only mode also shows the parent-operated 文字描述 intake (`web/buddy/text-intake.js` → `POST /api/capture/organize` → preview → `POST /api/capture/manual`) and the 今日待订正 inbox; the standalone `/capture/` page is retired (its API routes stay).
- **TDD discipline: every change ships a test that fails without it.** New feature → write 3-5 unit test cases first (must include the actual user scenario), see them fail, then implement. Bug fix → write a regression test that reproduces the bug, see it fail, then fix. PR description should name the test(s) added and what they catch. Anti-examples: PR #116 (400-line client.js rewrite with no unit test) and PR #123 (ESM/CJS bug fix with no parse-style guard) — both shipped broken, only caught in real use. See **Client-side JS testing** below.
- **Worktree for every code change.** Never commit on the default branch. Branch first (`fix/...`, `feat/...`), open PR, rebase-merge. Symlink `server/node_modules` and `.env` from the main checkout to skip `npm ci` and keep env in one place.

### Client-side JS testing

Apps under `web/games/<app>/` ship browser ESM modules. Two test styles coexist:

- **Pure-logic unit tests** (Node 22 `node --test`, ESM `import`): colocated `*.test.js` next to the source. Run with `node web/games/<app>/<file>.test.js` or `find web/games -name "*.test.js" | xargs node --test`. Reference: `multiplication-drill/pick-gen.test.js` (10 cases), `candy-math-island/explanations.test.js` (8 cases).
- **Parse-check** for inline `<script>` blocks: `candy-math-island/parse-check.test.js` extracts the inline `<script>` body and feeds it to `new Function()` (classic-script mode, same await-in-non-async restrictions as a browser classic script). Catches the v0.8 #116 / #138 class of bug — `await` inside a non-async function aborts the whole inline script and the kid's button goes dead silently. Add a similar `parse-check.test.js` to any new app that uses an inline `<script>` for its main controller, and re-run it whenever that app's `index.html` changes.
- **Playwright e2e** (`e2e/*.test.js`, node:test + playwright, WebKit in an iPad profile): for bugs DOM-fake unit tests structurally can't see — a real HTMLCollection has no `.map` (the dead 开始练 button, #218), real script load order, actual visibility. Setup: `npx playwright install webkit chromium` (if the CDN is unreachable: `HTTPS_PROXY=http://127.0.0.1:7892 PLAYWRIGHT_DOWNLOAD_HOST=https://cdn.npmmirror.com/binaries/playwright npx playwright install ...`; on macOS 26 npmmirror lacks `webkit-mac-26-arm64.zip` — download the same build's `webkit-mac-15-arm64.zip`, unzip into `~/Library/Caches/ms-playwright/webkit-<rev>/`, touch `INSTALLATION_COMPLETE` inside). Run with `npm run test:e2e`. **E2E defaults to the 3002 test instance** (`E2E_BASE_URL` to override) so it never writes production data; it needs the test instance running (`bin/study-buddy-test-server.sh start`) and reads the buddy PIN from `.env` without printing it.

For all three: if the test only verifies the code shape (import syntax, syntax validity) and not behavior, it does not count as TDD coverage. Behavior tests need a real scenario — e.g. `explanations.test.js` has "GET_PENDING gets a non-empty body" because the kid sees a blank card otherwise.

### Implement / code-review workflow

Every code change follows the `implement` → `code-review` chain. Each step has a hard gate — do not skip.

1. **Agree seams first** (from `/tdd`). Name the public interfaces under test before writing any test. If the shape of the interface itself is in question, use `/codebase-design` to settle the vocabulary first. No test against an unconfirmed seam.
2. **TDD loop** (from `/tdd`):
   - Red — write the failing test. Run it, see the actual error.
   - Green — minimum code to pass. Run the test, see it green.
   - Vertical slices only: one test → one implementation → repeat. No bulk "all tests first, all impl after".
   - Refactor is **not** part of the red-green loop. It belongs to the review step.
3. **Run typecheck and tests as you go.** `npm run typecheck` per package you touch; `node --test` per client test file; `npm test` per server package. Run the full server + client suite once before opening the PR.
4. **Code-review** (from `/code-review`) **before committing**. Two parallel axes:
   - **Standards** — repo documented standards (this file, `CONTEXT.md`, `docs/adr/`) plus the Fowler smell baseline. Both run as sub-agents in parallel.
   - **Spec** — does the diff match the originating issue / spec? Catches scope creep and missing requirements.
   - Aggregate the two reports side by side. Do not merge or rerank — the two axes are deliberately separate. If either axis flags a hard issue, fix it before commit; judgement-call smells get a short note in the PR description.
5. **Commit only after both axes are clean.** One commit per logical change; defensive guards in a separate commit from the bug fix they protect, so a `git revert` on the fix doesn't also drop the guards. Anti-example: PR #138 had a clean SyntaxError fix in the same working tree as unrelated try/catch guards; the guards were dropped at commit time, and without `code-review` the working tree went into the PR as a single undifferentiated change.
6. **Push the branch and open the PR.** Wait for CI green, then rebase-merge.

**Triggers**: any time a code change is about to leave a worktree — whether bug fix, refactor, or new feature — this workflow applies. The only exception is docs-only / one-line typo fixes, where the smell baseline and Spec axis are both obviously a no-op.

## Agent skills

### Issue tracker

GitHub Issues at `https://github.com/blackfaced/study-buddy` via the `gh` CLI. External PRs (`CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE`) are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, all default names: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context layout: `CONTEXT.md` at root (glossary: Mistake Case, Learning Attempt, Correction Obligation, Closure Loop, Capture, Source Event) + `docs/adr/` (ADR-0001: photo capture paths stay unmerged until T04-D). Both are kept current by `/domain-modeling` as terms get resolved — see `docs/agents/domain.md`.

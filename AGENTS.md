# study-buddy — Agent Configuration

## Project overview

Personal learning companion for a kid, deployed on a single Mac mini (M4, macOS 26.4).
The repo holds a tiny self-hosted stack: a Node.js MCP server (agent queries) and a Node.js HTTP server (browser/iPad client) sharing one SQLite file, plus a single-page web UI. v0.1 ships a chat-only MVP; v0.5 adds VLM-based homework help (photo → MiniMax-M3 vision → coaching); **v0.5b+ turns it into an application platform (hub)**: shared mistake ledger, apps registry, first hung app is 糖果口算岛 (Candy Math Island). Cadence: ship v0.1 first, iterate from real use. No gamification, no points, no badge noise in the kid-facing UI.

## Repo layout

```
study-buddy/
├── mcp-server/      # Node.js + TypeScript MCP server (Mavis agent queries)
├── server/          # Node.js + TypeScript HTTP server (iPad/safari client)
├── web/             # static HTML (portal + chat + camera UI, served by server/)
│   └── games/       # hung apps (v0.5b+); first: candy-math-island/
├── data/            # SQLite (study.db) + logs/ + nexus-outbox.jsonl
├── bin/             # process control scripts (study-buddy-server.sh, nexus-worker.sh)
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

The Memory Nexus outbox worker is managed by `bin/nexus-worker.sh` (same shape):

```bash
bin/nexus-worker.sh start   # background drain loop (default 30s poll)
bin/nexus-worker.sh once    # single drain pass (suitable for mavis cron)
bin/nexus-worker.sh logs    # tail -f data/logs/nexus-worker.log
bin/nexus-worker.sh stop    # SIGTERM → 5s → SIGKILL
```

Logs go to `data/logs/study-buddy-server.log` and `data/logs/nexus-worker.log` (5MB rotation, 3 generations kept). One JSON-meta line per request: `INFO request {"method":"GET","path":"/api/pair","status":200,"durationMs":0.4,...}`. Status → level mapping: 2xx/3xx → info, 4xx → warn, 5xx → error.

The mcp-server is a child of the mavis daemon (`mavis mcp add`); don't manage it from the script. See `docs/deploy.md` for the full reference, env vars, and a launchd plist for boot-time start.

## Platform architecture (v0.5b+)

study-buddy is a **hub**: one shared backend (HTTP server + mcp-server + SQLite) + multiple hung apps under `web/<app-dir>/`. The portal page (`web/index.html`) lists all `status: "ready"` apps; kid clicks one to enter.

- **Apps registry** (`server/src/app.ts → APPS` const) is the single source of truth. `GET /api/apps` returns it; the mcp-server tool `get_apps` fetches it via HTTP (with a static fallback when the HTTP server is down).
- **Shared mistake ledger**: the `mistakes` table has a `source` column (`study-buddy` / `vision` / `game`) so all apps contribute to the same wrong-answer pool that `get_weak_topics` queries.
- **Two-way game sync** (game ↔ server) is in `server/src/game-sync.ts` + `web/games/<app>/...`. Auto-creates a session if none is active; syncs on `onload` / `pagehide` / `visibilitychange`.
- **Memory Nexus integration is loose-coupled**: study-buddy appends to `data/nexus-outbox.jsonl`, a separate `nexus-worker` process drains it. study-buddy never blocks on Nexus.
- **mcp-server db refactor** (`mcp-server/src/db.ts`): `initDb(path)` + `getDb()` + `db` Proxy so tests can use `:memory:` without touching the real file. `handleTool` is in `tools.ts` so tests don't trigger the stdio transport.

For the full platform design (data flow, code layout, "how to add a new app"), see **`docs/apps.md`**.

## Conventions

- **No gamification in v0.1.** No stars, badges, encouragement animations, progress bars, or focus timers visible to the kid. The HTTP server is allowed to log/compute scores, but nothing kid-facing should display them.
- **Apps are HTML under `web/<app-dir>/`.** No new monorepo workspace, no separate npm packages. Share backend code via HTTP endpoints, not via a shared `src/` TypeScript package (YAGNI).
- **Loose coupling for external services.** study-buddy writes to an outbox file; a separate worker drains it. The main path never blocks on Memory Nexus (or any future external service).
- **Prefer integration with Mavis over standalone UIs.** Schedule reports via mavis cron; build interactive surfaces as Mavis skills / MCP tools; use the existing Mavis IM channel for parent notifications. Don't add a separate parent dashboard, email digest, or PWA shell unless the user asks.
- **Run minimal, iterate from real use.** Don't pre-build v0.5 (VLM photo help, etc.) until the user signals the v0.1 has settled. Same for v0.6+ — wait for v0.5b to be actually used.
- **Multi-process SQLite = WAL.** mcp-server (stdio) and server (HTTP) both read/write `data/study.db`; both open it with `journal_mode = WAL`. Schema changes must be applied to every process at startup (idempotent `ALTER ... ADD COLUMN` with try/catch).
- **Restart all DB-touching processes after a schema change.** server (HTTP), mcp-server (stdio), and any future workers all hold a long-lived connection. tsx does not hot-reload a daemon-held MCP stdio server.
- **HTTPS is local mkcert.** `mcp-server/server.cert` and `mcp-server/server.key` are self-signed for `mac-mini.local`; both are gitignored. Safari treats `*.local` as a secure context; Chrome does not — tell the user to use Safari or accept the Chrome flag.
- **iPad Safari page cache.** When the HTML is changed and re-deployed, iPad Safari may serve the old version from its bfcache. The server's `GET /` 302-redirects to a `?v=…` query string to force a fresh fetch. See `docs/deploy.md` for the pattern.

## Agent skills

### Issue tracker

GitHub Issues at `https://github.com/blackfaced/study-buddy` via the `gh` CLI. External PRs (`CONTRIBUTOR` / `FIRST_TIME_CONTRIBUTOR` / `NONE`) are also a triage surface. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, all default names: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at root + `docs/adr/`. See `docs/agents/domain.md`.

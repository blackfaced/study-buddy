# study-buddy — Agent Configuration

## Project overview

Personal learning companion for a kid, deployed on a single Mac mini (M4, macOS 26.4).
The repo holds a tiny self-hosted stack: a Node.js MCP server (agent queries) and a Node.js HTTP server (browser/iPad client) sharing one SQLite file, plus a single-page web UI. v0.1 ships a chat-only MVP; later versions add VLM-based homework help. Cadence: ship v0.1 first, iterate from real use. No gamification, no points, no badge noise.

## Repo layout

```
study-buddy/
├── mcp-server/      # Node.js + TypeScript MCP server (Mavis agent queries)
├── server/          # Node.js + TypeScript HTTP server (iPad/safari client)
├── web/             # static HTML (camera + chat UI, served by server/)
├── data/            # SQLite (study.db) + logs/ — shared between mcp-server and server
├── bin/             # process control scripts (study-buddy-server.sh start|stop|…)
└── docs/            # engineering skill docs (issue tracker / triage / domain / deploy)
```

## Deploy

The HTTP server is managed by `bin/study-buddy-server.sh` (no system service manager required).

```bash
bin/study-buddy-server.sh start   # background-launch npm start, capture logs
bin/study-buddy-server.sh status  # PID + port + log line count
bin/study-buddy-server.sh logs    # tail -f data/logs/study-buddy-server.log
bin/study-buddy-server.sh stop    # SIGTERM → 5s → SIGKILL
```

Logs go to `data/logs/study-buddy-server.log` (5MB rotation, 3 generations kept). One JSON-meta line per request: `INFO request {"method":"GET","path":"/api/pair","status":200,"durationMs":0.4,...}`. Status → level mapping: 2xx/3xx → info, 4xx → warn, 5xx → error.

The mcp-server is a child of the mavis daemon (`mavis mcp add`); don't manage it from the script. See `docs/deploy.md` for the full reference, env vars, and a launchd plist for boot-time start.

## Conventions

- **No gamification in v0.1.** No stars, badges, encouragement animations, progress bars, or focus timers visible to the kid. The HTTP server is allowed to log/compute scores, but nothing kid-facing should display them.
- **Prefer integration with Mavis over standalone UIs.** Schedule reports via mavis cron; build interactive surfaces as Mavis skills / MCP tools; use the existing Mavis IM channel for parent notifications. Don't add a separate parent dashboard, email digest, or PWA shell unless the user asks.
- **Run v0.1 minimal, iterate from real use.** Don't pre-build v0.5 (VLM photo help, etc.) until the user signals the v0.1 has settled.
- **Multi-process SQLite = WAL.** mcp-server (stdio) and server (HTTP) both read/write `data/study.db`; both open it with `journal_mode = WAL`. Schema changes must be applied to every process at startup (idempotent `ALTER ... ADD COLUMN` with try/catch).
- **Restart both DB-touching processes after a schema change.** tsx does not hot-reload a daemon-held MCP stdio server.
- **HTTPS is local mkcert.** `mcp-server/server.cert` and `mcp-server/server.key` are self-signed for `mac-mini.local`; both are gitignored. Safari treats `*.local` as a secure context; Chrome does not — tell the user to use Safari or accept the Chrome flag.

## Agent skills

### Issue tracker

Local markdown at `.scratch/<feature>/` (gitignored). Each feature gets `PRD.md` + `issues/NN-<slug>.md`. No GitHub/GitLab. See `docs/agents/issue-tracker.md`.

### Triage labels

Five canonical roles, all default names: `needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at root + `docs/adr/`. See `docs/agents/domain.md`.

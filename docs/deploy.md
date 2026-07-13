# Deploying study-buddy

A small, opinionated guide to running the study-buddy HTTP server on the Mac mini in a way that survives reboots, restarts on crash, and doesn't drown you in log files.

## Components

| Process | What it does | How it's managed |
|---|---|---|
| `mcp-server/` | stdio MCP server, queried by Mavis | mavis daemon (`mavis mcp add`) — don't manage manually |
| `server/` | Express HTTP server, port 3000 (HTTPS) / 3001 (HTTP redirect) | `bin/study-buddy-server.sh` |
| `web/index.html` | static SPA, served by `server/` | bundled with the server |
| `data/study.db` | shared SQLite, WAL mode | opened by both processes |
| `data/logs/study-buddy-server.log` | access + event log | rotated at 5MB, keeps 3 generations |

The mcp-server is a child of mavis, not this script. The script only handles the HTTP server.

## Quick start

```bash
cd ~/study-buddy
npm install --prefix server
bin/study-buddy-server.sh start
bin/study-buddy-server.sh status
bin/study-buddy-server.sh logs
```

## Commands

| Command | What it does |
|---|---|
| `start` | background-launches `npm start` from `server/`. Writes PID to `data/study-buddy-server.pid`. Captures stdout/stderr to `data/logs/study-buddy-server.log`. Waits up to 10s for the port to start listening. |
| `stop` | sends SIGTERM, waits 5s, then SIGKILL. Removes the PID file. |
| `restart` | stop + start |
| `status` | prints PID, whether the port is listening, log line count. Exit 2 if not running. |
| `logs [-n N]` | `tail -f` the log file. `logs --error` / `--warn` / `--info` / `--debug` filter by level. |
| `rotate` | reports the rotation threshold and current files (rotation is automatic). |
| `env` | prints the resolved paths + .env with secrets masked. |

## Log format

One line per entry, ISO 8601 timestamp + uppercase level tag + message + JSON meta (if any):

```
2026-07-12T16:23:58.848Z INFO  request {"method":"GET","path":"/api/pair","status":200,"durationMs":0.4,"contentLength":93,"ip":"::ffff:127.0.0.1"}
2026-07-12T16:24:01.001Z WARN  request {"method":"GET","path":"/api/missing","status":404,"durationMs":0.1,...}
2026-07-12T16:24:05.123Z INFO  session started {"sessionId":"...","childId":"default","subject":"math"}
2026-07-12T16:24:10.500Z ERROR frame sharp error {"error":"unsupported image format"}
```

Access log is the `request` line — emitted once per response with method, path, status, durationMs, contentLength, ip. Status → level mapping:

- 2xx / 3xx → `info`
- 4xx → `warn`
- 5xx → `error`

Event logs are domain-specific (`session started`, `frame sharp error`, etc.) and use whatever level matches severity.

## Environment variables

| Var | Default | Notes |
|---|---|---|
| `HTTPS_PORT` | `3000` | primary port. Surfaced in `/api/pair.serverUrl`. |
| `HTTP_PORT` | `3001` | HTTP→HTTPS redirect listener. |
| `STUDY_DB` | `data/study.db` | absolute path preferred. |
| `SSL_KEY` / `SSL_CERT` | `server.key` / `server.cert` (project root) | self-signed. If either is missing, the server falls back to plain HTTP. |
| `MINIMAX_API_KEY` | — | required for `/api/mistake-photo`. Without it, the endpoint returns 503. |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |
| `LOG_DIR` | `data/logs` | |
| `LOG_FILE` | `$LOG_DIR/study-buddy-server.log` | |
| `LOG_MAX_BYTES` | `5242880` (5MB) | rotation threshold |

## Upgrading to a system service (when you need it)

The shell script is fine for "I'm at the machine and the daemon restarts on reboot because the Mac wakes me." If you want true boot-time start without login, convert to a launchd LaunchAgent:

```bash
# Example: a minimal plist at ~/Library/LaunchAgents/com.study-buddy.server.plist
cat > ~/Library/LaunchAgents/com.study-buddy.server.plist <<'PLIST'
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.study-buddy.server</string>
  <key>ProgramArguments</key>
  <array>
    <string>/Users/mac/study-buddy/bin/study-buddy-server.sh</string>
    <string>start</string>
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>/Users/mac/study-buddy/data/logs/launchd.out.log</string>
  <key>StandardErrorPath</key><string>/Users/mac/study-buddy/data/logs/launchd.err.log</string>
  <key>WorkingDirectory</key><string>/Users/mac/study-buddy</string>
</dict>
</plist>
PLIST

launchctl load -w ~/Library/LaunchAgents/com.study-buddy.server.plist
launchctl list | grep study-buddy
```

`KeepAlive=true` gives you crash-restart. `RunAtLoad=true` gives you boot-start. The launchd-managed wrapper would call our `start` subcommand (which is idempotent — exits 3 if already running).

## Troubleshooting

- **"already running" but `status` says not running** — the PID file is stale (process died). `rm data/study-buddy-server.pid` and try again.
- **"port 3000 not listening"** — usually a cert path issue. Check `bin/study-buddy-server.sh env` to see what certs/keys it picked up. If `hasCert=false`, it'll bind plain HTTP.
- **"process died during startup"** — the script tails the last 20 lines of the log. Common cause: port already in use, missing `node_modules`, missing `data/` dir.
- **disk fills up with rotated logs** — `LOG_MAX_BYTES=5MB` × `keep=3` = ~15MB ceiling. Bump `keep` if you want longer history.

## Future work

- SIGHUP-triggered rotation (currently rotation is purely size-based, triggered by the next write)
- JSON-only log mode for ingestion (a `LOG_FORMAT=json` switch)
- `/metrics` endpoint (request count, error rate, last vision-call latency)
- launchd wrapper (above) as a default in `bin/`

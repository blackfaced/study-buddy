// src/logger.ts
//
// v0.5b: structured logger + request middleware.
//
// Design: a Logger is level-filtered + fan-out. Each entry is dispatched
// to every configured sink. This lets us:
//   - write to stdout in dev (so `npm start` looks normal)
//   - write to a rotating file in production (so `bin/study-buddy-server.sh logs` works)
//   - write to an in-memory sink in tests (so we can assert on entries)
//
// We don't pull in winston/pino — the surface area is small and our needs
// are clear. Add a dep later if the format/transport options grow.

import { appendFile, rename, stat } from "node:fs/promises";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  ts: string;
  level: LogLevel;
  msg: string;
  meta?: Record<string, unknown>;
}

export interface LogSink {
  write(entry: LogEntry): void | Promise<void>;
}

export interface LoggerOptions {
  level?: LogLevel;
  /** Override the clock for tests. */
  now?: () => Date;
  sinks: LogSink[];
}

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export function createLogger(opts: LoggerOptions): Logger {
  const threshold = LEVEL_ORDER[opts.level ?? "info"];
  const now = opts.now ?? (() => new Date());

  function emit(level: LogLevel, msg: string, meta?: Record<string, unknown>) {
    if (LEVEL_ORDER[level] < threshold) return;
    const entry: LogEntry = {
      ts: now().toISOString(),
      level,
      msg,
      meta: meta ? { ...meta } : undefined,
    };
    for (const sink of opts.sinks) {
      // Fire-and-forget; sinks should not throw, but if they do, swallow
      // so a logging failure doesn't crash the server.
      void Promise.resolve(sink.write(entry)).catch(() => {
        /* noop */
      });
    }
  }

  return {
    debug: (msg, meta) => emit("debug", msg, meta),
    info: (msg, meta) => emit("info", msg, meta),
    warn: (msg, meta) => emit("warn", msg, meta),
    error: (msg, meta) => emit("error", msg, meta),
  };
}

/** In-memory sink. Returns a defensive-copy `entries()` getter. */
export function memorySink(): { sink: LogSink; entries: () => LogEntry[] } {
  const log: LogEntry[] = [];
  return {
    sink: { write: (e) => void log.push(e) },
    entries: () => log.slice(),
  };
}

/** stdout sink. Uses console.log/warn/error. Meta is JSON.stringify'd. */
export const stdoutSink: LogSink = {
  write(entry) {
    const line = formatLine(entry);
    if (entry.level === "warn") console.warn(line);
    else if (entry.level === "error") console.error(line);
    else console.log(line);
  },
};

function formatLine(entry: LogEntry): string {
  const base = `${entry.ts} ${entry.level.toUpperCase().padEnd(5)} ${entry.msg}`;
  if (!entry.meta || Object.keys(entry.meta).length === 0) return base;
  return `${base} ${JSON.stringify(entry.meta)}`;
}

/**
 * File sink with size-based rotation. When the file exceeds `maxBytes`,
 * it's renamed to `<path>.1` (older files keep rolling: .2, .3, …) and
 * a fresh file is started. Keeps the last `keep` rotated files plus the
 * active one. Synchronous-safe by virtue of appendFile.
 */
export interface RotatingFileSinkOptions {
  path: string;
  maxBytes: number;
  /** How many rotated files to keep on top of the active one. Default 3. */
  keep?: number;
}

export function rotatingFileSink(opts: RotatingFileSinkOptions): LogSink {
  const keep = opts.keep ?? 3;
  let pending = Promise.resolve();
  // Best-effort rotation. State is read from disk each check so two
  // server instances pointing at the same file don't fight.
  async function rotateIfNeeded() {
    try {
      const s = await stat(opts.path).catch(() => null);
      if (!s || s.size < opts.maxBytes) return;
      // Shift .(keep-1) -> .keep, then .(keep-2) -> .(keep-1), …, .1 -> .2, .log -> .1
      for (let i = keep; i >= 1; i--) {
        const src = i === 1 ? opts.path : `${opts.path}.${i - 1}`;
        const dst = `${opts.path}.${i}`;
        try {
          await rename(src, dst);
        } catch {
          /* src missing is fine on first rotation */
        }
      }
    } catch {
      /* best effort */
    }
  }

  return {
    write(entry) {
      pending = pending
        .then(() => mkdir(dirname(opts.path), { recursive: true }))
        .then(() => rotateIfNeeded())
        .then(() => appendFile(opts.path, formatLine(entry) + "\n", "utf8"))
        .catch(() => {
          /* swallow */
        });
    },
  };
}

export interface RequestLogMeta extends Record<string, unknown> {
  method: string;
  path: string;
  status: number;
  durationMs: number;
  contentLength: number;
  ip?: string;
}

/** Express middleware: emit one "request" log entry per response. */
export function requestLogger(logger: Logger) {
  return (req: import("express").Request, res: import("express").Response, next: import("express").NextFunction) => {
    const start = process.hrtime.bigint();
    res.on("finish", () => {
      const durationNs = process.hrtime.bigint() - start;
      const durationMs = Number(durationNs) / 1_000_000;
      const status = res.statusCode;
      const meta: RequestLogMeta = {
        method: req.method,
        path: req.path,
        status,
        durationMs: Math.round(durationMs * 100) / 100,
        contentLength: Number(res.getHeader("content-length") || 0),
        ip: req.ip,
      };
      if (status >= 500) logger.error("request", meta);
      else if (status >= 400) logger.warn("request", meta);
      else logger.info("request", meta);
    });
    next();
  };
}

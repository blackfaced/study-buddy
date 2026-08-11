// src/webhook-notify.ts
//
// DingTalk webhook notification worker. Drains the shared outbox
// (server/data/nexus-outbox.jsonl), POSTs each event as a short text
// message to a DingTalk group-bot webhook, and dedupes bursts inside a
// 60-second silence window per (kind, entityId, summary-hash).
//
// This module is the second consumer of the same outbox that
// `nexus-worker.ts` reads. While the Memory Nexus service is down,
// this worker is the sole route for parent_notify → IM. When Nexus
// comes back, both workers will read the same outbox, which would
// double-notify; the resolution is to disable one of them via env
// (DINGTALK_WEBHOOK_URL empty = no-op for this worker, or stop the
// nexus-worker entirely).
//
// Layers:
//   1. renderEntry / renderDigest     — pure text formatting
//   2. shouldNotify                    — silence window + state mutation
//   3. sendToDingTalk                  — wire format + failure handling
//   4. drainOutboxToWebhook            — integration: read → send → mark
//   5. runFromCli                      — bin/webhook-notify.sh entry point

import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { readPendingOutbox, markOutboxProcessed, type OutboxEntry } from "./outbox.js";
import { assertLegacyWorkerCanRun } from "./legacy-cutover.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookState {
  /** Keyed by `${kind}|${entityId}|${summaryHash8}`. */
  windows: Record<
    string,
    { firstTs: number; count: number; lastSummary: string }
  >;
}

export interface SendOptions {
  url: string;
  text: string;
  /** Injectable for tests. Defaults to global `fetch`. */
  fetchFn?: typeof fetch;
}

export interface SendResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
}

export interface DrainOptions {
  outboxPath: string;
  processedPath: string;
  statePath: string;
  webhookUrl: string;
  fetchFn?: typeof fetch;
  /** Injectable for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface DrainResult {
  processed: number;
  failed: number;
  remaining: number;
}

const WINDOW_MS = 60_000;
const EXPIRE_MS = 5 * 60_000;

// ---------------------------------------------------------------------------
// 1. renderEntry
// ---------------------------------------------------------------------------

/** Format an outbox entry into a 4-field single-line message:
 *  `[HH:MM] <childName|entityId> / <kind> / <one-liner>`.
 *  All times are converted to UTC+8 (Asia/Shanghai, China) so the
 *  message reflects when the event happened from the parent's POV. */
export function renderEntry(entry: OutboxEntry): string {
  const time = formatCstTime(entry.ts);
  const who = String(entry.payload?.childName ?? entry.entityId);
  const kind = entry.kind;
  const tail = renderTail(entry);
  return `[${time}] ${who} / ${kind} / ${tail}`;
}

function renderTail(entry: OutboxEntry): string {
  const p = entry.payload ?? {};
  if (entry.kind === "parent_notify") {
    const reasons = Array.isArray(p.reasons) ? (p.reasons as any[]) : [];
    const first = String(reasons[0]?.summary ?? "");
    return truncate(extractParentNotifyCore(first), 60);
  }
  if (entry.kind === "math_mistake") {
    const problem = String(p.problem ?? "");
    const compact = compactProblem(problem);
    const user = String(p.userAnswer ?? "?");
    const correct = String(p.correctAnswer ?? "?");
    return `${truncate(compact, 20)}=${user} (${correct})`;
  }
  if (entry.kind === "game-session") {
    const app = String(p.appId ?? "app");
    const correct = Number(p.correctCount ?? 0);
    const total = Number(p.totalQuestions ?? 0);
    return `${shortApp(app)} ${correct}/${total}`;
  }
  // Generic fallback
  return truncate(JSON.stringify(p), 60);
}

/** Pull just the child's quoted speech out of the verbose chat.ts summary
 *  template `小宝 情绪是"...",刚说："<SPEECH>",小书童回复："..."`. Falls
 *  back to the whole summary if the template isn't matched. */
function extractParentNotifyCore(summary: string): string {
  const m = summary.match(/刚说：["“]([^"”]+)["”]/);
  if (m && m[1]) return m[1].trim();
  return summary;
}

/** Strip leading quantity words and "一共多少" from math problems so
 *  `3 个 8，一共多少？` renders as `3×8`. */
function compactProblem(problem: string): string {
  // Try to extract a "A [×x] B" or "A [op] B" expression.
  const m = problem.match(/(\d+)\s*[个×x*]\s*(\d+)/);
  if (m) return `${m[1]}×${m[2]}`;
  const m2 = problem.match(/(\d+)\s*([+\-×x*÷/])\s*(\d+)/);
  if (m2) {
    const op = m2[2] === "*" ? "×" : m2[2] === "/" ? "÷" : m2[2];
    return `${m2[1]}${op}${m2[3]}`;
  }
  return problem;
}

function shortApp(appId: string): string {
  if (appId === "candy-math-island") return "candy";
  return appId.split(/[-_]/)[0] || appId;
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function formatCstTime(ts: number): string {
  // UTC+8 fixed offset — avoids host TZ surprises.
  const d = new Date(ts + 8 * 3600_000);
  const hh = String(d.getUTCHours()).padStart(2, "0");
  const mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// 2. renderDigest
// ---------------------------------------------------------------------------

/** 60s-window expiration message: `xN, last: <lastSummary>`. */
export function renderDigest(
  _entry: OutboxEntry,
  window: { count: number; lastSummary: string },
): string {
  return `x${window.count}, last: ${truncate(window.lastSummary, 50)}`;
}

// ---------------------------------------------------------------------------
// 3. shouldNotify
// ---------------------------------------------------------------------------

/** Decide whether `entry` should fire an IM, mutating the silence-window
 *  state. Pure function over (entry, state, now). */
export function shouldNotify(
  entry: OutboxEntry,
  state: WebhookState,
  now: number,
): { notify: boolean; message?: string; nextState: WebhookState } {
  const summary = extractSummary(entry);
  const key = `${entry.kind}|${entry.entityId}|${hash8(summary)}`;
  const existing = state.windows[key];

  // No window OR window expired beyond EXPIRE_MS → start a fresh one and send.
  if (!existing || now - existing.firstTs > EXPIRE_MS) {
    const nextState: WebhookState = {
      windows: {
        ...state.windows,
        [key]: { firstTs: now, count: 1, lastSummary: summary },
      },
    };
    return { notify: true, message: renderEntry(entry), nextState };
  }

  // Within the 60s window → accumulate silently, do not send.
  if (now - existing.firstTs < WINDOW_MS) {
    const nextState: WebhookState = {
      windows: {
        ...state.windows,
        [key]: {
          ...existing,
          count: existing.count + 1,
          lastSummary: summary,
        },
      },
    };
    return { notify: false, nextState };
  }

  // Window elapsed (between WINDOW_MS and EXPIRE_MS) → send digest, reset.
  const nextState: WebhookState = {
    windows: {
      ...state.windows,
      [key]: { firstTs: now, count: 1, lastSummary: summary },
    },
  };
  return { notify: true, message: renderDigest(entry, existing), nextState };
}

function extractSummary(entry: OutboxEntry): string {
  const p = entry.payload ?? {};
  if (entry.kind === "parent_notify") {
    const reasons = Array.isArray(p.reasons) ? (p.reasons as any[]) : [];
    return extractParentNotifyCore(String(reasons[0]?.summary ?? entry.kind));
  }
  if (entry.kind === "math_mistake") {
    return `${compactProblem(String(p.problem ?? "?"))}=${p.userAnswer ?? "?"}`;
  }
  if (entry.kind === "game-session") {
    return `${p.appId ?? "app"} ${p.correctCount ?? 0}/${p.totalQuestions ?? 0}`;
  }
  return entry.kind;
}

function hash8(s: string): string {
  // FNV-1a 32-bit, hex-truncated to 8 chars. Stable, dependency-free.
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

// ---------------------------------------------------------------------------
// 4. sendToDingTalk
// ---------------------------------------------------------------------------

/** POST a plain text message to a DingTalk group-bot webhook. The body
 *  follows the official text schema: `{msgtype:"text",text:{content}}`.
 *  No-op when `url` is empty (test mode / disabled). */
export async function sendToDingTalk(opts: SendOptions): Promise<SendResult> {
  if (!opts.url) {
    return { ok: true, skipped: true };
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const body = JSON.stringify({ msgtype: "text", text: { content: opts.text } });
  let resp: Response;
  try {
    resp = await fetchFn(opts.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    return { ok: false, error: `HTTP ${resp.status}: ${text.slice(0, 120)}` };
  }
  let parsed: any = {};
  try {
    parsed = await resp.json();
  } catch {
    /* non-JSON response — treat as ok if HTTP was 2xx */
    return { ok: true };
  }
  if (parsed && typeof parsed.errcode === "number" && parsed.errcode !== 0) {
    return { ok: false, error: `errcode=${parsed.errcode} ${parsed.errmsg ?? ""}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 5. drainOutboxToWebhook
// ---------------------------------------------------------------------------

/** Read the outbox, send each entry to DingTalk (subject to dedupe),
 *  then mark successful entries as processed. Failed entries remain in
 *  the outbox for the next tick. State is persisted to `statePath`
 *  before the outbox rewrite so a crash mid-drain doesn't lose the
 *  silence window. */
export async function drainOutboxToWebhook(opts: DrainOptions): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetchFn ?? fetch;

  if (!opts.webhookUrl) {
    // No-op mode: do not read, do not mark. Leave everything as-is.
    return { processed: 0, failed: 0, remaining: 0 };
  }

  const pending = await readPendingOutbox(opts.outboxPath);
  if (pending.length === 0) return { processed: 0, failed: 0, remaining: 0 };

  let state = await readState(opts.statePath);
  const successful: OutboxEntry[] = [];
  let failed = 0;

  for (const entry of pending) {
    const decision = shouldNotify(entry, state, now());
    state = decision.nextState;
    if (!decision.notify) continue;
    const r = await sendToDingTalk({
      url: opts.webhookUrl,
      text: decision.message!,
      fetchFn,
    });
    if (r.ok) {
      successful.push(entry);
    } else {
      failed++;
      // Best-effort: log to stderr so the daemon's nohup redirect picks it up.
      // eslint-disable-next-line no-console
      console.error(`[webhook-notify] send failed for ${entry.id}: ${r.error}`);
    }
  }

  // Persist state unconditionally (window info should survive a crash).
  await writeState(opts.statePath, state);

  if (successful.length > 0) {
    await markOutboxProcessed(opts.outboxPath, opts.processedPath, successful);
  }
  return { processed: successful.length, failed, remaining: failed };
}

async function readState(path: string): Promise<WebhookState> {
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && parsed.windows) return parsed as WebhookState;
    return { windows: {} };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { windows: {} };
    // Corrupt state — start fresh rather than crash the worker.
    return { windows: {} };
  }
}

async function writeState(path: string, state: WebhookState): Promise<void> {
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// 6. CLI entry — bin/webhook-notify.sh calls this
// ---------------------------------------------------------------------------

/** Single tick (one drain) or polling loop. Reads --outbox, --processed,
 *  --state, --url, --poll-ms from argv. */
export async function runFromCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cutoverMarker = args["cutover-marker"] ?? "./data/source-feed-cutover.json";
  await assertLegacyWorkerCanRun(cutoverMarker);
  const outbox = args.outbox ?? "./data/nexus-outbox.jsonl";
  const processed = args.processed ?? outbox + ".processed.jsonl";
  const state = args.state ?? outbox + ".webhook-state.json";
  const url = args.url ?? process.env.DINGTALK_WEBHOOK_URL ?? "";
  const pollMs = Number(args.pollMs ?? 30_000);

  // eslint-disable-next-line no-console
  console.log(
    `[webhook-notify] outbox=${outbox} poll=${pollMs}ms url=${url ? url.slice(0, 40) + "…" : "(empty)"}`,
  );

  if (args.once) {
    const r = await drainOutboxToWebhook({
      outboxPath: outbox,
      processedPath: processed,
      statePath: state,
      webhookUrl: url,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[webhook-notify] one-shot drain: processed=${r.processed} failed=${r.failed} remaining=${r.remaining}`,
    );
    return 0;
  }

  // Polling loop
  // eslint-disable-next-line no-constant-condition
  while (true) {
    await assertLegacyWorkerCanRun(cutoverMarker);
    try {
      const r = await drainOutboxToWebhook({
        outboxPath: outbox,
        processedPath: processed,
        statePath: state,
        webhookUrl: url,
      });
      if (r.processed > 0 || r.failed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[webhook-notify] tick: processed=${r.processed} failed=${r.failed} remaining=${r.remaining}`,
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[webhook-notify] tick failed: ${(e as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") {
      out.once = "1";
      continue;
    }
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        out[key] = next;
        i++;
      } else {
        out[key] = "1";
      }
    }
  }
  return out;
}

// Reference dirname so the import isn't tree-shaken away.
void dirname;

// Re-export SendResult so the test file can import the union without
// picking it up via the implementation module path.
export type { SendResult as _SendResult };

// CLI entry point. Only runs when the file is executed directly (not when
// imported as a module — vitest would otherwise trigger it).
if (import.meta.url === `file://${process.argv[1]}`) {
  runFromCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      // eslint-disable-next-line no-console
      console.error(e);
      process.exit(1);
    },
  );
}

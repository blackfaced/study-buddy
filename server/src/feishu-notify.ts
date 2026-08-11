// src/feishu-notify.ts
//
// Feishu (Lark) webhook notification worker. Drains the shared
// outbox (server/data/nexus-outbox.jsonl) and POSTs each event
// as a short text message to a Feishu custom-bot webhook. Designed
// as a drop-in alternative to bin/nexus-worker.sh and a sibling
// of bin/webhook-notify.sh (DingTalk).
//
// Layers:
//   1. renderEntry / renderDigest    — pure text formatting
//   2. shouldNotify                   — silence window + state mutation
//   3. signFeishu                     — HMAC-SHA256 timestamp sign
//   4. sendToFeishu                   — wire format + failure handling
//   5. drainOutboxToFeishu            — integration: read → sign → send → mark
//   6. runFromCli                     — bin/feishu-notify.sh entry point
//
// Feishu custom bot webhooks require HMAC-SHA256 signing by default
// (https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-customize-bot-architecture-setting)
// so we add the timestamp+sign to the URL on every request.

import { createHmac } from "node:crypto";
import { readFile, writeFile, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { readPendingOutbox, markOutboxProcessed, type OutboxEntry } from "./outbox.js";
import { assertLegacyWorkerCanRun } from "./legacy-cutover.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WebhookState {
  windows: Record<
    string,
    { firstTs: number; count: number; lastSummary: string }
  >;
}

export interface SendOptions {
  url: string;
  secret: string;
  text: string;
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
  webhookSecret: string;
  fetchFn?: typeof fetch;
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
// 1. renderEntry (mirrors webhook-notify's version)
// ---------------------------------------------------------------------------

/** Format an outbox entry into a 4-field single-line message:
 *  `[HH:MM] <childName|entityId> / <kind> / <one-liner>`. */
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
  return truncate(JSON.stringify(p), 60);
}

function extractParentNotifyCore(summary: string): string {
  const m = summary.match(/刚说：["“]([^"”]+)["”]/);
  if (m && m[1]) return m[1].trim();
  return summary;
}

function compactProblem(problem: string): string {
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
// 3. shouldNotify (mirrors webhook-notify)
// ---------------------------------------------------------------------------

export function shouldNotify(
  entry: OutboxEntry,
  state: WebhookState,
  now: number,
): { notify: boolean; message?: string; nextState: WebhookState } {
  const summary = extractSummary(entry);
  const key = `${entry.kind}|${entry.entityId}|${hash8(summary)}`;
  const existing = state.windows[key];

  if (!existing || now - existing.firstTs > EXPIRE_MS) {
    const nextState: WebhookState = {
      windows: {
        ...state.windows,
        [key]: { firstTs: now, count: 1, lastSummary: summary },
      },
    };
    return { notify: true, message: renderEntry(entry), nextState };
  }

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
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0").slice(0, 8);
}

// ---------------------------------------------------------------------------
// 4. signFeishu (HMAC-SHA256 of "timestamp\nsecret")
// ---------------------------------------------------------------------------

/** Compute Feishu's required HMAC-SHA256 sign: base64(hmac(secret, "timestamp\n")).
 *  Reference: https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/bot-v3/bot-customize-bot-architecture-setting */
export function signFeishu(timestamp: string, secret: string): string {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}\n`);
  return hmac.digest("base64");
}

// ---------------------------------------------------------------------------
// 5. sendToFeishu
// ---------------------------------------------------------------------------

/** POST a plain text message to a Feishu custom-bot webhook. Body
 *  follows the official text schema: `{msg_type:"text",content:{text}}`.
 *  Sign is computed from current timestamp (ms) and appended to the
 *  URL. No-op when `url` is empty (disabled mode). */
export async function sendToFeishu(opts: SendOptions): Promise<SendResult> {
  if (!opts.url) {
    return { ok: true, skipped: true };
  }
  const fetchFn = opts.fetchFn ?? fetch;
  const timestamp = Date.now().toString();
  const sign = signFeishu(timestamp, opts.secret);
  // Build the signed URL. Split off any existing query string from
  // the input url so we don't double-append params.
  const baseUrl = opts.url.split("?")[0];
  const signedUrl = `${baseUrl}?timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`;
  const body = JSON.stringify({ msg_type: "text", content: { text: opts.text } });
  let resp: Response;
  try {
    resp = await fetchFn(signedUrl, {
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
    return { ok: true };
  }
  // Feishu bot API uses {StatusCode, msg} (older) or {code, msg} (newer).
  // Both StatusCode 0 and code 0 are success.
  const statusCode = parsed?.StatusCode ?? parsed?.code;
  if (typeof statusCode === "number" && statusCode !== 0) {
    return { ok: false, error: `StatusCode=${statusCode} ${parsed?.msg ?? ""}` };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 6. drainOutboxToFeishu
// ---------------------------------------------------------------------------

export async function drainOutboxToFeishu(opts: DrainOptions): Promise<DrainResult> {
  const now = opts.now ?? Date.now;
  const fetchFn = opts.fetchFn ?? fetch;

  if (!opts.webhookUrl) {
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
    const r = await sendToFeishu({
      url: opts.webhookUrl,
      secret: opts.webhookSecret,
      text: decision.message!,
      fetchFn,
    });
    if (r.ok) {
      successful.push(entry);
    } else {
      failed++;
      // eslint-disable-next-line no-console
      console.error(`[feishu-notify] send failed for ${entry.id}: ${r.error}`);
    }
  }

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
    return { windows: {} };
  }
}

async function writeState(path: string, state: WebhookState): Promise<void> {
  const tmp = path + ".tmp";
  await writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
  await rename(tmp, path);
}

// ---------------------------------------------------------------------------
// 7. CLI entry — bin/feishu-notify.sh calls this
// ---------------------------------------------------------------------------

export async function runFromCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  const cutoverMarker = args["cutover-marker"] ?? "./data/source-feed-cutover.json";
  await assertLegacyWorkerCanRun(cutoverMarker);
  const outbox = args.outbox ?? "./data/nexus-outbox.jsonl";
  const processed = args.processed ?? outbox + ".feishu-processed.jsonl";
  const state = args.state ?? outbox + ".feishu-state.json";
  const url = args.url ?? process.env.FEISHU_WEBHOOK_URL ?? "";
  const secret = args.secret ?? process.env.FEISHU_WEBHOOK_SECRET ?? "";
  const pollMs = Number(args.pollMs ?? 30_000);

  // eslint-disable-next-line no-console
  console.log(
    `[feishu-notify] outbox=${outbox} poll=${pollMs}ms url=${url ? url.slice(0, 40) + "…" : "(empty)"}`,
  );

  if (args.once) {
    const r = await drainOutboxToFeishu({
      outboxPath: outbox,
      processedPath: processed,
      statePath: state,
      webhookUrl: url,
      webhookSecret: secret,
    });
    // eslint-disable-next-line no-console
    console.log(
      `[feishu-notify] one-shot drain: processed=${r.processed} failed=${r.failed} remaining=${r.remaining}`,
    );
    return 0;
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    await assertLegacyWorkerCanRun(cutoverMarker);
    try {
      const r = await drainOutboxToFeishu({
        outboxPath: outbox,
        processedPath: processed,
        statePath: state,
        webhookUrl: url,
        webhookSecret: secret,
      });
      if (r.processed > 0 || r.failed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[feishu-notify] tick: processed=${r.processed} failed=${r.failed} remaining=${r.remaining}`,
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[feishu-notify] tick failed: ${(e as Error).message}`);
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--once") { out.once = "1"; continue; }
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

void dirname;

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

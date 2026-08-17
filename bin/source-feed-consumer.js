// bin/source-feed-consumer.js
//
// Minimal local consumer for the study-buddy source-event feed
// (issue #10, ADR-026). Polls /api/integration/source-events with a
// cursor stored in a state file and logs each event to stdout.
//
// This is a verification tool — NOT a production MemoryNexus adapter.
// The real adapter will be owned by MemoryNexus, run on a separate
// process, and own its own cursor, retry, and delivery semantics.
// This script exists so the user can:
//   1. Confirm the feed contract works end-to-end (auth, pagination,
//      JSON shape, token rotation)
//   2. See events flow live as the kid plays (POST a mistake via
//      /api/game/mistake, watch it land in the consumer's stdout)
//
// Usage:
//   node bin/source-feed-consumer.js                  # run forever, poll every 2s
//   node bin/source-feed-consumer.js --once           # drain current page and exit
//   node bin/source-feed-consumer.js --interval=3    # custom poll interval (s)
//   node bin/source-feed-consumer.js --from-zero     # ignore saved cursor
//
// State: cursor is persisted in data/source-feed-consumer.cursor
// (one file, one line with the integer). Delete the file to reset.
//
// Local-only: this script is meant to talk to https://localhost:3000
// with a self-signed cert. We disable Node's TLS verification for the
// duration of this process. The integration endpoint also requires
// loopback callers, so exposing this over the network is a no-op.

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

// Local-only: trust the dev server's self-signed cert. The integration
// endpoint's loopback check is the real boundary; this just lets the
// TLS handshake complete against a dev cert.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = process.env.NODE_TLS_REJECT_UNAUTHORIZED ?? "0";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..");
const STATE_PATH = join(REPO_ROOT, "data", "source-feed-consumer.cursor");

// --- config (env) --------------------------------------------------------

const TOKEN = process.env.INTEGRATION_API_TOKEN
  ?? (existsSync(join(REPO_ROOT, ".env"))
      ? readFileSync(join(REPO_ROOT, ".env"), "utf-8")
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l.startsWith("INTEGRATION_API_TOKEN="))
          ?.slice("INTEGRATION_API_TOKEN=".length)
      : null);

if (!TOKEN) {
  console.error("FATAL: INTEGRATION_API_TOKEN not set (env or .env)");
  process.exit(1);
}

const BASE_URL = process.env.STUDY_BUDDY_URL ?? "https://localhost:3000";
const PAGE_SIZE = 50;

// --- args ---------------------------------------------------------------

const args = process.argv.slice(2);
const flags = {
  once: args.includes("--once"),
  interval: Number(
    args.find((a) => a.startsWith("--interval="))?.split("=")[1] ?? 2,
  ),
  startFromZero: args.includes("--from-zero"),
};

if (Number.isNaN(flags.interval) || flags.interval < 1) {
  console.error("FATAL: --interval must be a positive integer (seconds)");
  process.exit(1);
}

// --- state --------------------------------------------------------------

function loadCursor() {
  if (flags.startFromZero) return 0;
  if (!existsSync(STATE_PATH)) return 0;
  const raw = readFileSync(STATE_PATH, "utf-8").trim();
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

function saveCursor(seq) {
  mkdirSync(dirname(STATE_PATH), { recursive: true });
  writeFileSync(STATE_PATH, String(seq) + "\n");
}

let cursor = loadCursor();

// --- HTTP fetch ---------------------------------------------------------

/**
 * Fetch one page of source events.
 * @param {number} after  cursor (sequence number to start after)
 * @returns {Promise<{events: Array, nextCursor: number, endOfFeed: boolean}>}
 * @throws on auth failure or network error
 */
async function fetchPage(after) {
  const url = `${BASE_URL}/api/integration/source-events?after=${after}&limit=${PAGE_SIZE}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${TOKEN}` },
  });
  if (res.status === 401) {
    throw new Error(`401 Unauthorized — token rejected (check INTEGRATION_API_TOKEN matches .env)`);
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`HTTP ${res.status} from ${url}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  return {
    events: data.events ?? [],
    nextCursor: data.page?.nextCursor ?? after,
    endOfFeed: data.page?.endOfFeed ?? false,
  };
}

// --- display ------------------------------------------------------------

/**
 * Format one event as a single human-readable line. Verbose by default
 * (the kid's homework content is not in payload so this is safe to
 * log to stdout in plain text).
 */
function formatEvent(ev) {
  const id = ev.sourceIdentity ?? {};
  const p = ev.payload ?? {};
  const when = ev.occurredAt ?? "?";
  return [
    `seq=${ev.sequence}`,
    `id=${id.recordType}/${id.recordId}@r${id.revision}`,
    `type=${ev.eventType}`,
    `when=${when}`,
    `subject=${p.subjectRef?.slice(0, 8) ?? "?"}`,
    `problem=${p.problem ?? "?"}`,
    `user=${p.submittedAnswer ?? "?"}`,
    `correct=${p.expectedAnswer ?? "?"}`,
  ].join(" ");
}

function header() {
  console.log("# source-feed-consumer");
  console.log(`# url:    ${BASE_URL}`);
  console.log(`# cursor: ${STATE_PATH} (current: ${cursor})`);
  console.log(`# flags:  ${JSON.stringify(flags)}`);
  console.log(`# auth:   Bearer <token from .env>`);
  console.log("#");
  console.log("# waiting for events… (Ctrl+C to stop)");
}

// --- main loop ----------------------------------------------------------

async function tick() {
  const page = await fetchPage(cursor);
  if (page.events.length > 0) {
    for (const ev of page.events) {
      console.log(formatEvent(ev));
    }
    cursor = page.nextCursor;
    saveCursor(cursor);
    if (page.endOfFeed) {
      console.log(`# (end of feed, ${cursor} event(s) total)`);
    }
  } else if (cursor === 0) {
    // No events yet, no noise. Only the header shows progress.
  } else {
    // Caught up — log once when we hit the head, then stay quiet.
    if (!globalThis.__caughtUp) {
      console.log(`# caught up at cursor=${cursor}`);
      globalThis.__caughtUp = true;
    }
  }
  return page;
}

async function runForever() {
  header();
  while (true) {
    try {
      const page = await tick();
      if (page.endOfFeed) {
        // We've consumed everything. Slow down the polling to avoid
        // hammering the server. Keep a long enough interval that we
        // still catch fresh events within a kid's interaction latency.
        await new Promise((r) => setTimeout(r, flags.interval * 1000));
      } else {
        // More pages — drain them quickly (no sleep) so the consumer
        // can keep up with bursts.
      }
    } catch (e) {
      console.error(`# error: ${e.message}`);
      // Back off on errors so we don't hammer a broken endpoint.
      await new Promise((r) => setTimeout(r, flags.interval * 2000));
    }
  }
}

async function runOnce() {
  header();
  let drained = false;
  while (!drained) {
    try {
      const page = await tick();
      drained = page.endOfFeed || page.events.length === 0;
      if (!drained) {
        // keep looping to drain remaining pages
      }
    } catch (e) {
      console.error(`# error: ${e.message}`);
      process.exit(1);
    }
  }
  console.log(`# done (final cursor: ${cursor})`);
  process.exit(0);
}

if (flags.once) {
  await runOnce();
} else {
  await runForever();
}

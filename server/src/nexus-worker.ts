// src/nexus-worker.ts
//
// Worker that drains the study-buddy outbox into Memory Nexus. Lives as
// a small module so the bin/nexus-worker.sh shell wrapper can spawn it
// and so unit tests can exercise the drain loop in isolation.
//
// The worker is deliberately stupid: read, push, mark. No retries
// inside the loop — a failed entry stays in the outbox and will be
// retried on the next tick. This keeps the failure mode local and the
// blast radius small (e.g. when Nexus is down for an hour, we don't
// pile up unbounded retries in memory).

import { dirname, join } from "node:path";
import { createNexusClient, noopNexusClient, type NexusClient, type NexusEntry } from "./nexus.js";
import { readPendingOutbox, markOutboxProcessed, type OutboxEntry } from "./outbox.js";
import { assertLegacyWorkerCanRun } from "./legacy-cutover.js";

export type { NexusClient };

/** Convert a generic outbox entry into the Nexus entry shape. */
function toNexusEntry(e: OutboxEntry): NexusEntry {
  return {
    entityId: e.entityId,
    kind: e.kind,
    content: e.content ?? `${e.kind} ${e.entityId} ${JSON.stringify(e.payload)}`,
    meta: e.payload,
  };
}

/** Re-export the converter so tests can verify the transformation seam. */
export { toNexusEntry };
// Reference dirname so the static analysis doesn't complain.
void dirname;

export interface DrainResult {
  processed: number;
  failed: number;
  remaining: number;
}

export interface DrainOptions {
  nexus: NexusClient;
  outboxPath: string;
  processedPath: string;
}

/**
 * Push every pending outbox entry to Nexus, then mark the successful
 * ones as processed. Failed entries are left in the outbox for the
 * next drain. Corrupt lines in the outbox are silently skipped (the
 * file is append-only and we never want to deadlock on a partial write).
 */
export async function drainOutbox(opts: DrainOptions): Promise<DrainResult> {
  const pending = await readPendingOutbox(opts.outboxPath);
  if (pending.length === 0) return { processed: 0, failed: 0, remaining: 0 };

  const successful: typeof pending = [];
  let failed = 0;
  for (const entry of pending) {
    try {
      await opts.nexus.write(toNexusEntry(entry));
      successful.push(entry);
    } catch (e) {
      failed++;
      // Best-effort: log to stderr so the daemon's nohup redirect picks
      // it up. Don't rethrow — the loop must keep going.
      // eslint-disable-next-line no-console
      console.error(`[nexus-worker] write failed for ${entry.id}: ${(e as Error).message}`);
    }
  }
  if (successful.length > 0) {
    await markOutboxProcessed(opts.outboxPath, opts.processedPath, successful);
  }
  return { processed: successful.length, failed, remaining: failed };
}

/**
 * Parse CLI flags and run a one-shot drain. The shell wrapper
 * (bin/nexus-worker.sh) and the cron entry point both call this.
 *
 *   --outbox <path>     default data/nexus-outbox.jsonl
 *   --processed <path>  default data/nexus-outbox.processed.jsonl
 *   --once              drain once and exit (used by the shell `once` cmd)
 *   --poll-ms <ms>      when not --once, sleep this many ms between drains
 *   --no-nexus          use a noop client (useful for smoke tests)
 */
export async function runFromCli(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  await assertLegacyWorkerCanRun(args.cutoverMarker);
  const nexus: NexusClient = args.noNexus
    ? noopNexusClient()
    : createNexusClient({
        baseUrl: process.env.MEMORYNEXUS_API_URL || "http://127.0.0.1:8080",
        token: process.env.MEMORYNEXUS_TOKEN || "",
      });

  if (args.once || args.pollMs === 0) {
    const r = await drainOutbox({
      nexus,
      outboxPath: args.outbox,
      processedPath: args.processed,
    });
    // eslint-disable-next-line no-console
    console.log(`[nexus-worker] one-shot drain: processed=${r.processed} failed=${r.failed} remaining=${r.remaining}`);
    return 0;
  }

  // eslint-disable-next-line no-console
  console.log(`[nexus-worker] polling ${args.outbox} every ${args.pollMs}ms`);
  for (;;) {
    await assertLegacyWorkerCanRun(args.cutoverMarker);
    try {
      const r = await drainOutbox({
        nexus,
        outboxPath: args.outbox,
        processedPath: args.processed,
      });
      if (r.processed > 0 || r.failed > 0) {
        // eslint-disable-next-line no-console
        console.log(
          `[nexus-worker] tick: processed=${r.processed} failed=${r.failed} remaining=${r.remaining}`,
        );
      }
    } catch (e) {
      // eslint-disable-next-line no-console
      console.error(`[nexus-worker] tick failed: ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, args.pollMs));
  }
}

interface CliArgs {
  outbox: string;
  processed: string;
  cutoverMarker: string;
  once: boolean;
  pollMs: number;
  noNexus: boolean;
}

function parseArgs(argv: string[]): CliArgs {
  const outbox = (readFlag(argv, "--outbox") ?? join(process.cwd(), "data/nexus-outbox.jsonl"));
  const processed = (readFlag(argv, "--processed") ?? join(process.cwd(), "data/nexus-outbox.processed.jsonl"));
  const cutoverMarker = (
    readFlag(argv, "--cutover-marker") ??
    join(process.cwd(), "data/source-feed-cutover.json")
  );
  const once = argv.includes("--once");
  const noNexus = argv.includes("--no-nexus");
  const pollRaw = readFlag(argv, "--poll-ms");
  const pollMs = pollRaw != null ? Number(pollRaw) : 30000;
  return { outbox, processed, cutoverMarker, once, pollMs, noNexus };
}

function readFlag(argv: string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  if (i < 0 || i + 1 >= argv.length) return undefined;
  return argv[i + 1];
}

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

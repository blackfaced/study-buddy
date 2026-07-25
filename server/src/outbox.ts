// src/outbox.ts
//
// Append-only event outbox for the loose-coupling handoff between
// study-buddy and the Memory Nexus consumer (separate process, separate
// schedule). Producers call appendOutbox from request handlers; the
// worker (bin/nexus-worker.sh) tails readPendingOutbox and calls
// markOutboxProcessed on success.
//
// Format: newline-delimited JSON, one entry per line.
//   {"id":"e_xxx","ts":1700000000000,"kind":"math_mistake",
//    "entityId":"child:default","payload":{...}}
//
// Failure semantics: corrupt lines are skipped (not thrown) so a
// partial-write can't deadlock the consumer. The processed file is
// append-only — kept as an audit trail (one line per archived entry).

import { appendFile, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface OutboxEntry {
  id: string;
  ts: number;
  kind: string;
  entityId: string;
  /** Optional human-readable body. When missing, the Nexus worker
   *  synthesizes one from `kind` + `payload` so MemoryNexus still has
   *  something queryable. */
  content?: string;
  payload: Record<string, unknown>;
}

/** Append the given entries to the outbox file, one JSON line per entry. */
export async function appendOutbox(path: string, entries: OutboxEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const data = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(path, data, "utf8");
}

/** Read all pending entries. Skips malformed lines. Returns [] if file missing. */
export async function readPendingOutbox(path: string): Promise<OutboxEntry[]> {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (e: any) {
    if (e?.code === "ENOENT") return [];
    throw e;
  }
  const out: OutboxEntry[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line) as OutboxEntry);
    } catch {
      /* skip malformed line */
    }
  }
  return out;
}

/**
 * Mark the given entries as processed: rewrite the outbox file keeping
 * only the un-processed lines, and append the processed ones to the
 * `processedPath` for audit. Safe under a single producer: the rewrite
 * uses a tmp file + rename so a reader never sees a half-written file.
 */
export async function markOutboxProcessed(
  outboxPath: string,
  processedPath: string,
  processed: OutboxEntry[],
): Promise<void> {
  if (processed.length === 0) return;

  // Read current pending (best-effort: if the file is gone, nothing to rewrite).
  const remaining = await readPendingOutbox(outboxPath);
  const processedIds = new Set(processed.map((e) => e.id));
  const keep = remaining.filter((e) => !processedIds.has(e.id));

  // Append processed to audit file.
  const audit = processed.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await appendFile(processedPath, audit, "utf8");

  // Atomic rewrite of the outbox: tmp -> rename. If keep is empty, remove
  // the file entirely (cleaner than leaving an empty file).
  if (keep.length === 0) {
    const { unlink } = await import("node:fs/promises");
    try {
      await unlink(outboxPath);
    } catch (e: any) {
      if (e?.code !== "ENOENT") throw e;
    }
    return;
  }
  const tmp = outboxPath + ".tmp";
  await writeFile(tmp, keep.map((e) => JSON.stringify(e)).join("\n") + "\n", "utf8");
  await rename(tmp, outboxPath);
}

// Reference dirname so the import isn't tree-shaken away (the import is used
// by future helpers that may want to mkdir-p the outbox dir).
void dirname;

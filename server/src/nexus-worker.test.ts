import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile, readFile } from "node:fs/promises";
import { drainOutbox, type NexusClient } from "./nexus-worker.js";
import { appendOutbox, readPendingOutbox, type OutboxEntry } from "./outbox.js";

let dir: string;
let outboxPath: string;
let processedPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nexus-worker-"));
  outboxPath = join(dir, "outbox.jsonl");
  processedPath = join(dir, "outbox.processed.jsonl");
});

afterEach(() => {
  // tmpdir cleanup is OS-managed
});

const sample = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: "e_" + Math.random().toString(36).slice(2, 8),
  ts: Date.now(),
  kind: "math_mistake",
  entityId: "child:default",
  payload: { level: 1, errorType: "carry" },
  ...overrides,
});

function fakeNexus(ids: string[], opts: { failOn?: string[] } = {}): NexusClient & { calls: string[] } {
  const calls: string[] = [];
  const failOn = new Set(opts.failOn ?? []);
  return {
    calls,
    async write(entry) {
      // The worker tags each write with `${kind}:${entityId}` so we can
      // match against the test's `failOn` list. This is the same
      // discriminator toNexusEntry would use to derive a stable id.
      const tag = `${entry.kind}:${entry.entityId}`;
      calls.push(tag);
      if (failOn.has(tag)) {
        throw new Error("simulated upstream failure");
      }
      return ids.shift() ?? `mem-${calls.length}`;
    },
    async query() {
      return [];
    },
  };
}

describe("drainOutbox", () => {
  it("returns 0/0 and noop when the outbox is empty", async () => {
    const nexus = fakeNexus([]);
    const r = await drainOutbox({ nexus, outboxPath, processedPath });
    expect(r).toEqual({ processed: 0, failed: 0, remaining: 0 });
    expect(nexus.calls).toEqual([]);
    expect(existsSync(processedPath)).toBe(false);
  });

  it("pushes every entry to Nexus and marks them processed on success", async () => {
    await appendOutbox(outboxPath, [
      sample(),
      sample(),
      sample(),
    ]);
    const nexus = fakeNexus(["mem-1", "mem-2", "mem-3"]);
    const r = await drainOutbox({ nexus, outboxPath, processedPath });
    expect(r).toEqual({ processed: 3, failed: 0, remaining: 0 });
    expect(nexus.calls).toEqual([
      "math_mistake:child:default",
      "math_mistake:child:default",
      "math_mistake:child:default",
    ]);
    expect(await readPendingOutbox(outboxPath)).toEqual([]);
    const proc = (await readFile(processedPath, "utf-8"))
      .split("\n").filter(Boolean);
    expect(proc).toHaveLength(3);
  });

  it("leaves failed entries in the outbox for the next drain (no mark)", async () => {
    const a = sample();
    const b = sample();
    const c = sample();
    await appendOutbox(outboxPath, [a, b, c]);
    // Fail only the middle entry. We use its tag (`kind:entityId`) which
    // is identical for all three here, so the test is more meaningful
    // when entityId varies. Override one of them.
    const bWithDifferentEntity = { ...b, entityId: "child:other" };
    // Rewrite the file so the middle row has a different tag.
    const { writeFile } = await import("node:fs/promises");
    await writeFile(
      outboxPath,
      [JSON.stringify(a), JSON.stringify(bWithDifferentEntity), JSON.stringify(c)].join("\n") + "\n",
      "utf-8",
    );
    const nexus = fakeNexus(["mem-1", "mem-2", "mem-3"], { failOn: ["math_mistake:child:other"] });
    const r = await drainOutbox({ nexus, outboxPath, processedPath });
    expect(r.processed).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.remaining).toBe(1);
    const remaining = await readPendingOutbox(outboxPath);
    expect(remaining.map((e) => e.entityId)).toEqual(["child:other"]);
    const proc = (await readFile(processedPath, "utf-8"))
      .split("\n").filter(Boolean);
    expect(proc).toHaveLength(2);
  });

  it("tolerates corrupt lines in the outbox without throwing", async () => {
    await writeFile(outboxPath, '{"id":"good","ts":1,"kind":"x","entityId":"e","payload":{}}\nNOT JSON\n', "utf-8");
    const nexus = fakeNexus(["mem-1"]);
    const r = await drainOutbox({ nexus, outboxPath, processedPath });
    expect(r.processed).toBe(1);
    expect(r.failed).toBe(0);
  });
});

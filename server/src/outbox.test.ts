import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOutbox,
  readPendingOutbox,
  markOutboxProcessed,
  type OutboxEntry,
} from "./outbox.js";

let dir: string;
let outboxPath: string;
let processedPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "outbox-test-"));
  outboxPath = join(dir, "outbox.jsonl");
  processedPath = join(dir, "outbox.processed.jsonl");
});

afterEach(() => {
  // tmpdir auto-cleaned by os, noop
});

const sample = (overrides: Partial<OutboxEntry> = {}): OutboxEntry => ({
  id: "e_" + Math.random().toString(36).slice(2, 8),
  ts: 1700000000000,
  kind: "math_mistake",
  entityId: "child:default",
  payload: { errorType: "carry", level: 1 },
  ...overrides,
});

describe("appendOutbox", () => {
  it("creates the file and writes one JSON line per entry", async () => {
    await appendOutbox(outboxPath, [sample(), sample({ id: "e_2" })]);
    const raw = readFileSync(outboxPath, "utf-8");
    const lines = raw.split("\n").filter(Boolean);
    expect(lines).toHaveLength(2);
    expect(JSON.parse(lines[0]).id).toMatch(/^e_/);
    expect(JSON.parse(lines[1]).id).toBe("e_2");
  });

  it("appends (does not truncate) when called multiple times", async () => {
    await appendOutbox(outboxPath, [sample({ id: "e_1" })]);
    await appendOutbox(outboxPath, [sample({ id: "e_2" })]);
    await appendOutbox(outboxPath, [sample({ id: "e_3" })]);
    const lines = readFileSync(outboxPath, "utf-8").split("\n").filter(Boolean);
    expect(lines).toHaveLength(3);
  });
});

describe("readPendingOutbox", () => {
  it("returns [] when the file does not exist yet", async () => {
    const entries = await readPendingOutbox(outboxPath);
    expect(entries).toEqual([]);
  });

  it("returns all written entries in order", async () => {
    await appendOutbox(outboxPath, [sample({ id: "e_1" }), sample({ id: "e_2" }), sample({ id: "e_3" })]);
    const entries = await readPendingOutbox(outboxPath);
    expect(entries.map((e) => e.id)).toEqual(["e_1", "e_2", "e_3"]);
  });

  it("skips malformed lines instead of throwing", async () => {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(outboxPath, '{"id":"good","ts":1,"kind":"x","entityId":"e","payload":{}}\nNOT JSON\n{"id":"good2","ts":2,"kind":"x","entityId":"e","payload":{}}\n', "utf-8");
    const entries = await readPendingOutbox(outboxPath);
    expect(entries.map((e) => e.id)).toEqual(["good", "good2"]);
  });
});

describe("markOutboxProcessed", () => {
  it("removes the given ids and appends them to the processed file", async () => {
    await appendOutbox(outboxPath, [
      sample({ id: "e_1" }),
      sample({ id: "e_2" }),
      sample({ id: "e_3" }),
    ]);
    const all = await readPendingOutbox(outboxPath);
    await markOutboxProcessed(outboxPath, processedPath, [all[0], all[2]]);

    const remaining = await readPendingOutbox(outboxPath);
    expect(remaining.map((e) => e.id)).toEqual(["e_2"]);

    expect(existsSync(processedPath)).toBe(true);
    const processed = readFileSync(processedPath, "utf-8").split("\n").filter(Boolean);
    expect(processed).toHaveLength(2);
    expect(JSON.parse(processed[0]).id).toBe("e_1");
    expect(JSON.parse(processed[1]).id).toBe("e_3");
  });

  it("does nothing when no entries are pending", async () => {
    await markOutboxProcessed(outboxPath, processedPath, []);
    expect(existsSync(outboxPath)).toBe(false);
    expect(existsSync(processedPath)).toBe(false);
  });

  it("processes the full batch (empty pending afterwards)", async () => {
    await appendOutbox(outboxPath, [sample({ id: "e_1" }), sample({ id: "e_2" })]);
    const all = await readPendingOutbox(outboxPath);
    await markOutboxProcessed(outboxPath, processedPath, all);
    expect(await readPendingOutbox(outboxPath)).toEqual([]);
    const proc = readFileSync(processedPath, "utf-8").split("\n").filter(Boolean);
    expect(proc).toHaveLength(2);
  });
});

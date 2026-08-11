import { afterEach, describe, expect, it } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  assertLegacyWorkerCanRun,
  enableSourceFeedCutover,
  inventoryLegacyJsonl,
} from "./legacy-cutover.js";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "study-buddy-cutover-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("legacy JSONL dry-run inventory (#105)", () => {
  it("reports only aggregate counts, ranges, types, and unmappable reasons", async () => {
    const dir = tempDir();
    const path = join(dir, "nexus-outbox.jsonl");
    const secretContent = "child said a private sentence TOKEN-secret";
    const original = [
      JSON.stringify({
        id: "e_1",
        ts: Date.UTC(2026, 7, 1),
        kind: "math_mistake",
        entityId: "child:default",
        content: secretContent,
        payload: { problem: "private problem", token: "credential-value" },
      }),
      JSON.stringify({
        id: "e_2",
        ts: Date.UTC(2026, 7, 2),
        kind: "game-session",
        entityId: "child:default",
        payload: { correctCount: 2 },
      }),
      JSON.stringify({ id: "missing-fields", payload: {} }),
      JSON.stringify({
        id: "unknown-kind",
        ts: Date.UTC(2026, 7, 3),
        kind: "private-child-secret-kind",
        entityId: "child:default",
        payload: {},
      }),
      "not-json",
      "",
    ].join("\n");
    writeFileSync(path, original);

    const report = await inventoryLegacyJsonl([path]);

    expect(report).toMatchObject({
      dryRun: true,
      totals: {
        records: 5,
        mappableRecords: 2,
        unmappableRecords: 3,
        malformedRecords: 1,
        firstOccurredAt: "2026-08-01T00:00:00.000Z",
        lastOccurredAt: "2026-08-02T00:00:00.000Z",
        types: { math_mistake: 1, "game-session": 1 },
        unmappableReasons: {
          invalid_timestamp: 1,
          malformed_json: 1,
          unsupported_type: 1,
        },
      },
    });
    expect(readFileSync(path, "utf8")).toBe(original);
    const diagnostics = JSON.stringify(report);
    expect(diagnostics).not.toContain(secretContent);
    expect(diagnostics).not.toContain("private problem");
    expect(diagnostics).not.toContain("credential-value");
    expect(diagnostics).not.toContain("child:default");
    expect(diagnostics).not.toContain("private-child-secret-kind");
  });

  it("treats a missing legacy file as an empty read-only input", async () => {
    const report = await inventoryLegacyJsonl([join(tempDir(), "missing.jsonl")]);
    expect(report.totals.records).toBe(0);
    expect(report.files[0]).toMatchObject({
      file: "legacy-1:missing.jsonl",
      records: 0,
    });
  });
});

describe("source-feed cutover gate (#105)", () => {
  it("refuses cutover while a legacy worker is running", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "nexus-worker.pid");
    writeFileSync(pidPath, "4242\n");

    await expect(
      enableSourceFeedCutover({
        markerPath: join(dir, "cutover.json"),
        workerPidPaths: [pidPath],
        legacyFiles: [],
        isProcessRunning: (pid) => pid === 4242,
      }),
    ).rejects.toThrow("legacy JSONL worker is still running");
    expect(existsSync(`${pidPath}.lock`)).toBe(false);
  });

  it("refuses cutover while a worker is inside the atomic lease window", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "nexus-worker.pid");
    mkdirSync(`${pidPath}.lock`);

    await expect(
      enableSourceFeedCutover({
        markerPath: join(dir, "cutover.json"),
        workerPidPaths: [pidPath],
        legacyFiles: [],
      }),
    ).rejects.toThrow("legacy JSONL worker lease is already held");
  });

  it("refuses cutover while a legacy producer is enabled", async () => {
    const dir = tempDir();
    await expect(
      enableSourceFeedCutover({
        markerPath: join(dir, "cutover.json"),
        workerPidPaths: [],
        legacyFiles: [],
        producerEnabled: true,
      }),
    ).rejects.toThrow("legacy JSONL producer is still enabled");
  });

  it("refuses cutover while an old HTTP producer process may still be running", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "study-buddy-server.pid");
    writeFileSync(pidPath, "5252\n");
    await expect(
      enableSourceFeedCutover({
        markerPath: join(dir, "cutover.json"),
        workerPidPaths: [],
        producerPidPaths: [pidPath],
        legacyFiles: [],
        isProcessRunning: (pid) => pid === 5252,
      }),
    ).rejects.toThrow("legacy JSONL producer process may still be running");
  });

  it("writes a content-free marker after inventory and permanently blocks the old worker", async () => {
    const dir = tempDir();
    const legacyPath = join(dir, "nexus-outbox.jsonl");
    const markerPath = join(dir, "source-feed-cutover.json");
    const pidPath = join(dir, "nexus-worker.pid");
    writeFileSync(
      legacyPath,
      `${JSON.stringify({
        id: "e_1",
        ts: Date.UTC(2026, 7, 1),
        kind: "math_mistake",
        entityId: "child:default",
        payload: { private: "must-not-appear" },
      })}\n`,
    );

    const result = await enableSourceFeedCutover({
      markerPath,
      workerPidPaths: [pidPath, pidPath],
      legacyFiles: [legacyPath],
      enabledAt: Date.UTC(2026, 7, 10),
    });

    expect(result.marker).toEqual({
      version: 1,
      enabled: true,
      enabledAt: "2026-08-10T00:00:00.000Z",
      legacyFilesInventoried: 1,
      legacyRecordsInventoried: 1,
    });
    expect(readFileSync(legacyPath, "utf8")).toContain("must-not-appear");
    expect(readFileSync(markerPath, "utf8")).not.toContain("must-not-appear");
    expect(existsSync(`${pidPath}.lock`)).toBe(false);
    await expect(assertLegacyWorkerCanRun(markerPath)).rejects.toThrow(
      "legacy JSONL delivery is retired",
    );
    await expect(
      enableSourceFeedCutover({
        markerPath,
        workerPidPaths: [],
        legacyFiles: [legacyPath],
      }),
    ).rejects.toThrow();
  });
});

import { createReadStream } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";

export const LEGACY_JSONL_PRODUCER_ENABLED = false;
export const SOURCE_FEED_CUTOVER_VERSION = 1;

export interface LegacyFileInventory {
  file: string;
  records: number;
  mappableRecords: number;
  unmappableRecords: number;
  malformedRecords: number;
  firstOccurredAt: string | null;
  lastOccurredAt: string | null;
  types: Record<string, number>;
  unmappableReasons: Record<string, number>;
}

export interface LegacyInventory {
  dryRun: true;
  files: LegacyFileInventory[];
  totals: Omit<LegacyFileInventory, "file">;
}

export interface EnableCutoverOptions {
  markerPath: string;
  workerPidPaths: string[];
  producerPidPaths?: string[];
  legacyFiles: string[];
  isProcessRunning?: (pid: number) => boolean;
  producerEnabled?: boolean;
  enabledAt?: number;
}

export interface CutoverMarker {
  version: 1;
  enabled: true;
  enabledAt: string;
  legacyFilesInventoried: number;
  legacyRecordsInventoried: number;
}

export async function inventoryLegacyJsonl(
  paths: string[],
): Promise<LegacyInventory> {
  const files: LegacyFileInventory[] = [];
  for (const [index, path] of paths.entries()) {
    files.push(await inventoryOneFile(path, index));
  }

  return {
    dryRun: true,
    files,
    totals: files.reduce<LegacyInventory["totals"]>(
      (totals, file) => {
        totals.records += file.records;
        totals.mappableRecords += file.mappableRecords;
        totals.unmappableRecords += file.unmappableRecords;
        totals.malformedRecords += file.malformedRecords;
        totals.firstOccurredAt = earliest(
          totals.firstOccurredAt,
          file.firstOccurredAt,
        );
        totals.lastOccurredAt = latest(
          totals.lastOccurredAt,
          file.lastOccurredAt,
        );
        mergeCounts(totals.types, file.types);
        mergeCounts(totals.unmappableReasons, file.unmappableReasons);
        return totals;
      },
      {
        records: 0,
        mappableRecords: 0,
        unmappableRecords: 0,
        malformedRecords: 0,
        firstOccurredAt: null,
        lastOccurredAt: null,
        types: {},
        unmappableReasons: {},
      },
    ),
  };
}

export async function enableSourceFeedCutover(
  options: EnableCutoverOptions,
): Promise<{ marker: CutoverMarker; inventory: LegacyInventory }> {
  if (options.producerEnabled ?? LEGACY_JSONL_PRODUCER_ENABLED) {
    throw new Error("legacy JSONL producer is still enabled");
  }

  const isProcessRunning = options.isProcessRunning ?? processIsRunning;
  for (const pidPath of options.workerPidPaths) {
    const pid = await readPid(pidPath);
    if (pid !== null && isProcessRunning(pid)) {
      throw new Error("legacy JSONL worker is still running");
    }
  }
  for (const pidPath of options.producerPidPaths ?? []) {
    const pid = await readPid(pidPath);
    if (pid !== null && isProcessRunning(pid)) {
      throw new Error("legacy JSONL producer process may still be running");
    }
  }

  const inventory = await inventoryLegacyJsonl(options.legacyFiles);
  const marker: CutoverMarker = {
    version: SOURCE_FEED_CUTOVER_VERSION,
    enabled: true,
    enabledAt: new Date(options.enabledAt ?? Date.now()).toISOString(),
    legacyFilesInventoried: inventory.files.length,
    legacyRecordsInventoried: inventory.totals.records,
  };
  await mkdir(dirname(options.markerPath), { recursive: true });
  await writeFile(options.markerPath, `${JSON.stringify(marker)}\n`, {
    encoding: "utf8",
    flag: "wx",
  });
  return { marker, inventory };
}

export async function assertLegacyWorkerCanRun(
  markerPath: string,
): Promise<void> {
  try {
    const marker = JSON.parse(await readFile(markerPath, "utf8")) as Partial<CutoverMarker>;
    if (marker.enabled === true) {
      throw new Error("legacy JSONL delivery is retired after source-feed cutover");
    }
  } catch (error: any) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
}

async function inventoryOneFile(
  path: string,
  index: number,
): Promise<LegacyFileInventory> {
  const inventory = emptyInventory(safeFileLabel(path, index));
  let input;
  try {
    input = createReadStream(path, { encoding: "utf8" });
    await new Promise<void>((resolve, reject) => {
      input!.once("open", () => resolve());
      input!.once("error", reject);
    });
  } catch (error: any) {
    if (error?.code === "ENOENT") return inventory;
    throw error;
  }

  const lines = createInterface({ input, crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.trim()) continue;
    inventory.records += 1;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      inventory.malformedRecords += 1;
      inventory.unmappableRecords += 1;
      increment(inventory.unmappableReasons, "malformed_json");
      continue;
    }

    const reason = unmappableReason(value);
    if (reason) {
      inventory.unmappableRecords += 1;
      increment(inventory.unmappableReasons, reason);
      continue;
    }

    const entry = value as { ts: number; kind: string };
    inventory.mappableRecords += 1;
    increment(inventory.types, entry.kind);
    const occurredAt = new Date(entry.ts).toISOString();
    inventory.firstOccurredAt = earliest(inventory.firstOccurredAt, occurredAt);
    inventory.lastOccurredAt = latest(inventory.lastOccurredAt, occurredAt);
  }
  return inventory;
}

function emptyInventory(file: string): LegacyFileInventory {
  return {
    file,
    records: 0,
    mappableRecords: 0,
    unmappableRecords: 0,
    malformedRecords: 0,
    firstOccurredAt: null,
    lastOccurredAt: null,
    types: {},
    unmappableReasons: {},
  };
}

function safeFileLabel(path: string, index: number): string {
  const name = basename(path);
  return name.endsWith(".jsonl")
    ? `legacy-${index + 1}:${name}`
    : `legacy-${index + 1}.jsonl`;
}

function unmappableReason(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "not_an_object";
  }
  const entry = value as Record<string, unknown>;
  if (typeof entry.id !== "string" || entry.id.length === 0) return "missing_id";
  if (
    typeof entry.ts !== "number" ||
    !Number.isFinite(entry.ts) ||
    entry.ts < 0 ||
    Number.isNaN(new Date(entry.ts).valueOf())
  ) {
    return "invalid_timestamp";
  }
  if (typeof entry.kind !== "string" || entry.kind.length === 0) return "missing_type";
  if (!SUPPORTED_LEGACY_KINDS.has(entry.kind)) return "unsupported_type";
  if (typeof entry.entityId !== "string" || entry.entityId.length === 0) {
    return "missing_entity_reference";
  }
  if (!entry.payload || typeof entry.payload !== "object" || Array.isArray(entry.payload)) {
    return "invalid_payload_shape";
  }
  return null;
}

const SUPPORTED_LEGACY_KINDS = new Set(["math_mistake", "game-session"]);

async function readPid(path: string): Promise<number | null> {
  try {
    const raw = (await readFile(path, "utf8")).trim();
    if (!/^[1-9][0-9]*$/.test(raw)) return null;
    const pid = Number(raw);
    return Number.isSafeInteger(pid) ? pid : null;
  } catch (error: any) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function processIsRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: any) {
    return error?.code === "EPERM";
  }
}

function increment(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

function mergeCounts(
  target: Record<string, number>,
  source: Record<string, number>,
): void {
  for (const [key, count] of Object.entries(source)) {
    target[key] = (target[key] ?? 0) + count;
  }
}

function earliest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left < right ? left : right;
}

function latest(left: string | null, right: string | null): string | null {
  if (left === null) return right;
  if (right === null) return left;
  return left > right ? left : right;
}

import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  enableSourceFeedCutover,
  inventoryLegacyJsonl,
} from "./legacy-cutover.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../..");
const markerPath = process.env.SOURCE_FEED_CUTOVER_MARKER ??
  join(root, "data/source-feed-cutover.json");
const workerPidPaths = [
  process.env.NEXUS_PIDFILE ?? join(root, "server/data/nexus-worker.pid"),
  process.env.FEISHU_PIDFILE ?? join(root, "server/data/feishu-notify.pid"),
  process.env.WEBHOOK_PIDFILE ?? join(root, "server/data/webhook-notify.pid"),
  join(root, "data/nexus-worker.pid"),
  join(root, "data/feishu-notify.pid"),
  join(root, "data/webhook-notify.pid"),
];
const defaultLegacyFiles = [
  join(root, "server/data/nexus-outbox.jsonl"),
  join(root, "server/data/nexus-outbox.processed.jsonl"),
  join(root, "data/nexus-outbox.jsonl"),
  join(root, "data/nexus-outbox.processed.jsonl"),
];

export async function runLegacyCutoverCli(argv: string[]): Promise<number> {
  const [command = "inventory", ...providedFiles] = argv;
  const legacyFiles = providedFiles.length > 0 ? providedFiles : defaultLegacyFiles;
  if (command === "inventory") {
    console.log(JSON.stringify(await inventoryLegacyJsonl(legacyFiles), null, 2));
    return 0;
  }
  if (command === "enable") {
    const result = await enableSourceFeedCutover({
      markerPath,
      workerPidPaths,
      legacyFiles,
    });
    console.log(JSON.stringify({ marker: result.marker, inventory: result.inventory }, null, 2));
    return 0;
  }
  throw new Error("usage: source-feed-cutover inventory|enable [legacy.jsonl ...]");
}

if (import.meta.url === `file://${process.argv[1]}`) {
  runLegacyCutoverCli(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(`[source-feed-cutover] ${(error as Error).message}`);
      process.exit(1);
    },
  );
}

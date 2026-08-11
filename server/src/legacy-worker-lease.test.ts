import { afterEach, describe, expect, it } from "vitest";
import {
  execFileSync,
  spawn,
  spawnSync,
  type ChildProcess,
} from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { enableSourceFeedCutover } from "./legacy-cutover.js";

const helperPath = resolve(process.cwd(), "../bin/legacy-worker-lease.sh");
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "legacy-worker-lease-"));
  dirs.push(dir);
  return dir;
}

function shellEnv(values: Record<string, string>): NodeJS.ProcessEnv {
  return {
    ...process.env,
    LEASE_HELPER: helperPath,
    ...values,
  };
}

async function waitForFile(path: string): Promise<void> {
  for (let attempt = 0; attempt < 1_000; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  throw new Error(`timed out waiting for ${path}`);
}

async function waitForChild(child: ChildProcess): Promise<void> {
  let stderr = "";
  child.stderr?.on("data", (chunk) => {
    stderr += String(chunk);
  });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", resolveExit);
  });
  if (code !== 0) throw new Error(`child exited ${code}: ${stderr}`);
}

afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("shared legacy worker lease", () => {
  it("guards every retired worker with the shared post-acquire marker check", () => {
    const dir = tempDir();
    const markerPath = join(dir, "cutover.json");
    writeFileSync(markerPath, '{"version":1,"enabled":true}\n');
    for (const [script, pidVariable] of [
      ["nexus-worker.sh", "NEXUS_PIDFILE"],
      ["feishu-notify.sh", "FEISHU_PIDFILE"],
      ["webhook-notify.sh", "WEBHOOK_PIDFILE"],
    ] as const) {
      const pidPath = join(dir, `${script}.pid`);
      const result = spawnSync("bash", [resolve(process.cwd(), `../bin/${script}`), "once"], {
        env: {
          ...process.env,
          SOURCE_FEED_CUTOVER_MARKER: markerPath,
          [pidVariable]: pidPath,
        },
        encoding: "utf8",
      });
      expect(result.status).toBe(5);
      expect(result.stdout).toContain("retired after source-feed cutover");
      expect(existsSync(`${pidPath}.lock`)).toBe(false);
    }
  });

  it("rechecks the marker after acquiring when cutover wins the interleaving", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "worker.pid");
    const markerPath = join(dir, "cutover.json");
    const readyPath = join(dir, "ready");
    const goPath = join(dir, "go");
    const resultPath = join(dir, "result");
    const worker = spawn(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$LEASE_HELPER"
printf ready >"$READY_PATH"
while [[ ! -f "$GO_PATH" ]]; do sleep 0.01; done
legacy_worker_acquire_lease
token=$LEGACY_WORKER_LEASE_TOKEN
if legacy_worker_cutover_is_enabled; then
  printf blocked >"$RESULT_PATH"
else
  printf allowed >"$RESULT_PATH"
fi
legacy_worker_release_lease "$token" "$$"`,
      ],
      {
        env: shellEnv({
          PIDFILE: pidPath,
          CUTOVER_MARKER: markerPath,
          READY_PATH: readyPath,
          GO_PATH: goPath,
          RESULT_PATH: resultPath,
        }),
        stdio: ["ignore", "pipe", "pipe"],
      },
    );

    await waitForFile(readyPath);
    await enableSourceFeedCutover({
      markerPath,
      workerPidPaths: [pidPath],
      legacyFiles: [],
    });
    writeFileSync(goPath, "go");
    await waitForChild(worker);

    expect(readFileSync(resultPath, "utf8")).toBe("blocked");
    expect(existsSync(`${pidPath}.lock`)).toBe(false);
  });

  it("does not let an old stop release a newly reacquired lease", async () => {
    const dir = tempDir();
    const pidPath = join(dir, "worker.pid");
    const markerPath = join(dir, "cutover.json");
    const readyPath = join(dir, "new-owner");
    const goPath = join(dir, "release-new-owner");
    const env = shellEnv({
      PIDFILE: pidPath,
      CUTOVER_MARKER: markerPath,
      READY_PATH: readyPath,
      GO_PATH: goPath,
    });
    const oldOwner = execFileSync(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$LEASE_HELPER"
legacy_worker_acquire_lease
printf "%s:%s" "$LEGACY_WORKER_LEASE_TOKEN" "$$"`,
      ],
      { env, encoding: "utf8" },
    );
    const [oldToken, oldPid] = oldOwner.split(":");

    const newOwner = spawn(
      "bash",
      [
        "-c",
        `set -euo pipefail
source "$LEASE_HELPER"
legacy_worker_acquire_lease
token=$LEGACY_WORKER_LEASE_TOKEN
printf "%s:%s" "$token" "$$" >"$READY_PATH"
while [[ ! -f "$GO_PATH" ]]; do sleep 0.01; done
legacy_worker_release_lease "$token" "$$"`,
      ],
      { env, stdio: ["ignore", "pipe", "pipe"] },
    );
    await waitForFile(readyPath);
    const [newToken, newPid] = readFileSync(readyPath, "utf8").split(":");

    const staleReleaseStatus = execFileSync(
      "bash",
      [
        "-c",
        `set +e
source "$LEASE_HELPER"
legacy_worker_release_lease "$OLD_TOKEN" "$OLD_PID"
printf "%s" "$?"`,
      ],
      {
        env: { ...env, OLD_TOKEN: oldToken, OLD_PID: oldPid },
        encoding: "utf8",
      },
    );
    expect(staleReleaseStatus).toBe("1");
    expect(readFileSync(`${pidPath}.lock/token`, "utf8").trim()).toBe(newToken);
    expect(readFileSync(pidPath, "utf8").trim()).toBe(newPid);

    const thirdAcquire = execFileSync(
      "bash",
      [
        "-c",
        `set +e
source "$LEASE_HELPER"
legacy_worker_acquire_lease
printf "%s" "$?"`,
      ],
      { env, encoding: "utf8" },
    );
    expect(thirdAcquire).toBe("1");

    writeFileSync(goPath, "go");
    await waitForChild(newOwner);
    expect(existsSync(`${pidPath}.lock`)).toBe(false);
  });

  it("keeps one lease-owning supervisor across daemon start and stop", async () => {
    const dir = tempDir();
    const fakeBin = join(dir, "bin");
    const fakeNpx = join(fakeBin, "npx");
    execFileSync("mkdir", ["-p", fakeBin]);
    writeFileSync(
      fakeNpx,
      `#!/usr/bin/env bash
printf "%s" "$PPID" >"$FAKE_CHILD_PARENT_FILE"
trap 'printf stopped >"$FAKE_CHILD_STOPPED_FILE"; exit 0' INT TERM
while true; do sleep 0.05; done
`,
    );
    chmodSync(fakeNpx, 0o755);

    for (const [script, pidVariable, logVariable] of [
      ["nexus-worker.sh", "NEXUS_PIDFILE", "NEXUS_LOGFILE"],
      ["feishu-notify.sh", "FEISHU_PIDFILE", "FEISHU_LOGFILE"],
      ["webhook-notify.sh", "WEBHOOK_PIDFILE", "WEBHOOK_LOGFILE"],
    ] as const) {
      const pidPath = join(dir, `${script}.pid`);
      const parentPath = join(dir, `${script}.parent`);
      const stoppedPath = join(dir, `${script}.stopped`);
      const scriptPath = resolve(process.cwd(), `../bin/${script}`);
      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SOURCE_FEED_CUTOVER_MARKER: join(dir, "not-cut-over.json"),
        FAKE_CHILD_PARENT_FILE: parentPath,
        FAKE_CHILD_STOPPED_FILE: stoppedPath,
        [pidVariable]: pidPath,
        [logVariable]: join(dir, `${script}.log`),
      };

      const started = spawnSync("bash", [scriptPath, "start"], {
        env,
        encoding: "utf8",
      });
      expect(started.status, started.stderr).toBe(0);
      await waitForFile(parentPath);
      const supervisorPid = readFileSync(pidPath, "utf8").trim();
      expect(readFileSync(`${pidPath}.lock/pid`, "utf8").trim()).toBe(
        supervisorPid,
      );
      expect(readFileSync(parentPath, "utf8").trim()).toBe(supervisorPid);

      const stopped = spawnSync("bash", [scriptPath, "stop"], {
        env,
        encoding: "utf8",
      });
      expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      expect(existsSync(stoppedPath)).toBe(true);
      expect(existsSync(pidPath)).toBe(false);
      expect(existsSync(`${pidPath}.lock`)).toBe(false);
    }
  }, 20_000);

  it("does not release the lease until a TERM-ignoring child is gone", async () => {
    const dir = tempDir();
    const fakeBin = join(dir, "bin");
    const fakeNpx = join(fakeBin, "npx");
    const pidPath = join(dir, "nexus.pid");
    const termPath = join(dir, "term-received");
    const childReadyPath = join(dir, "child-ready");
    execFileSync("mkdir", ["-p", fakeBin]);
    writeFileSync(
      fakeNpx,
      `#!/usr/bin/env bash
trap 'printf term >"$FAKE_TERM_FILE"' TERM
printf ready >"$FAKE_CHILD_READY_FILE"
while true; do sleep 0.05; done
`,
    );
    chmodSync(fakeNpx, 0o755);
    const scriptPath = resolve(process.cwd(), "../bin/nexus-worker.sh");
    const env = {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
      SOURCE_FEED_CUTOVER_MARKER: join(dir, "not-cut-over.json"),
      FAKE_TERM_FILE: termPath,
      FAKE_CHILD_READY_FILE: childReadyPath,
      NEXUS_PIDFILE: pidPath,
      NEXUS_LOGFILE: join(dir, "nexus.log"),
    };

    const started = spawnSync("bash", [scriptPath, "start"], {
      env,
      encoding: "utf8",
    });
    expect(started.status, started.stderr).toBe(0);
    await waitForFile(`${pidPath}.lock/child-pid`);
    await waitForFile(childReadyPath);
    const childPid = readFileSync(
      `${pidPath}.lock/child-pid`,
      "utf8",
    ).trim();

    const stopped = spawnSync("bash", [scriptPath, "stop"], {
      env,
      encoding: "utf8",
    });
    expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
    expect(existsSync(termPath)).toBe(true);
    const childState = spawnSync("ps", ["-o", "stat=", "-p", childPid], {
      encoding: "utf8",
    }).stdout.trim();
    expect(childState === "" || childState.startsWith("Z")).toBe(true);
    expect(existsSync(pidPath)).toBe(false);
    expect(existsSync(`${pidPath}.lock`)).toBe(false);
  }, 20_000);

  it("tracks TERM-ignoring children during every once drain", async () => {
    const dir = tempDir();
    const fakeBin = join(dir, "bin");
    const fakeNpx = join(fakeBin, "npx");
    execFileSync("mkdir", ["-p", fakeBin]);
    writeFileSync(
      fakeNpx,
      `#!/usr/bin/env bash
trap 'printf term >"$FAKE_TERM_FILE"' TERM
printf ready >"$FAKE_CHILD_READY_FILE"
while true; do sleep 0.05; done
`,
    );
    chmodSync(fakeNpx, 0o755);

    for (const [script, pidVariable, logVariable] of [
      ["nexus-worker.sh", "NEXUS_PIDFILE", "NEXUS_LOGFILE"],
      ["feishu-notify.sh", "FEISHU_PIDFILE", "FEISHU_LOGFILE"],
      ["webhook-notify.sh", "WEBHOOK_PIDFILE", "WEBHOOK_LOGFILE"],
    ] as const) {
      const pidPath = join(dir, `${script}.once.pid`);
      const childReadyPath = join(dir, `${script}.once.ready`);
      const termPath = join(dir, `${script}.once.term`);
      const scriptPath = resolve(process.cwd(), `../bin/${script}`);
      const env = {
        ...process.env,
        PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        SOURCE_FEED_CUTOVER_MARKER: join(dir, "not-cut-over.json"),
        FAKE_CHILD_READY_FILE: childReadyPath,
        FAKE_TERM_FILE: termPath,
        [pidVariable]: pidPath,
        [logVariable]: join(dir, `${script}.once.log`),
      };
      const once = spawn("bash", [scriptPath, "once"], {
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      await waitForFile(childReadyPath);
      const childPid = readFileSync(
        `${pidPath}.lock/child-pid`,
        "utf8",
      ).trim();

      const stopped = spawnSync("bash", [scriptPath, "stop"], {
        env,
        encoding: "utf8",
      });
      expect(stopped.status, `${stopped.stdout}\n${stopped.stderr}`).toBe(0);
      await new Promise<void>((resolveExit, reject) => {
        once.once("error", reject);
        once.once("exit", () => resolveExit());
      });
      expect(existsSync(termPath)).toBe(true);
      const childState = spawnSync("ps", ["-o", "stat=", "-p", childPid], {
        encoding: "utf8",
      }).stdout.trim();
      expect(childState === "" || childState.startsWith("Z")).toBe(true);
      expect(existsSync(pidPath)).toBe(false);
      expect(existsSync(`${pidPath}.lock`)).toBe(false);
    }
  }, 30_000);
});

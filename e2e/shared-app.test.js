// Exercise the verifier CLI against this checkout, never a shared instance.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";
import express from "../server/node_modules/express/index.js";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));

async function startFixture(t, { missingHelper = false } = {}) {
  const app = express();
  // Only the shared helper's HTTP contract is real here, not domain APIs.
  app.get("/api/health", (_req, res) => res.json({ ok: true, env: "test" }));
  app.get("/api/buddy/status", (_req, res) =>
    res.json({ chatEnabled: false, unlocked: false }),
  );
  app.get("/api/capture/inbox", (_req, res) => res.json({ items: [] }));
  app.get("/api/write/words", (_req, res) => res.json({ words: [] }));
  app.get("/api/dictation/sets", (_req, res) => res.json({ sets: [] }));
  app.get("/api/game/daily", (_req, res) => res.json({ days: [] }));
  app.get("/api/game/weak-topics", (_req, res) => res.json({ topics: [] }));
  if (missingHelper) {
    const source = await readFile(
      new URL("../web/shared/app.js", import.meta.url),
      "utf8",
    );
    app.get("/shared/app.js", (_req, res) =>
      res.type("js").send(source + "\ndelete window.StudyBuddy.cameraPause;"),
    );
  }
  app.use(express.static(fileURLToPath(new URL("../web/", import.meta.url))));
  const server = await new Promise((resolve, reject) => {
    const listening = app.listen(0, "127.0.0.1", () => resolve(listening));
    listening.once("error", reject);
  });
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test("shared-app CLI verifies all three real pages without a live service", async (t) => {
  const base = await startFixture(t);
  const { stdout } = await exec(
    process.execPath,
    ["scripts/verify-shared-app.js"],
    {
      cwd: root,
      env: { ...process.env, TEST_URL: base },
      timeout: 45000,
    },
  );
  for (const name of ["buddy", "write", "candy"]) {
    assert.match(stdout, new RegExp(`${name}: StudyBuddy =`));
    assert.match(stdout, new RegExp(`${name}: warmupTTS`));
    assert.match(stdout, new RegExp(`${name}: fetch ok keys`));
  }
  assert.match(
    stdout,
    /OK: shared\/app.js is loaded \+ functional on buddy, write, candy/,
  );
});

test("shared-app CLI rejects an invalid target with the safe command to use", async () => {
  await assert.rejects(
    exec(process.execPath, ["scripts/verify-shared-app.js"], {
      cwd: root,
      env: { ...process.env, TEST_URL: "file:///must-not-run" },
      timeout: 10000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(
        error.stderr,
        /TEST_URL must be an explicit HTTP\(S\) origin/,
      );
      assert.match(error.stderr, /npm run test:shared-app/);
      return true;
    },
  );
});

test("shared-app CLI has no implicit live target", async () => {
  await assert.rejects(
    exec(process.execPath, ["scripts/verify-shared-app.js"], {
      cwd: root,
      env: { ...process.env, TEST_URL: "" },
      timeout: 10000,
    }),
    (error) => {
      assert.equal(error.code, 1);
      assert.match(error.stderr, /npm run test:shared-app/);
      return true;
    },
  );
});

test("shared-app CLI fails and releases its browser when a helper is missing", async (t) => {
  const base = await startFixture(t, { missingHelper: true });
  await assert.rejects(
    exec(process.execPath, ["scripts/verify-shared-app.js"], {
      cwd: root,
      env: { ...process.env, TEST_URL: base },
      timeout: 10000,
    }),
    (error) => {
      assert.equal(
        error.code,
        1,
        "must exit on the assertion, not a timeout kill",
      );
      assert.equal(error.killed, false);
      assert.match(error.stderr, /buddy: StudyBuddy.cameraPause missing/);
      assert.doesNotMatch(error.stdout, /OK: shared/);
      return true;
    },
  );
});

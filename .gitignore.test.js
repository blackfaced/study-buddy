// TDD test: .gitignore must keep ignoring the patterns that protect
// secrets, runtime data, and worktree state. The v0.8.16 candy
// start-button fix PR (ab7db61) accidentally replaced the project's
// full .gitignore with the worktree-local two-line version the dev
// had in their checkout, so the next `git add .` would have committed
// study.db, server.key, server.cert, node_modules/, .worktrees/.
//
// This test fails fast on that regression. It does not care about
// order, comments, or whitespace — only the presence of the patterns.
//
// Run: node .gitignore.test.js
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const __dirname = dirname(fileURLToPath(import.meta.url));
const gitignore = readFileSync(join(__dirname, ".gitignore"), "utf8");

// Each pattern is checked as a separate case so the failure output
// names exactly which rule went missing.
const cases = [
  { pattern: "node_modules/", reason: "node_modules otherwise pollutes the repo and bloats every push" },
  { pattern: ".DS_Store", reason: "macOS Finder metadata otherwise leaks through" },
  { pattern: "data/*.db", reason: "SQLite WAL files would corrupt the repo if committed mid-session" },
  { pattern: "data/*.db-shm", reason: "SQLite shared-memory file shares the WAL risk" },
  { pattern: "data/*.db-wal", reason: "SQLite write-ahead log shares the WAL risk" },
  { pattern: ".env", reason: "MINIMAX_API_KEY and INTEGRATION_API_TOKEN would leak" },
  { pattern: ".env.local", reason: "any other env override must not be committed" },
  { pattern: "*.pem", reason: "mkcert / LetsEncrypt certs would be published" },
  { pattern: "server.cert", reason: "local HTTPS cert is per-machine and must not be shared" },
  { pattern: "server.key", reason: "local HTTPS private key is per-machine and must not be shared" },
  { pattern: ".worktrees/", reason: "git worktree checkouts must not appear inside the main checkout" },
  { pattern: "coverage/", reason: "vitest coverage output would otherwise show up as untracked noise" },
];

for (const { pattern, reason } of cases) {
  test(`.gitignore contains ${JSON.stringify(pattern)} — ${reason}`, () => {
    assert.match(
      gitignore,
      new RegExp(`^${escapeForLiteral(pattern)}$`, "m"),
      `missing pattern ${pattern} from .gitignore; a previous fix once deleted the whole file (PR #138). ` +
        `Restore the original .gitignore before committing.`,
    );
  });
}

function escapeForLiteral(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

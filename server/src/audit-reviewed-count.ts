// server/src/audit-reviewed-count.ts
//
// T10: pure helper. Scans the server source tree for any code path
// that still reads or writes the `reviewed_count` column on
// `correction_obligations` (or the legacy `mistakes` table) and
// returns the list of files. After T10 ships, the audit should
// return [] (no live writer; only the legacy cascade-delete path
// in the 410'd `/api/game/mistake-review` route is allowed to
// reference it for the brief sunset window).
//
// v0.1 砍半: in-process grep, no fs traversal. Caller passes in the
// list of source files to scan.

import { readFileSync } from "node:fs";

export interface ReviewedCountUsage {
  file: string;
  line: number;
  text: string;
}

const PATTERNS: ReadonlyArray<RegExp> = [
  /\breviewed_count\b/,
  /correction_obligations\s*\.\s*reviewed_count/i,
  /UPDATE\s+correction_obligations[^;]*reviewed_count/i,
  /SET\s+reviewed_count\s*=/i,
];

/**
 * Scan a single source file for reviewed_count references.
 * Pure (read-only on disk; no I/O side effects on the running
 * server). Returns the matches with 1-indexed line numbers.
 */
export function auditFile(
  filePath: string,
  content?: string,
): ReviewedCountUsage[] {
  const text = content ?? readFileSync(filePath, "utf8");
  const lines = text.split(/\r?\n/);
  const out: ReviewedCountUsage[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (PATTERNS.some((p) => p.test(line))) {
      out.push({ file: filePath, line: i + 1, text: line.trim() });
    }
  }
  return out;
}

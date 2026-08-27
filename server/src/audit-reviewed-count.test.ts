// server/src/audit-reviewed-count.test.ts
//
// T10-2: auditFile is a pure scanner. Returns one entry per
// reviewed_count mention with a 1-indexed line number.

import { describe, it, expect } from "vitest";
import { auditFile } from "./audit-reviewed-count.js";

describe("auditReviewedCountUsage (T10 PR-C)", () => {
  it("T10-2a: returns 1 match for a single reviewed_count line", () => {
    const content = "const x = 1;\nUPDATE correction_obligations SET reviewed_count = reviewed_count + 1;\n";
    const out = auditFile("/fake/file.ts", content);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ file: "/fake/file.ts", line: 2 });
    expect(out[0].text).toMatch(/UPDATE correction_obligations/);
  });

  it("T10-2b: returns 0 matches for a file with no reviewed_count", () => {
    const content = [
      "import { foo } from 'bar';",
      "const x = 1;",
      "function noop() { return x; }",
    ].join("\n");
    expect(auditFile("/fake/clean.ts", content)).toEqual([]);
  });

  it("T10-2c: returns multiple matches in order", () => {
    const content = [
      "// line 1",
      "const reviewed_count = 0;", // hits
      "// line 3",
      "co.reviewed_count + 1",   // hits (pattern 2)
      "// line 5",
      "SET reviewed_count = 1",  // hits (pattern 4)
    ].join("\n");
    const out = auditFile("/fake/m.ts", content);
    expect(out.map((m) => m.line)).toEqual([2, 4, 6]);
  });
});

// server/vitest.config.ts
//
// Coverage configuration for the HTTP server.
//
//   - Provider: v8 (built into node, no extra browser-side deps)
//   - Reporter: text + lcov (lcov is the standard for Codecov /
//     Coveralls badges if you wire those up later)
//   - Excludes:  index.ts (server entry; covered by integration
//     smoke tests), db-migrate.ts (pure SQL DDL, exercised by
//     every test that opens a DB), and the tests themselves
//   - Thresholds: fail CI if overall coverage drops below 75%.
//     We're not at 100% (lots of error branches in route handlers
//     are tested for the success path only). The threshold is a
//     tripwire for "we accidentally removed test coverage" rather
//     than a quality bar. Bump it as we close gaps.

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/db-migrate.ts",
        "src/**/*.test.ts",
        "src/types.ts",
      ],
      thresholds: {
        // Lines:   75% — current baseline
        // Branches: 75% — same
        // Functions: 80% — slightly higher (we want every public
        //   function exercised)
        lines: 75,
        branches: 75,
        functions: 80,
        statements: 75,
      },
    },
  },
});

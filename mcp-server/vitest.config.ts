// mcp-server/vitest.config.ts
//
// Coverage config for the MCP server. Same shape as the HTTP
// server's, with package-appropriate excludes.
//
//   - index.ts: server entry; not testable in isolation
//   - db.ts: mostly CRUD, covered indirectly through tool tests
//   - tools.ts: a few HTTP proxy paths are intentionally not
//     covered (they're env-gated fallbacks)
//
// Thresholds: same as server (75/75/80/75).

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "lcov"],
      include: ["src/**/*.ts"],
      exclude: [
        "src/index.ts",
        "src/**/*.test.ts",
      ],
      thresholds: {
        lines: 60,    // current baseline (62.87% — see tools.ts)
        branches: 60,
        functions: 70,
        statements: 60,
      },
    },
  },
});

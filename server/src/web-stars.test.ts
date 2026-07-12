import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const HTML = readFileSync(resolve(__dirname, "../../web/index.html"), "utf-8");

// Bug 5: v0.1 web client had a "stars" indicator that incremented per
// message. User explicitly asked for it removed. This test guards against
// any future PR that re-introduces it.
describe("web/index.html (Bug 5: no per-message stars)", () => {
  it('contains no <div class="stars">', () => {
    expect(HTML).not.toMatch(/<div class="stars"/);
  });

  it('contains no id="stars"', () => {
    expect(HTML).not.toMatch(/id="stars"/);
  });

  it("contains no .stars CSS selector", () => {
    expect(HTML).not.toMatch(/\.stars\s*\{/);
  });

  it("contains no starsEl variable", () => {
    expect(HTML).not.toMatch(/starsEl/);
  });
});

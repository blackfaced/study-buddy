// server/src/routes/portal.test.ts
//
// Tests for the portal route module extracted from app.ts (PR 1 of
// the refactor series). We test the module via a fresh mini express
// app instead of the full createApp() — that's the whole point of
// the extraction: each route module is independently testable and
// can be mounted on its own.
//
// What the module owns (was inline in app.ts):
//   - GET /              iOS Safari cache-bust redirect (302 → /?v=...)
//   - GET /<anything>    express.static for the web/ dir, with HTML
//                        cache headers (no-cache, no-store, no etag)
//   - GET /api/apps      apps registry for the platform portal
//
// Why we test in isolation:
//   The full createApp() already has portal.test.ts covering the
//   integrated behaviour. These tests pin the contract of the
//   portal module by itself — if a future change in another route
//   module accidentally clobbers a portal route, the integration
//   test will catch it; if the portal module itself regresses, this
//   test will catch it first.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import express from "express";
import request from "supertest";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { APPS, registerPortalRoutes, type AppDescriptor } from "./portal.js";

let webDir: string;
let app: ReturnType<typeof express>;

beforeAll(() => {
  // Build a minimal web dir: portal.html with a marker string the
  // tests can grep for. We avoid baking the production web/ into the
  // test fixture so the test is independent of repo layout.
  webDir = mkdtempSync(join(tmpdir(), "portal-test-"));
  mkdirSync(join(webDir, "buddy"), { recursive: true });
  writeFileSync(join(webDir, "index.html"), "<html>PORTAL_LANDING</html>");
  writeFileSync(join(webDir, "buddy", "index.html"), "<html>PORTAL_BUDDY</html>");

  app = express();
  registerPortalRoutes(app, webDir);
});

afterAll(() => {
  // best-effort cleanup; tmpdir is OS-managed so we don't need
  // a strict teardown assertion.
});

// --- /api/apps --------------------------------------------------------

describe("GET /api/apps", () => {
  it("returns a 200 with apps array", async () => {
    const res = await request(app).get("/api/apps");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.apps)).toBe(true);
    expect(res.body.apps.length).toBeGreaterThan(0);
  });

  it("includes the candy-math-island app", async () => {
    const res = await request(app).get("/api/apps");
    const candy = (res.body.apps as AppDescriptor[]).find((a) => a.id === "candy-math-island");
    expect(candy).toBeDefined();
    expect(candy?.url).toBe("/games/candy-math-island/");
  });

  it("includes the write app", async () => {
    const res = await request(app).get("/api/apps");
    const write = (res.body.apps as AppDescriptor[]).find((a) => a.id === "write");
    expect(write).toBeDefined();
    expect(write?.url).toBe("/write/");
  });

  it("each app has the required descriptor fields", async () => {
    const res = await request(app).get("/api/apps");
    for (const a of res.body.apps as AppDescriptor[]) {
      expect(a.id).toBeTypeOf("string");
      expect(a.name).toBeTypeOf("string");
      expect(a.url).toBeTypeOf("string");
      expect(a.emoji).toBeTypeOf("string");
      expect(a.description).toBeTypeOf("string");
      expect(["ready", "draft"]).toContain(a.status);
    }
  });
});

// --- APPS export ------------------------------------------------------

describe("APPS export", () => {
  it("is non-empty and read-only-shape (frozen shape, not contract)", () => {
    // We don't assert deep-frozen; the contract is that it's an
    // array of AppDescriptors. If you want to mutate it, copy first.
    expect(APPS.length).toBeGreaterThan(0);
    for (const a of APPS) {
      expect(a).toHaveProperty("id");
      expect(a).toHaveProperty("name");
      expect(a).toHaveProperty("url");
    }
  });
});

// --- /  (root) cache-bust redirect ------------------------------------

describe("GET / (cache-bust redirect)", () => {
  it("redirects to /?v=<ts> when no query string is present", async () => {
    const res = await request(app).get("/");
    expect(res.status).toBe(302);
    expect(res.headers.location).toMatch(/^\/\?v=\d+$/);
  });

  it("does NOT redirect when a query string is present (avoid loop)", async () => {
    // The 302 target is /?v=… — if the static handler also tried to
    // redirect, we'd loop forever in the browser. The rule is: only
    // redirect when req.query is empty.
    const res = await request(app).get("/?v=1");
    expect(res.status).toBe(200);
  });

  it("serves the index.html on the cache-busted URL", async () => {
    const res = await request(app).get("/?v=anything");
    expect(res.status).toBe(200);
    expect(res.text).toContain("PORTAL_LANDING");
  });
});

// --- HTML cache headers ----------------------------------------------

describe("static HTML cache headers", () => {
  it("sets no-cache headers on HTML files (iOS Safari fix)", async () => {
    const res = await request(app).get("/?v=1");
    expect(res.headers["cache-control"]).toBe("no-cache, no-store, must-revalidate");
    expect(res.headers["pragma"]).toBe("no-cache");
    expect(res.headers["expires"]).toBe("0");
  });

  it("removes ETag on HTML responses (Safari 304 trap)", async () => {
    const res = await request(app).get("/?v=1");
    expect(res.headers["etag"]).toBeUndefined();
  });

  it("serves static subpath HTML (e.g. /buddy/)", async () => {
    const res = await request(app).get("/buddy/?v=1");
    expect(res.status).toBe(200);
    expect(res.text).toContain("PORTAL_BUDDY");
  });
});

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = new Database(":memory:");
  migrateSchema(db);
  app = createApp({ db, httpsPort: 3000 });
});

afterAll(() => db.close());

describe("platform entry routes", () => {
  it("serves the portal at the root path", async () => {
    const landing = await request(app).get("/");
    expect(landing.status).toBe(302);
    expect(landing.headers.location).toMatch(/^\/\?v=/);

    const res = await request(app).get("/?v=test");
    expect(res.status).toBe(200);
    expect(res.text).toContain("小书童学习空间");
    expect(res.text).toContain('href="/buddy/"');
  });

  it("serves the companion at /buddy/", async () => {
    const res = await request(app).get("/buddy/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("跟小书童说句话");
  });

  it("keeps Candy Math Island at its existing path", async () => {
    const res = await request(app).get("/games/candy-math-island/");
    expect(res.status).toBe(200);
    expect(res.text).toContain("糖果口算岛");
  });

  it("keeps API routes available alongside the portal", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ ok: true, service: "study-buddy" });
  });

  it("serves the write app at /write/", async () => {
    const res = await request(app).get("/write/");
    expect(res.status).toBe(200);
    expect(res.text).toContain('/vendor/hanzi-writer-3.5.0.min.js');
    expect(res.text).not.toContain("cdn.jsdelivr.net");

    const vendor = await request(app).get("/vendor/hanzi-writer-3.5.0.min.js");
    expect(vendor.status).toBe(200);
    expect(vendor.text.length).toBeGreaterThan(30_000);
  });

  it("write app appears in /api/apps registry (issue #57)", async () => {
    const res = await request(app).get("/api/apps");
    expect(res.status).toBe(200);
    const write = (res.body.apps as Array<{ id: string; name: string; url: string; emoji: string }>)
      .find((a) => a.id === "write");
    expect(write).toBeDefined();
    expect(write?.name).toBe("写字练字");
    expect(write?.url).toBe("/write/");
  });
});

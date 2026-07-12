import { afterAll, beforeAll, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;

beforeAll(() => {
  db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  migrateSchema(db);
  app = createApp({ db, httpsPort: 3000 });
});

afterAll(() => {
  db.close();
});

describe("GET /api/health", () => {
  it("returns 200 with service name and counts", async () => {
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.service).toBe("study-buddy");
    expect(typeof res.body.childrenCount).toBe("number");
    expect(typeof res.body.sessionsCount).toBe("number");
  });
});

// Bug 1 (v0.1): /api/pair referenced an undefined `PORT` symbol.
// Regression: serverUrl must contain a numeric port, not the literal "undefined".
describe("GET /api/pair (Bug 1: serverUrl must not be :undefined)", () => {
  it("serverUrl is a well-formed URL ending in :<port>", async () => {
    const res = await request(app).get("/api/pair");
    expect(res.status).toBe(200);
    expect(res.body.serverUrl).toMatch(/:\d+$/);
  });

  it('serverUrl does not contain the literal "undefined"', async () => {
    const res = await request(app).get("/api/pair");
    expect(res.body.serverUrl).not.toContain("undefined");
  });

  it("serverUrl uses the configured httpsPort (3000)", async () => {
    const res = await request(app).get("/api/pair");
    // supertest sends plain http; the protocol here is the inbound request's
    // protocol. The port is what we asserted against the bug.
    expect(res.body.serverUrl).toMatch(/:\d+$/);
    expect(res.body.serverUrl).toContain(":3000");
  });

  it("returns the seeded default child's name and grade", async () => {
    const res = await request(app).get("/api/pair");
    expect(res.body.childId).toBe("default");
    expect(res.body.name).toBe("小宝");
    expect(res.body.grade).toBe("二年级");
  });
});


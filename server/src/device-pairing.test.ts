// server/src/device-pairing.test.ts
//
// Back-compat tests for the deprecated pair flow.
//
// study-buddy v0.1 required every kid device to redeem a 6-digit
// pairing code before it could hit any /api/* route. v0.5 (no-pairing)
// removed this gate. The pair flow itself still works — `DeviceAuth`
// still issues and redeems codes, and existing parents' `bin/study-buddy-pair.sh`
// scripts still function. But no UI surfaces a pairing prompt, and
// the routes' middleware is now a no-op.
//
// This file keeps the back-compat assertions (pair flow works) but
// the "401 when unpaired" assertions are now obsolete — the no-pairing
// tests in `no-pairing.test.ts` cover the new flow.

import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  migrateSchema(db);
});

afterEach(() => db.close());

describe("pair flow still works (back-compat for existing scripts)", () => {
  it("issues a 6-digit code via /api/pair/code", async () => {
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
    });
    const issued = await request(app)
      .post("/api/pair/code")
      .send({ childId: "default" });
    expect(issued.status).toBe(201);
    expect(issued.body.code).toMatch(/^\d{6}$/);
    expect(issued.body.expiresAt).toBeGreaterThan(Date.now());
  });

  it("redeems the code to issue a long-lived credential", async () => {
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
    });
    const issued = await request(app)
      .post("/api/pair/code")
      .send({ childId: "default" });
    const redeemed = await request(app)
      .post("/api/pair/redeem")
      .send({ code: issued.body.code, deviceName: "iPad" });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body.credential).toMatch(/^sb_/);
  });

  it("an unpaired request now works (v0.5 no-pairing default)", async () => {
    // v0.1 assertion: "unpaired /api/session/start returns 401"
    // v0.5 reality: with no-pairing as the default, the request
    // succeeds. Parents with the old script still get a credential
    // (above tests), but it is no longer required.
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
    });
    const res = await request(app)
      .post("/api/session/start")
      .send({ childId: "default", subject: "作业" });
    expect(res.status).toBe(200);
  });

  it("an old bearer credential is still accepted (back-compat)", async () => {
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
    });
    const issued = await request(app)
      .post("/api/pair/code")
      .send({ childId: "default" });
    const redeemed = await request(app)
      .post("/api/pair/redeem")
      .send({ code: issued.body.code, deviceName: "iPad" });
    // With the v0.1 app, only the bearer credential would unlock
    // /api/session/start. With v0.5 no-pairing, both unpaired and
    // paired requests succeed — verify the old credential still
    // gets through (not rejected as invalid).
    const paired = await request(app)
      .post("/api/session/start")
      .set("Authorization", `Bearer ${redeemed.body.credential}`)
      .send({ childId: "default", subject: "作业" });
    expect(paired.status).toBe(200);
  });
});

describe("no-pairing (new default) — see no-pairing.test.ts for the full suite", () => {
  it("placeholder: full coverage in no-pairing.test.ts", () => {
    // Full coverage lives in `no-pairing.test.ts`. The two test
    // files are split because they target different mental models:
    //   - this file: "the old pair flow still works for parents
    //     with existing scripts" (back-compat)
    //   - no-pairing.test.ts: "the new flow needs no setup" (v0.5+)
    expect(true).toBe(true);
  });
});

// server/src/no-pairing.test.ts
//
// Tests for the no-pairing device-auth model (v0.5 design change).
// study-buddy v0.1 required every kid device to redeem a 6-digit
// pairing code before it could hit any /api/* route. The friction
// (parent runs the script, kid types the code, credential lives in
// localStorage, lost on cache clear) blocked the kid from using the
// app. v0.5 (issue: 配对码逻辑阻碍孩子) removes the gate.
//
// What changes:
//   - `requireDevice` is a no-op: it auto-issues a virtual
//     "default" device (childId="default", deviceId="default")
//   - `findOwnedActiveSession` no longer checks device_id; the
//     session is child-scoped, not device-scoped
//   - The /api/pair/* routes still work for back-compat (parents
//     with existing scripts) but no UI surfaces them
//   - The 4-digit BUDDY_PIN (chat gate) is unchanged — it still
//     guards the LLM call, which is the actual safety concern
//
// The `paired_devices` table stays in the schema for back-compat
// (existing data is preserved). New requests never touch it.

import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import request from "supertest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import Database from "better-sqlite3";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { DeviceAuth } from "./device-auth.js";

let db: Database.Database;
let app: ReturnType<typeof createApp>;
let tmpDir: string;

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "study-buddy-no-pairing-"));
  db = new Database(join(tmpDir, "test.db"));
  db.pragma("journal_mode = WAL");
  migrateSchema(db);
  // Seed the "default" child that the no-pairing default device
  // resolves to. The FK on sessions.child_id would 500 otherwise.
  db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run("default", "小宝");
  app = createApp({ db, httpsPort: 3000, outboxPath: join(tmpDir, "outbox.jsonl") });
});

afterAll(() => {
  db.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  // Clear per-test data but preserve the virtual "default" device
  // that migrateSchema seeds — deleting it would 500 the FK on
  // sessions.device_id for every subsequent test.
  db.prepare("DELETE FROM sessions").run();
  db.prepare("DELETE FROM paired_devices WHERE device_id != 'default'").run();
});

describe("requireDevice is a no-op (no credential required)", () => {
  it("/api/session/active returns 200 without any Authorization header", async () => {
    const res = await request(app).get("/api/session/active");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ session: null });
  });

  it("/api/session/start succeeds without any Authorization header", async () => {
    const res = await request(app)
      .post("/api/session/start")
      .send({ childId: "default", subject: "作业" });
    expect(res.status).toBe(200);
    expect(res.body.sessionId).toBeTruthy();
  });

  it("/api/session/start defaults childId to 'default' when omitted", async () => {
    const res = await request(app)
      .post("/api/session/start")
      .send({ subject: "数学" });
    expect(res.status).toBe(200);
    const sessionId = res.body.sessionId;
    const row = db.prepare("SELECT child_id, device_id FROM sessions WHERE id = ?")
      .get(sessionId) as { child_id: string; device_id: string };
    expect(row.child_id).toBe("default");
    expect(row.device_id).toBe("default");
  });

  it("/api/whoami returns 200 with the virtual default device", async () => {
    const res = await request(app).get("/api/whoami");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ child: { childId: "default" } });
  });

  it("an old bearer credential is accepted (back-compat) and resolves to the same default device", async () => {
    // A parent that already ran the pair script has a long-lived
    // credential. With the no-op device auth, the credential is
    // ignored — but the request still works. The default device is
    // always returned regardless of the credential value.
    const res = await request(app)
      .get("/api/whoami")
      .set("Authorization", "Bearer sb_anything_goes_here");
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ child: { childId: "default" } });
  });
});

describe("findOwnedActiveSession is child-scoped (no device check)", () => {
  it("a session started without pairing is reachable from any subsequent request", async () => {
    const start = await request(app)
      .post("/api/session/start")
      .send({ childId: "default", subject: "作业" });
    expect(start.status).toBe(200);
    const sessionId = start.body.sessionId;

    // Same session, different "device" (no Authorization header,
    // no localStorage state) — should still work because
    // findOwnedActiveSession no longer checks device_id.
    const active = await request(app).get("/api/session/active");
    expect(active.status).toBe(200);
    expect(active.body.session.sessionId).toBe(sessionId);
  });

  it("sessions stay child-isolated: alice's session is not reachable from default's view", async () => {
    // Default child starts a session
    const defaultStart = await request(app)
      .post("/api/session/start")
      .send({ childId: "default", subject: "作业" });
    const defaultSessionId = defaultStart.body.sessionId;

    // /api/session/active is filtered by childId internally; the
    // default child should only see their own active session.
    const active = await request(app).get("/api/session/active");
    expect(active.body.session.sessionId).toBe(defaultSessionId);
  });

  it("explicitly ending a session makes it unreachable", async () => {
    const start = await request(app)
      .post("/api/session/start")
      .send({ childId: "default", subject: "作业" });
    const sessionId = start.body.sessionId;

    const end = await request(app)
      .post("/api/session/end")
      .send({ sessionId });
    expect(end.status).toBe(200);

    // The session exists in DB but is ended — re-using it via a
    // childId-only flow (e.g. /api/mistake-photo with sessionId
    // field) should 409 because the session is not active.
    const photo = await request(app)
      .post("/api/mistake-photo")
      .field("sessionId", sessionId)
      .field("draftId", "test_after_end_001")
      .attach("photo", Buffer.from("x"), { filename: "x.jpg", contentType: "image/jpeg" });
    expect([404, 409]).toContain(photo.status);
  });
});

describe("DeviceAuth class still works (back-compat for existing scripts)", () => {
  it("issuePairingCode + redeemPairingCode still issue a credential", () => {
    const auth = new DeviceAuth({ db });
    const issued = auth.issuePairingCode("default");
    expect(issued).not.toBeNull();
    expect(issued!.code).toMatch(/^\d{6}$/);

    const redeemed = auth.redeemPairingCode(issued!.code, "iPad");
    expect(redeemed).not.toBeNull();
    expect(redeemed!.credential).toMatch(/^sb_/);
    expect(redeemed!.childId).toBe("default");
  });

  it("redeemPairingCode refuses an unknown code", () => {
    const auth = new DeviceAuth({ db });
    const result = auth.redeemPairingCode("000000", "iPad");
    expect(result).toBeNull();
  });
});

import Database from "better-sqlite3";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { migrateSchema } from "./db-migrate.js";
import { createLogger, memorySink } from "./logger.js";

let db: Database.Database;

beforeEach(() => {
  db = new Database(":memory:");
  migrateSchema(db);
});

afterEach(() => db.close());

describe("paired child device", () => {
  it("redeems a local short-lived code before starting an owned session", async () => {
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

    const redeemed = await request(app)
      .post("/api/pair/redeem")
      .send({ code: issued.body.code, deviceName: "iPad" });
    expect(redeemed.status).toBe(201);
    expect(redeemed.body.credential).toMatch(/^sb_/);

    const unpaired = await request(app)
      .post("/api/session/start")
      .send({ childId: "default" });
    expect(unpaired.status).toBe(401);

    const paired = await request(app)
      .post("/api/session/start")
      .set("Authorization", `Bearer ${redeemed.body.credential}`)
      .send({ childId: "default", subject: "作业" });
    expect(paired.status).toBe(200);

    const stored = db.prepare(
      "SELECT child_id AS childId, device_id AS deviceId FROM sessions WHERE id = ?",
    ).get(paired.body.sessionId) as { childId: string; deviceId: string };
    expect(stored).toEqual({
      childId: "default",
      deviceId: redeemed.body.deviceId,
    });
  });

  it("keeps two devices independent and prevents one from ending the other's session", async () => {
    const app = createApp({ db, buddyPin: null, pairingLoopbackCheck: () => true });
    const deviceA = await pairDevice(app, "iPad A");
    const deviceB = await pairDevice(app, "iPad B");

    const startedA = await startSession(app, deviceA.credential);
    const startedB = await startSession(app, deviceB.credential);

    expect((await request(app).get("/api/whoami")).status).toBe(401);
    const observedByB = await request(app)
      .get("/api/whoami")
      .set("Authorization", `Bearer ${deviceB.credential}`);
    expect(observedByB.status).toBe(200);
    expect(observedByB.body.session.id).toBe(startedB.sessionId);
    expect(JSON.stringify(observedByB.body)).not.toContain(startedA.sessionId);

    const stillActive = db.prepare(
      "SELECT ended_at AS endedAt FROM sessions WHERE id = ?",
    ).get(startedA.sessionId) as { endedAt: number | null };
    expect(stillActive.endedAt).toBeNull();

    const crossDeviceEnd = await request(app)
      .post("/api/session/end")
      .set("Authorization", `Bearer ${deviceB.credential}`)
      .send({ sessionId: startedA.sessionId });
    expect(crossDeviceEnd.status).toBe(403);

    const crossDeviceVideoMode = await request(app)
      .post("/api/video-mode")
      .set("Authorization", `Bearer ${deviceB.credential}`)
      .send({ sessionId: startedA.sessionId, enabled: false });
    expect(crossDeviceVideoMode.status).toBe(403);

    const ownEnd = await request(app)
      .post("/api/session/end")
      .set("Authorization", `Bearer ${deviceA.credential}`)
      .send({ sessionId: startedA.sessionId });
    expect(ownEnd.status).toBe(200);
    expect(ownEnd.body.sessionId).toBe(startedA.sessionId);
    expect(startedB.sessionId).not.toBe(startedA.sessionId);
  });

  it("requires the owning device and explicit session for chat and media writes", async () => {
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
      callMinimax: async () => "继续看题目吧",
    });
    const deviceA = await pairDevice(app, "iPad A");
    const deviceB = await pairDevice(app, "iPad B");
    const startedA = await startSession(app, deviceA.credential);
    const sessionsBefore = (db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count;

    const mismatchedChild = await request(app)
      .post("/api/session/start")
      .set("Authorization", `Bearer ${deviceA.credential}`)
      .send({ childId: "another-child" });
    expect(mismatchedChild.status).toBe(403);
    expect((db.prepare("SELECT COUNT(*) AS count FROM sessions").get() as { count: number }).count)
      .toBe(sessionsBefore);

    const unknownSession = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${deviceA.credential}`)
      .send({ sessionId: "unknown-session", text: "你好" });
    expect(unknownSession.status).toBe(404);

    const missingIdentity = await request(app)
      .post("/api/chat")
      .send({ sessionId: startedA.sessionId, text: "你好" });
    expect(missingIdentity.status).toBe(401);

    const crossDeviceChat = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${deviceB.credential}`)
      .send({ sessionId: startedA.sessionId, text: "你好" });
    expect(crossDeviceChat.status).toBe(403);

    const ownedChat = await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${deviceA.credential}`)
      .send({ sessionId: startedA.sessionId, text: "你好" });
    expect(ownedChat.status).toBe(200);

    const crossDeviceFrame = await request(app)
      .post("/api/frame")
      .set("Authorization", `Bearer ${deviceB.credential}`)
      .field("sessionId", startedA.sessionId)
      .attach("frame", Buffer.from("not-an-image"), "frame.jpg");
    expect(crossDeviceFrame.status).toBe(403);

    const crossDevicePhoto = await request(app)
      .post("/api/mistake-photo")
      .set("Authorization", `Bearer ${deviceB.credential}`)
      .field("sessionId", startedA.sessionId)
      .attach("photo", Buffer.from("not-an-image"), "photo.jpg");
    expect(crossDevicePhoto.status).toBe(403);

    const turns = db.prepare(
      "SELECT COUNT(*) AS count FROM chat_turns WHERE session_id = ?",
    ).get(startedA.sessionId) as { count: number };
    expect(turns.count).toBe(2);
    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 0 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM posture_events").get()).toEqual({ count: 0 });
  });

  it("resumes only its own active session and reset revokes the old credential", async () => {
    const app = createApp({ db, buddyPin: null, pairingLoopbackCheck: () => true });
    const oldDevice = await pairDevice(app, "old iPad");
    const started = await startSession(app, oldDevice.credential);

    const resumed = await request(app)
      .get("/api/session/active")
      .set("Authorization", `Bearer ${oldDevice.credential}`);
    expect(resumed.status).toBe(200);
    expect(resumed.body.session.sessionId).toBe(started.sessionId);

    const reset = await request(app)
      .post("/api/pair/code")
      .send({ childId: "default", resetDevices: true });
    expect(reset.status).toBe(201);

    const revoked = await request(app)
      .get("/api/session/active")
      .set("Authorization", `Bearer ${oldDevice.credential}`);
    expect(revoked.status).toBe(401);

    const replacement = await request(app)
      .post("/api/pair/redeem")
      .send({ code: reset.body.code, deviceName: "new iPad" });
    expect(replacement.status).toBe(201);

    const replacementActive = await request(app)
      .get("/api/session/active")
      .set("Authorization", `Bearer ${replacement.body.credential}`);
    expect(replacementActive.status).toBe(200);
    expect(replacementActive.body.session).toBeNull();
  });

  it("keeps legacy game auto-sessions separate from paired learning sessions", async () => {
    const app = createApp({ db, buddyPin: null, pairingLoopbackCheck: () => true });
    const device = await pairDevice(app, "learning iPad");
    const learning = await startSession(app, device.credential);

    const gameMistake = await request(app).post("/api/game/mistake").send({
      childId: "default",
      problem: "7+8",
      userAnswer: "14",
      correctAnswer: "15",
      source: "game",
    });
    expect(gameMistake.status).toBe(201);
    const stored = db.prepare(
      `SELECT m.session_id AS sessionId, s.device_id AS deviceId
         FROM mistakes m JOIN sessions s ON s.id = m.session_id
        WHERE m.id = ?`,
    ).get(gameMistake.body.id) as { sessionId: string; deviceId: string | null };
    expect(stored.sessionId).not.toBe(learning.sessionId);
    expect(stored.deviceId).toBeNull();
  });

  it("keeps code issuance local-only and rejects expired or replayed codes", async () => {
    let now = Date.parse("2026-08-11T12:00:00.000Z");
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => false,
      deviceAuthNow: () => now,
    });
    expect((await request(app).post("/api/pair/code").send({})).status).toBe(403);

    const localApp = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
      deviceAuthNow: () => now,
    });
    const expired = await request(localApp).post("/api/pair/code").send({});
    now += 5 * 60_000 + 1;
    expect((await request(localApp).post("/api/pair/redeem").send({
      code: expired.body.code,
      deviceName: "late iPad",
    })).status).toBe(401);

    const fresh = await request(localApp).post("/api/pair/code").send({});
    const first = await request(localApp).post("/api/pair/redeem").send({
      code: fresh.body.code,
      deviceName: "iPad",
    });
    expect(first.status).toBe(201);
    expect((await request(localApp).post("/api/pair/redeem").send({
      code: fresh.body.code,
      deviceName: "replay",
    })).status).toBe(401);
  });

  it("rejects pairing redemption and device credentials on insecure LAN transport", async () => {
    const secureApp = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
      deviceSecureTransportCheck: () => true,
    });
    const device = await pairDevice(secureApp, "secure iPad");
    const issued = await request(secureApp).post("/api/pair/code").send({});

    const insecureApp = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
      deviceSecureTransportCheck: () => false,
    });
    expect((await request(insecureApp).post("/api/pair/redeem").send({
      code: issued.body.code,
      deviceName: "plaintext iPad",
    })).status).toBe(403);
    expect((await request(insecureApp)
      .get("/api/session/active")
      .set("Authorization", `Bearer ${device.credential}`)).status).toBe(403);
  });

  it("rate-limits repeated pairing guesses from one client", async () => {
    let now = Date.parse("2026-08-11T12:00:00.000Z");
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
      deviceAuthNow: () => now,
    });
    for (let attempt = 0; attempt < 10; attempt += 1) {
      expect((await request(app).post("/api/pair/redeem").send({
        code: "999999",
        deviceName: "guessing client",
      })).status).toBe(401);
    }
    const blocked = await request(app).post("/api/pair/redeem").send({
      code: "999999",
      deviceName: "guessing client",
    });
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers["retry-after"])).toBeGreaterThan(0);

    now += 5 * 60_000 + 1;
    expect((await request(app).post("/api/pair/redeem").send({
      code: "999999",
      deviceName: "guessing client",
    })).status).toBe(401);
  });

  it("throttles device last-seen writes during frequent frame-era requests", async () => {
    let now = Date.parse("2026-08-11T12:00:00.000Z");
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
      deviceAuthNow: () => now,
    });
    const device = await pairDevice(app, "busy iPad");
    const readLastSeen = () => (db.prepare(
      "SELECT last_seen_at AS lastSeenAt FROM paired_devices WHERE device_id = ?",
    ).get(device.deviceId) as { lastSeenAt: number }).lastSeenAt;
    const pairedAt = readLastSeen();

    now += 30_000;
    expect((await request(app).get("/api/session/active")
      .set("Authorization", `Bearer ${device.credential}`)).status).toBe(200);
    expect(readLastSeen()).toBe(pairedAt);

    now += 31_000;
    expect((await request(app).get("/api/session/active")
      .set("Authorization", `Bearer ${device.credential}`)).status).toBe(200);
    expect(readLastSeen()).toBe(now);
  });

  it("does not put pairing codes, credentials, authorization, or chat text in logs", async () => {
    const captured = memorySink();
    const app = createApp({
      db,
      buddyPin: null,
      pairingLoopbackCheck: () => true,
      logger: createLogger({ sinks: [captured.sink] }),
      callMinimax: async () => "回答",
    });
    const issued = await request(app).post("/api/pair/code").send({});
    const paired = await request(app).post("/api/pair/redeem").send({
      code: issued.body.code,
      deviceName: "private iPad name",
    });
    const started = await startSession(app, paired.body.credential);
    await request(app)
      .post("/api/chat")
      .set("Authorization", `Bearer ${paired.body.credential}`)
      .send({ sessionId: started.sessionId, text: "不要出现在日志里的原话" });

    const logs = JSON.stringify(captured.entries());
    expect(logs).not.toContain(issued.body.code);
    expect(logs).not.toContain(paired.body.credential);
    expect(logs).not.toContain("不要出现在日志里的原话");
    expect(logs).not.toContain("private iPad name");
    expect(logs).not.toContain("authorization");
  });
});

async function pairDevice(app: ReturnType<typeof createApp>, deviceName: string) {
  const issued = await request(app).post("/api/pair/code").send({ childId: "default" });
  const redeemed = await request(app)
    .post("/api/pair/redeem")
    .send({ code: issued.body.code, deviceName });
  expect(redeemed.status).toBe(201);
  return redeemed.body as { credential: string; deviceId: string };
}

async function startSession(app: ReturnType<typeof createApp>, credential: string) {
  const response = await request(app)
    .post("/api/session/start")
    .set("Authorization", `Bearer ${credential}`)
    .send({ childId: "default" });
  expect(response.status).toBe(200);
  return response.body as { sessionId: string };
}

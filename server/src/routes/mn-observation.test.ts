// server/src/routes/mn-observation.test.ts
// =====================================================================
// #13 (MemoryNexus incoming return path) — HTTP route tests.
//
// Two endpoints under test, both registered via
// registerMnObservationRoutes(app, deps):
//
//   POST /api/mn-observation/materialize
//     Auth:  Bearer integration token + loopback
//     Body:  { bindingId, mnSubject, childId, observations: [...] }
//     200:   { bindingId, bindingCreated, upserted, skipped }
//     400:   { error: string }   on shape violations
//     401:   when token is missing or wrong
//
//   POST /api/mn-observation/observation
//     Auth:  childId in body (matches the kid-app convention used by
//            the /api/game/* family — no separate auth in v0.1; the
//            server only returns the binding tied to that childId)
//     Body:  { childId, limit? }
//     200:   { bindingId, observations: [...] }
//     200:   { bindingId: null, observations: [] }   if no binding
//     400:   when childId is missing
//
// POST vs GET naming: the kid-app client uses POST for reads because
// the request carries a childId in the body (matches the game-api
// pattern). The materialize endpoint is the MN-side write.
// =====================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import request from "supertest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createApp, type AppOptions } from "../app.js";
import { migrateSchema } from "../db-migrate.js";
import { createLogger } from "../logger.js";

const INTEGRATION_TOKEN = "test-integration-token-with-enough-entropy";
const NOW = 1_700_000_000_000;
const BINDING = "binding-7day-1";
const MN_SUBJECT = "mn-subject-1";
const CHILD = "default";

function buildApp(
  loopback = true,
  overrides: Partial<AppOptions> = {},
): ReturnType<typeof createApp> {
  return createApp({
    httpsPort: 3000,
    integrationToken: INTEGRATION_TOKEN,
    integrationLoopbackCheck: () => loopback,
    logger: createLogger({ level: "error", sinks: [] }),
    ...overrides,
  });
}

function bearer(token: string): string {
  return `Bearer ${token}`;
}

describe("POST /api/mn-observation/materialize", () => {
  let db: Database.Database;
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mn-route-mat-"));
    db = new Database(join(tmpDir, "study.db"));
    migrateSchema(db);
    app = buildApp(true, { db });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("401s when the integration token is missing", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [],
      });
    expect(response.status).toBe(401);
  });

  it("401s when the integration token is wrong", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer("not-the-real-token"))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [],
      });
    expect(response.status).toBe(401);
  });

  it("403s when the request is not from loopback (even with the right token)", async () => {
    const nonLoopbackApp = buildApp(false, { db });
    const response = await request(nonLoopbackApp)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [],
      });
    expect(response.status).toBe(403);
  });

  it("creates the binding and materializes observations on first call", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [
          { observationId: "obs-1", generatedAt: NOW, payload: { hint: "borrow" } },
          { observationId: "obs-2", generatedAt: NOW + 100, payload: { hint: "carry" } },
        ],
      });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      bindingId: BINDING,
      bindingCreated: true,
      upserted: 2,
      skipped: 0,
    });

    const projections = db
      .prepare("SELECT observation_id FROM mn_observation_projections ORDER BY observation_id")
      .all() as Array<{ observation_id: string }>;
    expect(projections.map((p) => p.observation_id)).toEqual(["obs-1", "obs-2"]);
  });

  it("does not re-create the binding on subsequent calls", async () => {
    const first = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [],
      });
    expect(first.body.bindingCreated).toBe(true);

    const second = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [
          { observationId: "obs-1", generatedAt: NOW, payload: { hint: "borrow" } },
        ],
      });
    expect(second.status).toBe(200);
    expect(second.body.bindingCreated).toBe(false);
    expect(second.body.upserted).toBe(1);
  });

  it("is idempotent: re-posting the same observations does not duplicate", async () => {
    const body = {
      bindingId: BINDING,
      mnSubject: MN_SUBJECT,
      childId: CHILD,
      observations: [
        { observationId: "obs-1", generatedAt: NOW, payload: { hint: "borrow" } },
      ],
    };

    const first = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send(body);
    const second = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send(body);

    expect(first.body.upserted).toBe(1);
    expect(second.body.upserted).toBe(0);
    expect(second.body.skipped).toBe(1);
  });

  it("400s when bindingId is missing", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({ mnSubject: MN_SUBJECT, childId: CHILD, observations: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/bindingId/);
  });

  it("400s when mnSubject is missing", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({ bindingId: BINDING, childId: CHILD, observations: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/mnSubject/);
  });

  it("400s when childId is missing", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({ bindingId: BINDING, mnSubject: MN_SUBJECT, observations: [] });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/childId/);
  });

  it("400s when observations is not an array", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: "nope",
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/observations/);
  });

  it("400s when an observation is missing observationId", async () => {
    const response = await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [{ generatedAt: NOW, payload: { ok: true } }],
      });
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/observationId/);
  });
});

describe("POST /api/mn-observation/observation (kid-app read)", () => {
  let db: Database.Database;
  let tmpDir: string;
  let app: ReturnType<typeof createApp>;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "mn-route-read-"));
    db = new Database(join(tmpDir, "study.db"));
    migrateSchema(db);
    app = buildApp(true, { db });
  });

  afterEach(() => {
    db.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("returns an empty envelope when the child has no active binding", async () => {
    const response = await request(app)
      .post("/api/mn-observation/observation")
      .send({ childId: CHILD });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({ bindingId: null, observations: [] });
  });

  it("returns the materialized observations for the child's binding", async () => {
    // Seed: a binding + 2 observations materialized via the push endpoint.
    await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [
          { observationId: "obs-1", generatedAt: NOW, payload: { hint: "borrow" } },
          { observationId: "obs-2", generatedAt: NOW + 100, payload: { hint: "carry" } },
        ],
      });

    const response = await request(app)
      .post("/api/mn-observation/observation")
      .send({ childId: CHILD });
    expect(response.status).toBe(200);
    expect(response.body.bindingId).toBe(BINDING);
    expect(response.body.observations).toHaveLength(2);
    const obsById = Object.fromEntries(
      response.body.observations.map((o: { observationId: string; payload: unknown }) => [
        o.observationId,
        o,
      ]),
    );
    expect(obsById["obs-1"]?.payload).toEqual({ hint: "borrow" });
    expect(obsById["obs-2"]?.payload).toEqual({ hint: "carry" });
  });

  it("returns empty observations when binding exists but nothing materialized", async () => {
    await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: BINDING,
        mnSubject: MN_SUBJECT,
        childId: CHILD,
        observations: [],
      });

    const response = await request(app)
      .post("/api/mn-observation/observation")
      .send({ childId: CHILD });
    expect(response.status).toBe(200);
    expect(response.body.bindingId).toBe(BINDING);
    expect(response.body.observations).toEqual([]);
  });

  it("400s when childId is missing", async () => {
    const response = await request(app)
      .post("/api/mn-observation/observation")
      .send({});
    expect(response.status).toBe(400);
    expect(response.body.error).toMatch(/childId/);
  });

  it("does not leak observations from another child's binding", async () => {
    // Pre-create the children — mn_bindings.child_id has a FK to children(id).
    db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run("child-1", "child 1");
    db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run("child-2", "child 2");
    // Materialize observations for two distinct children.
    await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: "b-1",
        mnSubject: "subj-1",
        childId: "child-1",
        observations: [
          { observationId: "obs-1", generatedAt: NOW, payload: { who: "child-1" } },
        ],
      });
    await request(app)
      .post("/api/mn-observation/materialize")
      .set("Authorization", bearer(INTEGRATION_TOKEN))
      .send({
        bindingId: "b-2",
        mnSubject: "subj-2",
        childId: "child-2",
        observations: [
          { observationId: "obs-1", generatedAt: NOW, payload: { who: "child-2" } },
        ],
      });

    const r1 = await request(app)
      .post("/api/mn-observation/observation")
      .send({ childId: "child-1" });
    expect(r1.body.bindingId).toBe("b-1");
    expect(r1.body.observations[0].payload).toEqual({ who: "child-1" });

    const r2 = await request(app)
      .post("/api/mn-observation/observation")
      .send({ childId: "child-2" });
    expect(r2.body.bindingId).toBe("b-2");
    expect(r2.body.observations[0].payload).toEqual({ who: "child-2" });
  });
});

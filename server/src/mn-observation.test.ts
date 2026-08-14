// server/src/mn-observation.test.ts
// =====================================================================
// #13 (MemoryNexus incoming return path) — pure unit tests for
// MnObservationAdapter and materializeObservations.
// =====================================================================
//
// Two layers under test:
//   1. InMemoryMnObservationAdapter — fakes the MN SDK so we can drive
//      the worker in tests without an HTTP round-trip. The real MN SDK
//      will land behind the same MnObservationAdapter interface when
//      MN #229 ships; this in-memory implementation is also the v0.1
//      runtime default (always returns empty).
//
//   2. materializeObservations(db, input) — pure upsert function. The
//      worker (cron pull) and the HTTP push route both call this. All
//      idempotency invariants live here: re-running with the same
//      observationId is a no-op; a newer generatedAt overwrites an
//      older payload; an older generatedAt is skipped (not clobbered).
// =====================================================================

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateSchema } from "./db-migrate.js";
import {
  InMemoryMnObservationAdapter,
  materializeObservations,
  type MnObservation,
} from "./mn-observation.js";

const BINDING = "binding-7-day-learning";
const MN_SUBJECT = "subject-abc";
const CHILD = "default";
const NOW = 1_700_000_000_000; // 2023-11-14T22:13:20Z, deterministic

function freshDb(): Database.Database {
  const dir = mkdtempSync(join(tmpdir(), "mn-observation-test-"));
  const db = new Database(join(dir, "study.db"));
  migrateSchema(db);
  return db;
}

describe("InMemoryMnObservationAdapter", () => {
  it("returns empty array for an unknown binding", async () => {
    const adapter = new InMemoryMnObservationAdapter();
    const result = await adapter.fetchObservations({ bindingId: "missing" });
    expect(result).toEqual([]);
  });

  it("returns the observations set via setObservations", async () => {
    const adapter = new InMemoryMnObservationAdapter();
    const obs: MnObservation[] = [
      { observationId: "obs-1", generatedAt: NOW, payload: { kind: "summary" } },
    ];
    adapter.setObservations(BINDING, obs);
    const result = await adapter.fetchObservations({ bindingId: BINDING });
    expect(result).toEqual(obs);
  });

  it("isolates state between bindings", async () => {
    const adapter = new InMemoryMnObservationAdapter();
    adapter.setObservations("b-1", [
      { observationId: "x", generatedAt: NOW, payload: { tag: "b-1" } },
    ]);
    const a = await adapter.fetchObservations({ bindingId: "b-1" });
    const b = await adapter.fetchObservations({ bindingId: "b-2" });
    expect(a[0]?.payload).toEqual({ tag: "b-1" });
    expect(b).toEqual([]);
  });
});

describe("materializeObservations", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = freshDb();
  });

  afterEach(() => {
    db.close();
  });

  it("creates a binding row when binding does not exist", () => {
    const result = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: [],
      now: NOW,
    });

    expect(result.bindingCreated).toBe(true);
    const binding = db
      .prepare("SELECT * FROM mn_bindings WHERE binding_id = ?")
      .get(BINDING) as
      | { binding_id: string; child_id: string; mn_subject: string; status: string }
      | undefined;
    expect(binding).toBeDefined();
    expect(binding?.child_id).toBe(CHILD);
    expect(binding?.mn_subject).toBe(MN_SUBJECT);
    expect(binding?.status).toBe("active");
  });

  it("does not re-create an existing binding", () => {
    // First call creates.
    materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: [],
      now: NOW,
    });
    // Second call sees the same binding.
    const result = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: [],
      now: NOW + 1_000,
    });
    expect(result.bindingCreated).toBe(false);
  });

  it("inserts new observations as projections", () => {
    const observations: MnObservation[] = [
      { observationId: "obs-1", generatedAt: NOW, payload: { hint: "borrow" } },
      { observationId: "obs-2", generatedAt: NOW + 100, payload: { hint: "carry" } },
    ];

    const result = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations,
      now: NOW,
    });

    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(0);

    const rows = db
      .prepare(
        "SELECT observation_id, generated_at, payload_json FROM mn_observation_projections WHERE binding_id = ? ORDER BY generated_at",
      )
      .all(BINDING) as Array<{ observation_id: string; generated_at: number; payload_json: string }>;
    expect(rows.map((r) => r.observation_id)).toEqual(["obs-1", "obs-2"]);
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({ hint: "borrow" });
  });

  it("is idempotent: re-running with the same observations does not duplicate", () => {
    const observations: MnObservation[] = [
      { observationId: "obs-1", generatedAt: NOW, payload: { kind: "summary" } },
    ];

    const first = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations,
      now: NOW,
    });
    const second = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations,
      now: NOW + 500,
    });

    expect(first.upserted).toBe(1);
    expect(second.upserted).toBe(0);
    expect(second.skipped).toBe(1);

    const count = db
      .prepare("SELECT COUNT(*) as n FROM mn_observation_projections WHERE binding_id = ?")
      .get(BINDING) as { n: number };
    expect(count.n).toBe(1);
  });

  it("updates payload when same observationId has a newer generatedAt", () => {
    const observations_v1: MnObservation[] = [
      { observationId: "obs-1", generatedAt: NOW, payload: { hint: "borrow" } },
    ];
    const observations_v2: MnObservation[] = [
      { observationId: "obs-1", generatedAt: NOW + 1000, payload: { hint: "carry" } },
    ];

    materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: observations_v1,
      now: NOW,
    });

    const result = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: observations_v2,
      now: NOW + 2_000,
    });

    expect(result.upserted).toBe(1);
    expect(result.skipped).toBe(0);

    const row = db
      .prepare(
        "SELECT generated_at, payload_json, materialized_at FROM mn_observation_projections WHERE observation_id = ?",
      )
      .get("obs-1") as { generated_at: number; payload_json: string; materialized_at: number };
    expect(row.generated_at).toBe(NOW + 1000);
    expect(JSON.parse(row.payload_json)).toEqual({ hint: "carry" });
    // materialized_at reflects the most recent write, not the original.
    expect(row.materialized_at).toBe(NOW + 2_000);
  });

  it("skips when same observationId arrives with an older generatedAt", () => {
    const newer: MnObservation[] = [
      { observationId: "obs-1", generatedAt: NOW + 1000, payload: { v: 2 } },
    ];
    const older: MnObservation[] = [
      { observationId: "obs-1", generatedAt: NOW, payload: { v: 1 } },
    ];

    materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: newer,
      now: NOW + 2_000,
    });

    const result = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: older,
      now: NOW + 3_000,
    });

    expect(result.upserted).toBe(0);
    expect(result.skipped).toBe(1);

    const row = db
      .prepare("SELECT payload_json FROM mn_observation_projections WHERE observation_id = ?")
      .get("obs-1") as { payload_json: string };
    expect(JSON.parse(row.payload_json)).toEqual({ v: 2 });
  });

  it("handles a mixed batch: new + idempotent + outdated", () => {
    // Seed: obs-A already materialized with a newer generatedAt.
    materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: [
        { observationId: "obs-A", generatedAt: NOW + 500, payload: { v: 2 } },
      ],
      now: NOW + 600,
    });

    // New batch: obs-A (older, skip), obs-B (new, insert), obs-C (newer-version, update).
    const result = materializeObservations(db, {
      bindingId: BINDING,
      childId: CHILD,
      mnSubject: MN_SUBJECT,
      observations: [
        { observationId: "obs-A", generatedAt: NOW, payload: { v: 1 } },
        { observationId: "obs-B", generatedAt: NOW + 700, payload: { v: 1 } },
        { observationId: "obs-C", generatedAt: NOW + 800, payload: { v: 1 } },
      ],
      now: NOW + 900,
    });

    expect(result.upserted).toBe(2);
    expect(result.skipped).toBe(1);

    const rows = db
      .prepare("SELECT observation_id, payload_json FROM mn_observation_projections ORDER BY observation_id")
      .all() as Array<{ observation_id: string; payload_json: string }>;
    expect(rows.map((r) => r.observation_id)).toEqual(["obs-A", "obs-B", "obs-C"]);
    expect(JSON.parse(rows[0]!.payload_json)).toEqual({ v: 2 }); // obs-A unchanged
  });

  it("isolates projections between bindings", () => {
    // Use two distinct children because the schema enforces
    // "one active binding per child" (idx_mn_bindings_child_active).
    db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run("child-1", "child 1");
    db.prepare("INSERT OR IGNORE INTO children (id, name) VALUES (?, ?)").run("child-2", "child 2");
    materializeObservations(db, {
      bindingId: "b-1",
      childId: "child-1",
      mnSubject: "subj-1",
      observations: [{ observationId: "x", generatedAt: NOW, payload: { tag: "b-1" } }],
      now: NOW,
    });
    materializeObservations(db, {
      bindingId: "b-2",
      childId: "child-2",
      mnSubject: "subj-2",
      observations: [{ observationId: "x", generatedAt: NOW, payload: { tag: "b-2" } }],
      now: NOW,
    });

    const b1 = db
      .prepare("SELECT payload_json FROM mn_observation_projections WHERE binding_id = ?")
      .get("b-1") as { payload_json: string };
    const b2 = db
      .prepare("SELECT payload_json FROM mn_observation_projections WHERE binding_id = ?")
      .get("b-2") as { payload_json: string };
    expect(JSON.parse(b1.payload_json)).toEqual({ tag: "b-1" });
    expect(JSON.parse(b2.payload_json)).toEqual({ tag: "b-2" });
  });

  it("rejects empty observationId", () => {
    expect(() =>
      materializeObservations(db, {
        bindingId: BINDING,
        childId: CHILD,
        mnSubject: MN_SUBJECT,
        observations: [
          { observationId: "", generatedAt: NOW, payload: { ok: false } },
        ],
        now: NOW,
      }),
    ).toThrow(/observationId/);
  });

  it("rejects non-positive generatedAt", () => {
    expect(() =>
      materializeObservations(db, {
        bindingId: BINDING,
        childId: CHILD,
        mnSubject: MN_SUBJECT,
        observations: [
          { observationId: "obs-1", generatedAt: 0, payload: {} },
        ],
        now: NOW,
      }),
    ).toThrow(/generatedAt/);
  });

  it("rejects an observation whose serialized payload exceeds 4096 chars", () => {
    const huge = "x".repeat(4_097);
    expect(() =>
      materializeObservations(db, {
        bindingId: BINDING,
        childId: CHILD,
        mnSubject: MN_SUBJECT,
        observations: [
          { observationId: "obs-1", generatedAt: NOW, payload: { blob: huge } },
        ],
        now: NOW,
      }),
    ).toThrow(/payload/);
  });
});

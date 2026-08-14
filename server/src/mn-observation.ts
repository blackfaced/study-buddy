// server/src/mn-observation.ts
// =====================================================================
// #13 (MemoryNexus incoming return path) — pure module.
//
// Three building blocks:
//   1. MnObservationAdapter — the boundary the future MN SDK will
//      implement. v0.1 ships an in-memory fake so the worker has
//      something to call and tests can drive it deterministically.
//
//   2. materializeObservations(db, input) — the idempotent upsert.
//      Both the cron pull-worker (adapter-driven) and the HTTP push
//      route (MN-driven) call this. Idempotency is enforced by the
//      UNIQUE(binding_id, observation_id) index plus a generatedAt
//      monotonicity check: a row with an older generatedAt is skipped,
//      not clobbered, so out-of-order re-deliveries from MN are safe.
//
//   3. readLatestObservations(db, childId) — the read path the kid
//      app's GET endpoint uses. Returns the latest projection per
//      observationId for the child's currently-active binding, ordered
//      newest-first by materialized_at.
// =====================================================================

import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export interface MnObservation {
  observationId: string;
  generatedAt: number;
  payload: unknown;
}

export interface FetchObservationsInput {
  bindingId: string;
  sinceObservationId?: string;
}

export interface MnObservationAdapter {
  fetchObservations(input: FetchObservationsInput): Promise<MnObservation[]>;
}

export class InMemoryMnObservationAdapter implements MnObservationAdapter {
  private readonly store = new Map<string, MnObservation[]>();

  async fetchObservations(
    input: FetchObservationsInput,
  ): Promise<MnObservation[]> {
    return this.store.get(input.bindingId) ?? [];
  }

  setObservations(bindingId: string, observations: MnObservation[]): void {
    this.store.set(bindingId, observations);
  }

  clear(): void {
    this.store.clear();
  }
}

const MAX_OBSERVATION_PAYLOAD_CHARS = 4_096;

export interface MaterializeInput {
  bindingId: string;
  childId: string;
  mnSubject: string;
  observations: MnObservation[];
  now: number;
}

export interface MaterializeResult {
  bindingId: string;
  bindingCreated: boolean;
  upserted: number;
  skipped: number;
}

export class MaterializationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaterializationError";
  }
}

/**
 * Idempotent upsert of MN observations into the projection cache.
 *
 * - Creates the binding row on first use (or reuses an existing one).
 * - Inserts each observation as a projection. A re-delivery of the same
 *   (binding_id, observation_id) with a newer generatedAt updates the
 *   payload + materialized_at; an older generatedAt is skipped so
 *   out-of-order delivery is safe.
 *
 * Throws MaterializationError on shape violations (empty observationId,
 * non-positive generatedAt, oversized payload).
 */
export function materializeObservations(
  db: Database.Database,
  input: MaterializeInput,
): MaterializeResult {
  validateShape(input.observations);

  const bindingCreated = upsertBinding(
    db,
    input.bindingId,
    input.childId,
    input.mnSubject,
    input.now,
  );

  const upsertStmt = db.prepare(`
    INSERT INTO mn_observation_projections (
      projection_id, binding_id, observation_id, generated_at,
      payload_json, materialized_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (binding_id, observation_id) DO UPDATE SET
      generated_at = excluded.generated_at,
      payload_json = excluded.payload_json,
      materialized_at = excluded.materialized_at
    WHERE excluded.generated_at > mn_observation_projections.generated_at
  `);

  const lookupStmt = db.prepare(`
    SELECT generated_at FROM mn_observation_projections
    WHERE binding_id = ? AND observation_id = ?
  `);

  let upserted = 0;
  let skipped = 0;

  const tx = db.transaction(() => {
    for (const obs of input.observations) {
      const payloadJson = JSON.stringify(obs.payload ?? null);
      if (payloadJson.length > MAX_OBSERVATION_PAYLOAD_CHARS) {
        throw new MaterializationError(
          `observation ${obs.observationId} payload exceeds ${MAX_OBSERVATION_PAYLOAD_CHARS} chars`,
        );
      }
      const existing = lookupStmt.get(input.bindingId, obs.observationId) as
        | { generated_at: number }
        | undefined;
      if (existing && existing.generated_at >= obs.generatedAt) {
        skipped += 1;
        continue;
      }
      const result = upsertStmt.run(
        randomUUID(),
        input.bindingId,
        obs.observationId,
        obs.generatedAt,
        payloadJson,
        input.now,
      );
      // The ON CONFLICT...DO UPDATE WHERE clause may match zero rows when
      // the existing row's generated_at is >= the new one. We pre-checked
      // above so this branch should always be a real change, but be safe.
      if (result.changes > 0) {
        upserted += 1;
      } else {
        skipped += 1;
      }
    }
  });
  tx();

  return { bindingId: input.bindingId, bindingCreated, upserted, skipped };
}

function upsertBinding(
  db: Database.Database,
  bindingId: string,
  childId: string,
  mnSubject: string,
  now: number,
): boolean {
  const existing = db
    .prepare("SELECT binding_id FROM mn_bindings WHERE binding_id = ?")
    .get(bindingId);
  if (existing) {
    db.prepare(
      "UPDATE mn_bindings SET updated_at = ? WHERE binding_id = ?",
    ).run(now, bindingId);
    return false;
  }
  db.prepare(`
    INSERT INTO mn_bindings (binding_id, child_id, mn_subject, status, created_at, updated_at)
    VALUES (?, ?, ?, 'active', ?, ?)
  `).run(bindingId, childId, mnSubject, now, now);
  return true;
}

function validateShape(observations: MnObservation[]): void {
  for (const obs of observations) {
    if (typeof obs.observationId !== "string" || obs.observationId.length === 0) {
      throw new MaterializationError("observationId is required and must be non-empty");
    }
    if (typeof obs.generatedAt !== "number" || !Number.isFinite(obs.generatedAt) || obs.generatedAt <= 0) {
      throw new MaterializationError(
        `observation ${obs.observationId} generatedAt must be a positive integer`,
      );
    }
  }
}

export interface LatestObservationsResult {
  bindingId: string | null;
  observations: Array<{
    observationId: string;
    generatedAt: number;
    materializedAt: number;
    payload: unknown;
  }>;
}

/**
 * Read the latest projections for the child's currently-active binding.
 * Returns bindingId=null and observations=[] if the child has no active
 * binding yet — the kid app treats that as "no MN observations available"
 * and proceeds without surfacing any.
 */
export function readLatestObservations(
  db: Database.Database,
  childId: string,
  limit = 50,
): LatestObservationsResult {
  const binding = db
    .prepare(
      "SELECT binding_id FROM mn_bindings WHERE child_id = ? AND status = 'active' LIMIT 1",
    )
    .get(childId) as { binding_id: string } | undefined;
  if (!binding) {
    return { bindingId: null, observations: [] };
  }

  const rows = db
    .prepare(
      `SELECT observation_id, generated_at, materialized_at, payload_json
       FROM mn_observation_projections
       WHERE binding_id = ?
       ORDER BY materialized_at DESC
       LIMIT ?`,
    )
    .all(binding.binding_id, limit) as Array<{
    observation_id: string;
    generated_at: number;
    materialized_at: number;
    payload_json: string;
  }>;

  return {
    bindingId: binding.binding_id,
    observations: rows.map((r) => ({
      observationId: r.observation_id,
      generatedAt: r.generated_at,
      materializedAt: r.materialized_at,
      payload: JSON.parse(r.payload_json),
    })),
  };
}

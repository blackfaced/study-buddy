// server/src/routes/mn-observation.ts
// =====================================================================
// #13 (MemoryNexus incoming return path) — HTTP surface.
//
// Two endpoints:
//
//   POST /api/mn-observation/materialize
//     Bearer integration token + loopback. MemoryNexus (or a future
//     MemoryNexusAdapter) calls this to push observation batches into
//     the projection cache. The handler is idempotent: re-posting the
//     same observations is a no-op. The binding is upserted on first
//     use and re-used on subsequent calls.
//
//   POST /api/mn-observation/observation
//     Body carries childId (matches the kid-app convention used by
//     the /api/game/* family — no separate auth in v0.1). The server
//     looks up the active binding for that child and returns its
//     latest projections. When the child has no binding yet the
//     response is `{ bindingId: null, observations: [] }` so the
//     client can treat "no MN data" as a normal, non-error state.
//
// The handler is intentionally read-only with respect to the binding
// itself: childId is used to look up which binding to read, not to
// create a new one. New bindings only land via the materialize
// endpoint, which is the only write surface and is gated by the
// integration token.
// =====================================================================

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import {
  materializeObservations,
  readLatestObservations,
  type MnObservation,
} from "../mn-observation.js";
import {
  authorizeIntegration,
  isLoopbackRequest,
} from "./integration.js";

export interface MnObservationRouteDeps {
  db: Database.Database;
  token: string | null;
  isLoopback?: (req: Request) => boolean;
  /** Test seam: override `now` so generatedAt ordering is deterministic. */
  now?: () => number;
}

const MAX_OBSERVATIONS_PER_BATCH = 200;
const MAX_OBSERVATION_PAYLOAD_CHARS = 4_096;
const DEFAULT_READ_LIMIT = 50;
const MAX_READ_LIMIT = 100;

export function registerMnObservationRoutes(
  app: Express,
  deps: MnObservationRouteDeps,
): void {
  const isLoopback = deps.isLoopback ?? isLoopbackRequest;
  const now = deps.now ?? Date.now;

  app.post(
    "/api/mn-observation/materialize",
    (req: Request, res: Response) => {
      if (!authorizeIntegration(req, res, deps.token, isLoopback)) return;

      const body = (req.body ?? {}) as Record<string, unknown>;
      const bindingId = body.bindingId;
      const mnSubject = body.mnSubject;
      const childId = body.childId;
      const observations = body.observations;

      if (typeof bindingId !== "string" || bindingId.length === 0) {
        res.status(400).json({ error: "bindingId is required" });
        return;
      }
      if (typeof mnSubject !== "string" || mnSubject.length === 0) {
        res.status(400).json({ error: "mnSubject is required" });
        return;
      }
      if (typeof childId !== "string" || childId.length === 0) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      if (!Array.isArray(observations)) {
        res.status(400).json({ error: "observations must be an array" });
        return;
      }
      if (observations.length > MAX_OBSERVATIONS_PER_BATCH) {
        res.status(400).json({
          error: `observations batch must be <= ${MAX_OBSERVATIONS_PER_BATCH} entries`,
        });
        return;
      }

      const parsed: MnObservation[] = [];
      for (const [index, entry] of observations.entries()) {
        if (!entry || typeof entry !== "object") {
          res.status(400).json({
            error: `observations[${index}] must be an object`,
          });
          return;
        }
        const obs = entry as Record<string, unknown>;
        if (typeof obs.observationId !== "string" || obs.observationId.length === 0) {
          res.status(400).json({
            error: `observations[${index}].observationId is required`,
          });
          return;
        }
        if (
          typeof obs.generatedAt !== "number" ||
          !Number.isFinite(obs.generatedAt) ||
          obs.generatedAt <= 0
        ) {
          res.status(400).json({
            error: `observations[${index}].generatedAt must be a positive integer`,
          });
          return;
        }
        if (obs.payload !== undefined) {
          const serialized = JSON.stringify(obs.payload);
          if (serialized.length > MAX_OBSERVATION_PAYLOAD_CHARS) {
            res.status(400).json({
              error: `observations[${index}].payload exceeds ${MAX_OBSERVATION_PAYLOAD_CHARS} chars`,
            });
            return;
          }
        }
        parsed.push({
          observationId: obs.observationId,
          generatedAt: obs.generatedAt,
          payload: obs.payload,
        });
      }

      try {
        const result = materializeObservations(deps.db, {
          bindingId,
          mnSubject,
          childId,
          observations: parsed,
          now: now(),
        });
        res.json(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        res.status(400).json({ error: message });
      }
    },
  );

  app.post(
    "/api/mn-observation/observation",
    (req: Request, res: Response) => {
      const body = (req.body ?? {}) as Record<string, unknown>;
      const childId = body.childId;
      if (typeof childId !== "string" || childId.length === 0) {
        res.status(400).json({ error: "childId is required" });
        return;
      }
      const requestedLimit =
        typeof body.limit === "number" && Number.isFinite(body.limit)
          ? Math.floor(body.limit)
          : DEFAULT_READ_LIMIT;
      const limit = Math.min(
        Math.max(requestedLimit, 1),
        MAX_READ_LIMIT,
      );
      const result = readLatestObservations(deps.db, childId, limit);
      res.json(result);
    },
  );
}

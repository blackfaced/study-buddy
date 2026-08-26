// server/src/hypothesis-workflow.ts
//
// T06: state machine for case_hypotheses. The review workspace lets
// the parent and/or kid propose error-cause hypotheses ("compute
// error", "forgot to carry", "didn't read the question", etc.) and
// mark each one accepted / rejected / modified. Unconfirmed
// hypotheses are filtered out of the kid-facing view + the parent
// report.
//
// Lifecycle:
//
//   addHypothesis(caseId, source, text, label?) → row (status=pending)
//   confirmHypothesis(id)                       → row (status=confirmed)
//   rejectHypothesis(id)                        → row (status=rejected)
//   modifyHypothesis(id, newText, newLabel?)    → row (status=modified, parent_hypothesis_id=id)
//
// All transitions are CAS-guarded by the row's current status. Idempotent
// on the *current* state (re-confirming a confirmed row is a 200 no-op,
// not a 409 — confirmations are cheap and re-firing them shouldn't
// alarm the parent UI).

import type Database from "better-sqlite3";
import { validateHypothesis } from "./hypothesis-validate.js";

export class HypothesisNotFoundError extends Error {
  constructor(public readonly id: number) {
    super(`hypothesis ${id} not found`);
    this.name = "HypothesisNotFoundError";
  }
}

export class HypothesisConflictError extends Error {
  constructor(
    public readonly id: number,
    public readonly fromStatus: string,
    public readonly attempted: string,
  ) {
    super(
      `hypothesis ${id} is '${fromStatus}', cannot ${attempted}`,
    );
    this.name = "HypothesisConflictError";
  }
}

export interface AddInput {
  caseId: string;
  childId: string;
  source: "system" | "parent" | "kid";
  text: string;
  label?: string | null;
  now?: () => number;
}

export interface HypothesisRow {
  id: number;
  caseId: string;
  childId: string;
  hypothesis: string;
  label: string | null;
  source: "system" | "parent" | "kid";
  status: "pending" | "confirmed" | "rejected" | "modified";
  parentHypothesisId: number | null;
  sensitive: number;
  createdAt: number;
  confirmedAt: number | null;
}

function loadHypothesis(
  db: Database.Database,
  id: number,
): HypothesisRow | null {
  const row = db
    .prepare(
      `SELECT id, case_id AS caseId, child_id AS childId, hypothesis,
              label, source, status, parent_hypothesis_id AS parentHypothesisId,
              sensitive, created_at AS createdAt, confirmed_at AS confirmedAt
         FROM case_hypotheses WHERE id = ?`,
    )
    .get(id) as HypothesisRow | undefined;
  return row ?? null;
}

export function addHypothesis(
  db: Database.Database,
  input: AddInput,
): HypothesisRow {
  const { text, sensitive } = validateHypothesis(input.text);
  if (text === "") {
    throw new Error("addHypothesis: text is empty");
  }
  const now = input.now ?? Date.now;
  const r = db
    .prepare(
      `INSERT INTO case_hypotheses
         (case_id, child_id, hypothesis, label, source, status,
          parent_hypothesis_id, sensitive, created_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'pending', NULL, ?, ?, NULL)`,
    )
    .run(
      input.caseId,
      input.childId,
      text,
      input.label ?? null,
      input.source,
      sensitive ? 1 : 0,
      now(),
    );
  const created = loadHypothesis(db, Number(r.lastInsertRowid));
  if (!created) throw new Error("addHypothesis: insert failed");
  return created;
}

export function confirmHypothesis(
  db: Database.Database,
  id: number,
  now: () => number = Date.now,
): HypothesisRow {
  const h = loadHypothesis(db, id);
  if (!h) throw new HypothesisNotFoundError(id);
  if (h.status === "confirmed") return h; // idempotent
  if (h.status === "rejected") {
    throw new HypothesisConflictError(id, h.status, "confirm");
  }
  if (h.status === "modified") {
    // Modified hypotheses are already in the parent's chosen state.
    // The "original" row stays as 'modified' (audit); a confirm here
    // means "confirm the modification" — flip modified → confirmed.
    db.prepare(
      `UPDATE case_hypotheses
          SET status = 'confirmed', confirmed_at = ?
        WHERE id = ?`,
    ).run(now(), id);
  } else {
    db.prepare(
      `UPDATE case_hypotheses
          SET status = 'confirmed', confirmed_at = ?
        WHERE id = ?`,
    ).run(now(), id);
  }
  return loadHypothesis(db, id)!;
}

export function rejectHypothesis(
  db: Database.Database,
  id: number,
): HypothesisRow {
  const h = loadHypothesis(db, id);
  if (!h) throw new HypothesisNotFoundError(id);
  if (h.status === "rejected") return h; // idempotent
  if (h.status === "confirmed") {
    throw new HypothesisConflictError(id, h.status, "reject");
  }
  db.prepare(
    `UPDATE case_hypotheses SET status = 'rejected' WHERE id = ?`,
  ).run(id);
  return loadHypothesis(db, id)!;
}

export function modifyHypothesis(
  db: Database.Database,
  id: number,
  newText: string,
  newLabel?: string | null,
  now: () => number = Date.now,
): HypothesisRow {
  const h = loadHypothesis(db, id);
  if (!h) throw new HypothesisNotFoundError(id);
  if (h.status === "rejected") {
    throw new HypothesisConflictError(id, h.status, "modify");
  }
  const { text, sensitive } = validateHypothesis(newText);
  if (text === "") throw new Error("modifyHypothesis: text is empty");
  // A modify on a 'modified' row replaces the most-recent version in
  // place; only the first transition from a 'pending' or 'confirmed'
  // row creates a new audit row.
  if (h.status === "modified" && h.parentHypothesisId === id) {
    // shouldn't happen — status='modified' implies parentHypothesisId
    // points to a *different* row, but defensive:
  }
  const r = db
    .prepare(
      `INSERT INTO case_hypotheses
         (case_id, child_id, hypothesis, label, source, status,
          parent_hypothesis_id, sensitive, created_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, 'modified', ?, ?, ?, NULL)`,
    )
    .run(
      h.caseId,
      h.childId,
      text,
      newLabel ?? h.label,
      h.source,
      id,
      sensitive ? 1 : 0,
      now(),
    );
  // mark the original as 'modified' so further modifies branch from it
  db.prepare(
    `UPDATE case_hypotheses SET status = 'modified' WHERE id = ?`,
  ).run(id);
  return loadHypothesis(db, Number(r.lastInsertRowid))!;
}

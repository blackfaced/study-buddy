import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const SOURCE_EVENT_SCHEMA_VERSION = 1;
export const DEFAULT_SOURCE_EVENT_PAGE_SIZE = 50;
export const MAX_SOURCE_EVENT_PAGE_SIZE = 100;

export interface LearningAttemptSourceInput {
  mistakeId: number;
  childId: string;
  occurredAt: number;
  problem: string;
  submittedAnswer: string;
  expectedAnswer: string | null;
  mistakeType: string | null;
  source: string;
}

export interface SourceEventIdentity {
  sourceProduct: "study_buddy";
  sourceInstallationId: string;
  recordType: "learning_attempt";
  recordId: string;
  revision: number;
}

export interface SourceEvent {
  sequence: number;
  eventId: string;
  eventType: "learning_attempt_recorded";
  eventSchemaVersion: number;
  occurredAt: string;
  sourceIdentity: SourceEventIdentity;
  payload: {
    kind: "learning_attempt";
    subjectRef: string;
    subject: "math";
    problem: string;
    submittedAnswer: string;
    expectedAnswer: string | null;
    mistakeType: string | null;
    source: string;
  };
}

interface SourceEventRow {
  sequence: number;
  event_id: string;
  event_type: "learning_attempt_recorded";
  event_schema_version: number;
  occurred_at: number;
  source_product: "study_buddy";
  source_installation_id: string;
  record_type: "learning_attempt";
  record_id: string;
  revision: number;
  payload_json: string;
}

export function appendLearningAttemptSourceEvent(
  db: Database.Database,
  input: LearningAttemptSourceInput,
): void {
  const installationId = getInstallationIdentity(db);
  const subjectRef = getOrCreateSubjectRef(db, input.childId);
  const payload: SourceEvent["payload"] = {
    kind: "learning_attempt",
    subjectRef,
    subject: "math",
    problem: input.problem,
    submittedAnswer: input.submittedAnswer,
    expectedAnswer: input.expectedAnswer,
    mistakeType: input.mistakeType,
    source: input.source,
  };
  db.prepare(
    `INSERT INTO source_events (
       event_id, source_product, source_installation_id, subject_ref, record_type, record_id,
       revision, occurred_at, event_type, event_schema_version, payload_json
     ) VALUES (?, 'study_buddy', ?, ?, 'learning_attempt', ?, 1, ?,
               'learning_attempt_recorded', ?, ?)`,
  ).run(
    randomUUID(),
    installationId,
    subjectRef,
    `mistake:${input.mistakeId}`,
    input.occurredAt,
    SOURCE_EVENT_SCHEMA_VERSION,
    JSON.stringify(payload),
  );
}

export function getInstallationIdentity(db: Database.Database): string {
  const row = db
    .prepare(
      "SELECT installation_id FROM source_installation WHERE singleton_id = 1",
    )
    .get() as { installation_id: string } | undefined;
  if (!row) {
    throw new Error("source installation identity is not initialized");
  }
  return row.installation_id;
}

function getOrCreateSubjectRef(
  db: Database.Database,
  childId: string,
): string {
  const existing = db
    .prepare("SELECT subject_ref FROM source_subjects WHERE child_id = ?")
    .get(childId) as { subject_ref: string } | undefined;
  if (existing) return existing.subject_ref;
  const subjectRef = randomUUID();
  db.prepare(
    "INSERT INTO source_subjects (child_id, subject_ref) VALUES (?, ?)",
  ).run(childId, subjectRef);
  return subjectRef;
}

export function readSourceEventPage(
  db: Database.Database,
  after: number,
  limit: number,
): {
  events: SourceEvent[];
  nextCursor: number;
  hasMore: boolean;
} {
  const rows = db
    .prepare(
      `SELECT seq AS sequence, event_id, event_type, event_schema_version,
              occurred_at, source_product, source_installation_id, record_type, record_id,
              revision, payload_json
       FROM source_events
       WHERE seq > ?
       ORDER BY seq ASC
       LIMIT ?`,
    )
    .all(after, limit + 1) as SourceEventRow[];
  const hasMore = rows.length > limit;
  const pageRows = hasMore ? rows.slice(0, limit) : rows;
  const events = pageRows.map(sourceEventFromRow);
  return {
    events,
    nextCursor: events.at(-1)?.sequence ?? after,
    hasMore,
  };
}

function sourceEventFromRow(row: SourceEventRow): SourceEvent {
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    eventType: row.event_type,
    eventSchemaVersion: row.event_schema_version,
    occurredAt: new Date(row.occurred_at).toISOString(),
    sourceIdentity: {
      sourceProduct: row.source_product,
      sourceInstallationId: row.source_installation_id,
      recordType: row.record_type,
      recordId: row.record_id,
      revision: row.revision,
    },
    payload: JSON.parse(row.payload_json) as SourceEvent["payload"],
  };
}

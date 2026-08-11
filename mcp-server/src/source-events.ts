import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const SOURCE_EVENT_SCHEMA_VERSION = 1;

function getInstallationIdentity(db: Database.Database): string {
  const row = db.prepare(
    "SELECT installation_id FROM source_installation WHERE singleton_id = 1",
  ).get() as { installation_id: string } | undefined;
  if (!row) throw new Error("source installation identity is not initialized");
  return row.installation_id;
}

function getOrCreateSubjectRef(db: Database.Database, childId: string): string {
  const existing = db.prepare(
    "SELECT subject_ref FROM source_subjects WHERE child_id = ?",
  ).get(childId) as { subject_ref: string } | undefined;
  if (existing) return existing.subject_ref;
  const subjectRef = randomUUID();
  db.prepare(
    "INSERT INTO source_subjects (child_id, subject_ref) VALUES (?, ?)",
  ).run(childId, subjectRef);
  return subjectRef;
}

function appendSourceEvent(
  db: Database.Database,
  input: {
    childId: string;
    recordType: "learning_attempt" | "learning_session" | "chat_turn";
    recordId: string;
    revision: number;
    occurredAt: number;
    eventType: "learning_attempt_recorded" | "learning_session_completed" | "chat_turn_recorded";
    payload: Record<string, unknown>;
  },
): void {
  const subjectRef = getOrCreateSubjectRef(db, input.childId);
  db.prepare(
    `INSERT INTO source_events (
       event_id, source_product, source_installation_id, subject_ref, record_type,
       record_id, revision, occurred_at, event_type, event_schema_version, payload_json
     ) VALUES (?, 'study_buddy', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    getInstallationIdentity(db),
    subjectRef,
    input.recordType,
    input.recordId,
    input.revision,
    input.occurredAt,
    input.eventType,
    SOURCE_EVENT_SCHEMA_VERSION,
    JSON.stringify({ ...input.payload, subjectRef }),
  );
}

export function appendMcpSessionSourceEvent(
  db: Database.Database,
  input: {
    sessionId: string;
    childId: string;
    occurredAt: number;
    subject: string | null;
    startedAt: number;
    endedAt: number;
    durationMinutes: number;
    averageFocusScore: number;
    postureWarningCount: number;
    offTopicCount: number;
    offTopicRecovered: number;
  },
): void {
  appendSourceEvent(db, {
    childId: input.childId,
    recordType: "learning_session",
    recordId: `session:${input.sessionId}`,
    revision: 1,
    occurredAt: input.occurredAt,
    eventType: "learning_session_completed",
    payload: {
      kind: "learning_session",
      sessionKind: "study",
      subject: input.subject,
      startedAt: input.startedAt,
      endedAt: input.endedAt,
      durationMinutes: input.durationMinutes,
      averageFocusScore: input.averageFocusScore,
      postureWarningCount: input.postureWarningCount,
      offTopicCount: input.offTopicCount,
      offTopicRecovered: input.offTopicRecovered,
    },
  });
}

export function appendMcpChatTurnSourceEvent(
  db: Database.Database,
  input: {
    turnId: number;
    sessionId: string;
    childId: string;
    occurredAt: number;
    role: "child" | "agent";
  },
): void {
  appendSourceEvent(db, {
    childId: input.childId,
    recordType: "chat_turn",
    recordId: `chat_turn:${input.turnId}`,
    revision: 1,
    occurredAt: input.occurredAt,
    eventType: "chat_turn_recorded",
    payload: {
      kind: "chat_turn_reference",
      sessionRef: `session:${input.sessionId}`,
      turnRef: `chat_turn:${input.turnId}`,
      role: input.role,
      occurredAt: new Date(input.occurredAt).toISOString(),
    },
  });
}

export function appendMcpMistakeSourceEvent(
  db: Database.Database,
  input: {
    mistakeId: number;
    childId: string;
    occurredAt: number;
    subject: string;
    problem: string;
    mistakeType: string;
  },
): void {
  appendSourceEvent(db, {
    childId: input.childId,
    recordType: "learning_attempt",
    recordId: `mistake:${input.mistakeId}`,
    revision: 1,
    occurredAt: input.occurredAt,
    eventType: "learning_attempt_recorded",
    payload: {
      kind: "learning_attempt",
      subject: input.subject,
      problem: input.problem,
      submittedAnswer: "",
      expectedAnswer: null,
      mistakeType: input.mistakeType,
      source: "study-buddy",
    },
  });
}

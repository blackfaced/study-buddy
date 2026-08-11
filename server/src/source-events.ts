import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

export const SOURCE_EVENT_SCHEMA_VERSION = 1;
export const DEFAULT_SOURCE_EVENT_PAGE_SIZE = 50;
export const MAX_SOURCE_EVENT_PAGE_SIZE = 100;

const CHAT_SESSION_REF_PREFIX = "session:";
const CHAT_TURN_REF_PREFIX = "chat_turn:";

export type SourceRecordType =
  | "learning_attempt"
  | "learning_session"
  | "chat_turn";

export type SourceEventType =
  | "learning_attempt_recorded"
  | "learning_session_completed"
  | "source_record_corrected"
  | "source_record_withdrawn"
  | "chat_turn_recorded";

export interface LearningAttemptSourceInput {
  mistakeId: number;
  childId: string;
  occurredAt: number;
  subject?: string;
  problem: string;
  submittedAnswer: string;
  expectedAnswer: string | null;
  mistakeType: string | null;
  source: string;
}

export interface StudySessionPayloadInput {
  kind: "learning_session";
  sessionKind: "study";
  subject: string | null;
  startedAt: number;
  endedAt: number;
  durationMinutes: number;
  averageFocusScore: number;
  postureWarningCount: number;
  offTopicCount: number;
  offTopicRecovered: number;
}

export interface GameSessionPayloadInput {
  kind: "learning_session";
  sessionKind: "game";
  appId: string;
  startedAt: number;
  endedAt: number;
  durationMinutes: number;
  totalQuestions: number;
  correctCount: number;
}

export interface LearningSessionSourceInput {
  recordId: string;
  childId: string;
  occurredAt: number;
  revision: number;
  eventType: "learning_session_completed" | "source_record_corrected";
  payload: StudySessionPayloadInput | GameSessionPayloadInput;
}

export interface ChatTurnSourceInput {
  turnId: number;
  sessionId: string;
  childId: string;
  occurredAt: number;
  role: "child" | "agent";
}

export interface SourceWithdrawalInput {
  recordType: "learning_session" | "chat_turn";
  recordId: string;
  childId: string;
  occurredAt: number;
  revision: number;
}

export interface SourceEventIdentity {
  sourceProduct: "study_buddy";
  sourceInstallationId: string;
  recordType: SourceRecordType;
  recordId: string;
  revision: number;
}

export type SourceEventPayload =
  | {
      kind: "learning_attempt";
      subjectRef: string;
      subject: string;
      problem: string;
      submittedAnswer: string;
      expectedAnswer: string | null;
      mistakeType: string | null;
      source: string;
    }
  | ((StudySessionPayloadInput | GameSessionPayloadInput) & {
      subjectRef: string;
    })
  | {
      kind: "chat_turn_reference";
      subjectRef: string;
      sessionRef: string;
      turnRef: string;
      role: "child" | "agent";
      occurredAt: string;
    }
  | null;

export interface SourceEvent {
  sequence: number;
  eventId: string;
  eventType: SourceEventType;
  eventSchemaVersion: number;
  occurredAt: string;
  sourceIdentity: SourceEventIdentity;
  payload: SourceEventPayload;
}

interface SourceEventRow {
  sequence: number;
  event_id: string;
  event_type: string;
  event_schema_version: number;
  occurred_at: number;
  source_product: string;
  source_installation_id: string;
  subject_ref: string;
  record_type: string;
  record_id: string;
  revision: number;
  payload_json: string | null;
}

export class SourceEventContractError extends Error {}

export function appendLearningAttemptSourceEvent(
  db: Database.Database,
  input: LearningAttemptSourceInput,
): void {
  const subjectRef = getOrCreateSubjectRef(db, input.childId);
  appendSourceEvent(db, {
    subjectRef,
    recordType: "learning_attempt",
    recordId: `mistake:${input.mistakeId}`,
    revision: 1,
    occurredAt: input.occurredAt,
    eventType: "learning_attempt_recorded",
    payload: {
      kind: "learning_attempt",
      subjectRef,
      subject: input.subject ?? "math",
      problem: input.problem,
      submittedAnswer: input.submittedAnswer,
      expectedAnswer: input.expectedAnswer,
      mistakeType: input.mistakeType,
      source: input.source,
    },
  });
}

export function appendLearningSessionSourceEvent(
  db: Database.Database,
  input: LearningSessionSourceInput,
): void {
  const subjectRef = getOrCreateSubjectRef(db, input.childId);
  appendSourceEvent(db, {
    subjectRef,
    recordType: "learning_session",
    recordId: input.recordId,
    revision: input.revision,
    occurredAt: input.occurredAt,
    eventType: input.eventType,
    payload: { ...input.payload, subjectRef },
  });
}

export function appendChatTurnSourceEvent(
  db: Database.Database,
  input: ChatTurnSourceInput,
): void {
  const subjectRef = getOrCreateSubjectRef(db, input.childId);
  const occurredAt = new Date(input.occurredAt).toISOString();
  appendSourceEvent(db, {
    subjectRef,
    recordType: "chat_turn",
    recordId: chatTurnRecordId(input.turnId),
    revision: 1,
    occurredAt: input.occurredAt,
    eventType: "chat_turn_recorded",
    payload: {
      kind: "chat_turn_reference",
      subjectRef,
      sessionRef: chatSessionRef(input.sessionId),
      turnRef: chatTurnRecordId(input.turnId),
      role: input.role,
      occurredAt,
    },
  });
}

export function chatSessionRef(sessionId: string): string {
  return `${CHAT_SESSION_REF_PREFIX}${sessionId}`;
}

export function chatTurnRecordId(turnId: number): string {
  return `${CHAT_TURN_REF_PREFIX}${turnId}`;
}

export function parseChatSessionRef(value: string): string | null {
  return /^session:[A-Za-z0-9_-]{1,128}$/.test(value)
    ? value.slice(CHAT_SESSION_REF_PREFIX.length)
    : null;
}

export function parseChatTurnRecordId(value: string): number | null {
  if (!/^chat_turn:[1-9][0-9]*$/.test(value)) return null;
  const id = Number(value.slice(CHAT_TURN_REF_PREFIX.length));
  return Number.isSafeInteger(id) ? id : null;
}

export function appendSourceWithdrawal(
  db: Database.Database,
  input: SourceWithdrawalInput,
): void {
  appendSourceEvent(db, {
    subjectRef: getOrCreateSubjectRef(db, input.childId),
    recordType: input.recordType,
    recordId: input.recordId,
    revision: input.revision,
    occurredAt: input.occurredAt,
    eventType: "source_record_withdrawn",
    payload: null,
  });
}

interface AppendSourceEventInput {
  subjectRef: string;
  recordType: SourceRecordType;
  recordId: string;
  revision: number;
  occurredAt: number;
  eventType: SourceEventType;
  payload: SourceEventPayload;
}

function appendSourceEvent(
  db: Database.Database,
  input: AppendSourceEventInput,
): void {
  db.prepare(
    `INSERT INTO source_events (
       event_id, source_product, source_installation_id, subject_ref, record_type, record_id,
       revision, occurred_at, event_type, event_schema_version, payload_json
     ) VALUES (?, 'study_buddy', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomUUID(),
    getInstallationIdentity(db),
    input.subjectRef,
    input.recordType,
    input.recordId,
    input.revision,
    input.occurredAt,
    input.eventType,
    SOURCE_EVENT_SCHEMA_VERSION,
    input.payload === null ? null : JSON.stringify(input.payload),
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

export function getOrCreateSubjectRef(
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
              occurred_at, source_product, source_installation_id, subject_ref, record_type, record_id,
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
  if (
    row.event_schema_version !== SOURCE_EVENT_SCHEMA_VERSION ||
    row.source_product !== "study_buddy" ||
    typeof row.source_installation_id !== "string" ||
    row.source_installation_id.length === 0 ||
    typeof row.subject_ref !== "string" ||
    row.subject_ref.length === 0 ||
    !isRecordType(row.record_type) ||
    !isEventType(row.event_type) ||
    typeof row.record_id !== "string" ||
    row.record_id.length === 0 ||
    !Number.isSafeInteger(row.revision) ||
    row.revision < 1 ||
    !isTimestamp(row.occurred_at)
  ) {
    throw new SourceEventContractError("unsupported stored source event");
  }
  const payload = row.payload_json === null ? null : parsePayload(row.payload_json);
  if ((row.event_type === "source_record_withdrawn") !== (payload === null)) {
    throw new SourceEventContractError("withdrawal payload contract violated");
  }
  if (!isCompatiblePayload(
    row.record_type,
    row.event_type,
    payload,
    row.subject_ref,
  )) {
    throw new SourceEventContractError("source event payload contract violated");
  }
  return {
    sequence: row.sequence,
    eventId: row.event_id,
    eventType: row.event_type,
    eventSchemaVersion: row.event_schema_version,
    occurredAt: new Date(row.occurred_at).toISOString(),
    sourceIdentity: {
      sourceProduct: "study_buddy",
      sourceInstallationId: row.source_installation_id,
      recordType: row.record_type,
      recordId: row.record_id,
      revision: row.revision,
    },
    payload,
  };
}

function parsePayload(raw: string): Exclude<SourceEventPayload, null> {
  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    throw new SourceEventContractError("malformed source event payload");
  }
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new SourceEventContractError("malformed source event payload");
  }
  const kind = (payload as { kind?: unknown }).kind;
  if (![
    "learning_attempt",
    "learning_session",
    "chat_turn_reference",
  ].includes(String(kind))) {
    throw new SourceEventContractError("unsupported source event payload");
  }
  return payload as Exclude<SourceEventPayload, null>;
}

function isRecordType(value: string): value is SourceRecordType {
  return ["learning_attempt", "learning_session", "chat_turn"].includes(value);
}

function isEventType(value: string): value is SourceEventType {
  return [
    "learning_attempt_recorded",
    "learning_session_completed",
    "source_record_corrected",
    "source_record_withdrawn",
    "chat_turn_recorded",
  ].includes(value);
}

function isCompatiblePayload(
  recordType: SourceRecordType,
  eventType: SourceEventType,
  payload: SourceEventPayload,
  subjectRef: string,
): boolean {
  if (eventType === "source_record_withdrawn") {
    return payload === null && recordType !== "learning_attempt";
  }
  if (!payload) return false;
  if (recordType === "learning_attempt") {
    return eventType === "learning_attempt_recorded" &&
      payload.kind === "learning_attempt" &&
      payload.subjectRef === subjectRef &&
      typeof payload.subject === "string" && payload.subject.length > 0 &&
      typeof payload.problem === "string" &&
      typeof payload.submittedAnswer === "string" &&
      isStringOrNull(payload.expectedAnswer) &&
      isStringOrNull(payload.mistakeType) &&
      typeof payload.source === "string";
  }
  if (recordType === "learning_session") {
    if (
      !["learning_session_completed", "source_record_corrected"].includes(eventType) ||
      payload.kind !== "learning_session" ||
      payload.subjectRef !== subjectRef ||
      !isTimestamp(payload.startedAt) ||
      !isTimestamp(payload.endedAt) ||
      payload.endedAt < payload.startedAt ||
      !isNonNegativeNumber(payload.durationMinutes)
    ) return false;
    if (payload.sessionKind === "study") {
      return isStringOrNull(payload.subject) &&
        isNonNegativeNumber(payload.averageFocusScore) &&
        isNonNegativeInteger(payload.postureWarningCount) &&
        isNonNegativeInteger(payload.offTopicCount) &&
        isNonNegativeInteger(payload.offTopicRecovered);
    }
    if (payload.sessionKind === "game") {
      return typeof payload.appId === "string" && payload.appId.length > 0 &&
        isNonNegativeInteger(payload.totalQuestions) && payload.totalQuestions > 0 &&
        isNonNegativeInteger(payload.correctCount) &&
        payload.correctCount <= payload.totalQuestions;
    }
    return false;
  }
  return eventType === "chat_turn_recorded" &&
    payload.kind === "chat_turn_reference" &&
    payload.subjectRef === subjectRef &&
    parseChatSessionRef(payload.sessionRef) !== null &&
    parseChatTurnRecordId(payload.turnRef) !== null &&
    ["child", "agent"].includes(payload.role) &&
    isIsoTimestamp(payload.occurredAt);
}

function isStringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

function isNonNegativeNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isTimestamp(value: unknown): value is number {
  return isNonNegativeNumber(value) && !Number.isNaN(new Date(value).valueOf());
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

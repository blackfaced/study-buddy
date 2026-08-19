// src/db-migrate.ts
// Schema migration for the HTTP server's SQLite database.
//
// Bug 4 (v0.1): server/src/index.ts only did `new Database(DB_PATH)` without
// running the migration defined in mcp-server/src/db.ts. When the HTTP
// server tried to write to chat_turns.state, the column didn't exist (in
// the server's view) and the INSERT 500'd.
//
// Fix: extract the schema bootstrap into a function, import it from the
// server, and call it at startup. The function is idempotent — every
// `ALTER TABLE ... ADD COLUMN` is wrapped in try/catch because SQLite
// throws "duplicate column" on the second call.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { inferMistakeLevel } from "./mistake-level.js";

const SOURCE_EVENTS_TABLE_SQL = `
  CREATE TABLE source_events (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    source_product TEXT NOT NULL CHECK (source_product = 'study_buddy'),
    source_installation_id TEXT NOT NULL,
    subject_ref TEXT NOT NULL,
    record_type TEXT NOT NULL CHECK (record_type IN ('learning_attempt', 'learning_session', 'chat_turn')),
    record_id TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision > 0),
    occurred_at INTEGER NOT NULL,
    event_type TEXT NOT NULL CHECK (event_type IN ('learning_attempt_recorded', 'learning_session_completed', 'source_record_corrected', 'source_record_withdrawn', 'chat_turn_recorded')),
    event_schema_version INTEGER NOT NULL CHECK (event_schema_version = 1),
    payload_json TEXT CHECK (payload_json IS NULL OR (json_valid(payload_json) AND length(payload_json) <= 4096)),
    created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
    UNIQUE (record_type, record_id, revision),
    FOREIGN KEY (source_installation_id) REFERENCES source_installation(installation_id) ON DELETE RESTRICT,
    FOREIGN KEY (subject_ref) REFERENCES source_subjects(subject_ref) ON DELETE RESTRICT
  )`;

export function migrateSchema(db: Database.Database): void {
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  // 兼容老 DB：给已有表加新列（try/catch 实现 idempotent）
  try { db.exec(`ALTER TABLE chat_turns ADD COLUMN state TEXT DEFAULT 'writing'`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN hint TEXT`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN writing_turns INTEGER DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN source_revision INTEGER NOT NULL DEFAULT 0`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN source_withdrawn_at INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE sessions ADD COLUMN device_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE game_sessions ADD COLUMN source_record_id TEXT`); } catch {}
  // v0.5: vision-mistake columns
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN image_path TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_input TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_reasoning TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_model TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN vision_ts INTEGER`); } catch {}
  // v0.5b: game-sync columns. `source` is one of "study-buddy" | "game" | "vision" — let
  // us split mistake streams when computing weak topics for the agent.
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN source TEXT DEFAULT 'study-buddy'`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN user_answer TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN correct_answer TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN evidence_key TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN evidence_status TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN evidence_method TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN evidence_confirmed_at INTEGER`); } catch {}
  // v0.8 (#34a-1, issue #98): per-child mistake dedupe. Existing rows are
  // back-filled with child_id = 'default' so the UNIQUE index can be built
  // without conflicts. The endpoint (/api/game/mistake) accepts an explicit
  // childId; missing/empty defaults to 'default' for backwards compat.
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN child_id TEXT NOT NULL DEFAULT 'default'`); } catch {}

  // v0.8.x (#146/#148): per-mistake level. Stored at creation time so the
  // candy-math-island picker can just compare `m.level <= kidLevel` instead
  // of running a text-based heuristic on every draw. Backfill below
  // populates level for any pre-existing rows that pre-date the column.
  try { db.exec(`ALTER TABLE mistakes ADD COLUMN level INTEGER`); } catch {}

  // v0.8 (#34a-1, issue #98): normalize the source on legacy rows. Do not
  // delete duplicate rows: each row is original evidence for the mistake
  // compatibility model created below.
  try {
    db.exec("UPDATE mistakes SET source = 'study-buddy' WHERE source IS NULL OR source = ''");
  } catch {
    /* fresh DB — mistakes table does not exist yet */
  }

  // Explainable handwriting coach attempt payload (issues #103/#108).
  // Keep the legacy level/stroke_path columns so old rows and callers
  // remain readable during the expand-contract rollout.
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN score INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN display_band TEXT`); } catch {}
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN status TEXT`); } catch {}
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN strokes_json TEXT`); } catch {}
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN assessment_json TEXT`); } catch {}
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN process_json TEXT`); } catch {}
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN algorithm_version TEXT`); } catch {}
  try { db.exec(`ALTER TABLE writing_attempts ADD COLUMN model_review_json TEXT`); } catch {}

  widenSourceEventVocabulary(db);

  // v0.9 (SB124-T01, issue #125): widen mistake_cases and
  // correction_obligations to carry the full evidence record.
  // Idempotent ALTER (try/catch) so re-running the migration is a
  // no-op once the columns exist.
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN session_id TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN ts INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN subject TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN problem TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN error_type TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN hint TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN level INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN image_path TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN vision_input TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN vision_reasoning TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN vision_model TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN vision_ts INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN user_answer TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN correct_answer TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN evidence_key TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN evidence_status TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN evidence_method TEXT`); } catch {}
  try { db.exec(`ALTER TABLE mistake_cases ADD COLUMN evidence_confirmed_at INTEGER`); } catch {}
  try { db.exec(`ALTER TABLE correction_obligations ADD COLUMN reviewed_count INTEGER NOT NULL DEFAULT 0`); } catch {}

  // 初始化 schema
  db.exec(`
    CREATE TABLE IF NOT EXISTS children (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      birth_year INTEGER,
      grade TEXT,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS paired_devices (
      device_id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL,
      credential_hash TEXT NOT NULL UNIQUE,
      device_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      revoked_at INTEGER,
      FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS pairing_codes (
      id TEXT PRIMARY KEY,
      code_hash TEXT NOT NULL UNIQUE,
      child_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      used_at INTEGER,
      FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL,
      started_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      ended_at INTEGER,
      subject TEXT,
      total_minutes INTEGER DEFAULT 0,
      avg_focus_score REAL DEFAULT 0,
      posture_warning_count INTEGER DEFAULT 0,
      offtopic_count INTEGER DEFAULT 0,
      offtopic_recovered INTEGER DEFAULT 0,
      writing_turns INTEGER DEFAULT 0,
      source_revision INTEGER NOT NULL DEFAULT 0,
      source_withdrawn_at INTEGER,
      device_id TEXT,
      FOREIGN KEY (device_id) REFERENCES paired_devices(device_id),
      FOREIGN KEY (child_id) REFERENCES children(id)
    );

    CREATE TABLE IF NOT EXISTS posture_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      score REAL,
      warning TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chat_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      role TEXT NOT NULL,
      content TEXT,
      topic TEXT,
      redirected INTEGER DEFAULT 0,
      state TEXT DEFAULT 'writing',
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS safety_incidents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      ts INTEGER NOT NULL,
      category TEXT NOT NULL CHECK (category IN ('bullying', 'abuse', 'self_harm', 'sexual', 'severe_symptom', 'personal_info')),
      urgency TEXT NOT NULL CHECK (urgency IN ('attention', 'imminent')),
      status TEXT NOT NULL DEFAULT 'needs_attention' CHECK (status IN ('needs_attention', 'resolved')),
      resolution TEXT CHECK (resolution IS NULL OR resolution IN ('acknowledged', 'false_positive')),
      resolved_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (child_id) REFERENCES children(id)
    );

    CREATE TABLE IF NOT EXISTS mistakes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      subject TEXT,
      problem TEXT,
      error_type TEXT,
      hint TEXT,
      reviewed_count INTEGER DEFAULT 0,
      image_path TEXT,
      vision_input TEXT,
      vision_reasoning TEXT,
      vision_model TEXT,
      vision_ts INTEGER,
      source TEXT DEFAULT 'study-buddy',
      user_answer TEXT,
      correct_answer TEXT,
      evidence_key TEXT,
      evidence_status TEXT,
      evidence_method TEXT,
      evidence_confirmed_at INTEGER,
      child_id TEXT NOT NULL DEFAULT 'default',
      level INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    );

    -- Compatibility model for the mistake-closure rollout. Legacy mistakes
    -- remain the evidence source; these tables add explicit cases, attempts,
    -- and correction obligations without changing old readers.
    --
    -- v0.9 (SB124-T01, issue #125): mistake_cases now carries the same
    -- evidence columns as mistakes so the case row is the source-of-truth
    -- for closure-loop reads. correction_obligations tracks reviewed_count
    -- (the v0.8.x "mastery" trigger). Old readers still go through
    -- mistakes; new readers go through these three tables.
    CREATE TABLE IF NOT EXISTS mistake_cases (
      case_id TEXT PRIMARY KEY,
      original_mistake_id INTEGER NOT NULL UNIQUE,
      child_id TEXT NOT NULL,
      source TEXT NOT NULL,
      opened_at INTEGER NOT NULL,
      session_id TEXT,
      ts INTEGER,
      subject TEXT,
      problem TEXT,
      error_type TEXT,
      hint TEXT,
      level INTEGER,
      image_path TEXT,
      vision_input TEXT,
      vision_reasoning TEXT,
      vision_model TEXT,
      vision_ts INTEGER,
      user_answer TEXT,
      correct_answer TEXT,
      evidence_key TEXT,
      evidence_status TEXT,
      evidence_method TEXT,
      evidence_confirmed_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS learning_attempts (
      attempt_id TEXT PRIMARY KEY,
      case_id TEXT NOT NULL,
      attempt_kind TEXT NOT NULL CHECK (attempt_kind IN ('original', 'correction', 'reinforcement')),
      mistake_id INTEGER,
      child_id TEXT NOT NULL,
      problem TEXT,
      user_answer TEXT,
      correct_answer TEXT,
      is_correct INTEGER NOT NULL CHECK (is_correct IN (0, 1)),
      occurred_at INTEGER NOT NULL,
      source TEXT NOT NULL,
      FOREIGN KEY (case_id) REFERENCES mistake_cases(case_id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS correction_obligations (
      case_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'verified')),
      opened_at INTEGER NOT NULL,
      verified_at INTEGER,
      reviewed_count INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS mistake_photo_confirmations (
      draft_id TEXT PRIMARY KEY,
      mistake_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      child_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      confirmation_method TEXT NOT NULL CHECK (
        confirmation_method IN ('explicit_acceptance', 'explicit_correction')
      ),
      confirmed_at INTEGER NOT NULL,
      FOREIGN KEY (mistake_id) REFERENCES mistakes(id) ON DELETE CASCADE,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (child_id) REFERENCES children(id),
      FOREIGN KEY (device_id) REFERENCES paired_devices(device_id)
    );

    -- SB124-T04 #128: page-photo multi-candidate capture. One row per
    -- page photo. State machine: 'analyzing' (layout running) →
    -- 'review' (layout done, candidates ready) → 'completed' (all
    -- candidates confirmed or discarded) / 'cancelled' (whole page
    -- dropped) / 'expired' (TTL hit). Source distinguishes "整页照片"
    -- from the existing single-photo path (which stays in
    -- mistake_photo_confirmations).
    CREATE TABLE IF NOT EXISTS mistake_photo_page_drafts (
      id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      device_id TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('analyzing', 'review', 'completed', 'cancelled', 'expired')),
      layout_model TEXT NOT NULL,
      layout_regions_json TEXT NOT NULL,         -- JSON array of { index, bbox, subject }
      layout_confidence TEXT NOT NULL CHECK (layout_confidence IN ('ok', 'low')),
      image_bytes BLOB NOT NULL,                 -- original photo, kept for per-region OCR (T04-B)
      image_extension TEXT NOT NULL,             -- e.g. "jpg", "png", "webp"
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      completed_at INTEGER,
      FOREIGN KEY (child_id) REFERENCES children(id),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (device_id) REFERENCES paired_devices(device_id)
    );

    CREATE INDEX IF NOT EXISTS mistake_photo_page_drafts_child_state
      ON mistake_photo_page_drafts (child_id, state, expires_at);

    CREATE TABLE IF NOT EXISTS settings (
      child_id TEXT PRIMARY KEY,
      topic_whitelist TEXT,
      posture_threshold REAL DEFAULT 0.6,
      session_limit_minutes INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS limit_decisions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      child_id TEXT NOT NULL,
      decided_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      mode TEXT NOT NULL,
      until_ts INTEGER,
      note TEXT,
      FOREIGN KEY (child_id) REFERENCES children(id)
    );

    -- v0.6: per-game-session summary (one row per finished time-mode run).
    -- Used for daily correct-rate + questions-completed aggregations.
    CREATE TABLE IF NOT EXISTS game_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_record_id TEXT,
      child_id TEXT NOT NULL,
      app_id TEXT NOT NULL,
      duration_sec INTEGER NOT NULL,
      total_questions INTEGER NOT NULL,
      correct_count INTEGER NOT NULL,
      started_at INTEGER NOT NULL,
      ended_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (child_id) REFERENCES children(id)
    );

    -- v0.7 (issue #57): write-app library + attempt history.
    -- writing_words is the kid's per-character word library.
    -- char is the PRIMARY KEY so duplicates are silently rejected on
    -- INSERT OR IGNORE below. writing_attempts stores the SVG stroke
    -- path the kid actually drew, so v0.2+ can analyze patterns.
    CREATE TABLE IF NOT EXISTS writing_words (
      char TEXT PRIMARY KEY,
      added_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      added_by TEXT DEFAULT 'parent'
    );

    CREATE TABLE IF NOT EXISTS writing_attempts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      char TEXT NOT NULL,
      level REAL NOT NULL,
      stroke_path TEXT,
      score INTEGER,
      display_band TEXT,
      status TEXT,
      strokes_json TEXT,
      assessment_json TEXT,
      process_json TEXT,
      algorithm_version TEXT,
      model_review_json TEXT,
      ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (char) REFERENCES writing_words(char) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS source_installation (
      singleton_id INTEGER PRIMARY KEY CHECK (singleton_id = 1),
      installation_id TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000)
    );

    CREATE TABLE IF NOT EXISTS source_subjects (
      child_id TEXT PRIMARY KEY,
      subject_ref TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE RESTRICT
    );

    ${SOURCE_EVENTS_TABLE_SQL.replace("CREATE TABLE source_events", "CREATE TABLE IF NOT EXISTS source_events")};

    CREATE INDEX IF NOT EXISTS idx_sessions_child ON sessions(child_id, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_posture_session ON posture_events(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_chat_session ON chat_turns(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_mistakes_session ON mistakes(session_id, ts);
    CREATE INDEX IF NOT EXISTS idx_game_sessions_child ON game_sessions(child_id, started_at DESC);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_game_sessions_source_record
      ON game_sessions(source_record_id) WHERE source_record_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_writing_attempts_char ON writing_attempts(char, ts DESC);
    CREATE INDEX IF NOT EXISTS idx_mistake_cases_child_opened
      ON mistake_cases(child_id, opened_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_attempts_case_occurred
      ON learning_attempts(case_id, occurred_at DESC);
    CREATE INDEX IF NOT EXISTS idx_learning_attempts_child_occurred
      ON learning_attempts(child_id, occurred_at DESC);

    -- v0.8 (#13): MemoryNexus incoming return path.
    -- mn_bindings maps a MemoryNexus subject (the external MN subject
    -- ref) to a study-buddy child. A child may have at most one active
    -- binding — the binding_id is the join key for projections and the
    -- lookup token the kid app carries to read observations back.
    --
    -- mn_observation_projections is the projection cache. Each row is
    -- one observation materialized from MN. The UNIQUE(binding_id,
    -- observation_id) constraint is the idempotency anchor — re-running
    -- the worker with the same observationId will not duplicate. The
    -- payload_json is opaque to study-buddy (MN owns its schema).
    CREATE TABLE IF NOT EXISTS mn_bindings (
      binding_id TEXT PRIMARY KEY,
      child_id TEXT NOT NULL,
      mn_subject TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active', 'revoked')),
      created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      updated_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
      FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mn_bindings_child_active
      ON mn_bindings(child_id) WHERE status = 'active';
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mn_bindings_subject
      ON mn_bindings(mn_subject);

    CREATE TABLE IF NOT EXISTS mn_observation_projections (
      projection_id TEXT PRIMARY KEY,
      binding_id TEXT NOT NULL,
      observation_id TEXT NOT NULL,
      generated_at INTEGER NOT NULL,
      payload_json TEXT NOT NULL,
      materialized_at INTEGER NOT NULL,
      FOREIGN KEY (binding_id) REFERENCES mn_bindings(binding_id) ON DELETE CASCADE,
      UNIQUE (binding_id, observation_id)
    );
    CREATE INDEX IF NOT EXISTS idx_mn_observations_binding_materialized
      ON mn_observation_projections(binding_id, materialized_at DESC);

    CREATE TRIGGER IF NOT EXISTS source_installation_immutable_update
      BEFORE UPDATE ON source_installation
      BEGIN SELECT RAISE(ABORT, 'source installation identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS source_installation_immutable_delete
      BEFORE DELETE ON source_installation
      BEGIN SELECT RAISE(ABORT, 'source installation identity is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS source_events_immutable_update
      BEFORE UPDATE ON source_events
      BEGIN SELECT RAISE(ABORT, 'source events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS source_events_immutable_delete
      BEFORE DELETE ON source_events
      BEGIN SELECT RAISE(ABORT, 'source events are immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sessions_device_reference_insert
      BEFORE INSERT ON sessions
      WHEN NEW.device_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM paired_devices WHERE device_id = NEW.device_id
      )
      BEGIN SELECT RAISE(ABORT, 'sessions.device_id references a missing device'); END;
    CREATE TRIGGER IF NOT EXISTS sessions_device_reference_update
      BEFORE UPDATE OF device_id ON sessions
      WHEN NEW.device_id IS NOT NULL AND NOT EXISTS (
        SELECT 1 FROM paired_devices WHERE device_id = NEW.device_id
      )
      BEGIN SELECT RAISE(ABORT, 'sessions.device_id references a missing device'); END;
    CREATE TRIGGER IF NOT EXISTS paired_devices_session_reference_delete
      BEFORE DELETE ON paired_devices
      WHEN EXISTS (SELECT 1 FROM sessions WHERE device_id = OLD.device_id)
      BEGIN SELECT RAISE(ABORT, 'paired device is referenced by sessions'); END;
    CREATE TRIGGER IF NOT EXISTS paired_devices_session_reference_update
      BEFORE UPDATE OF device_id ON paired_devices
      WHEN NEW.device_id IS NOT OLD.device_id
        AND EXISTS (SELECT 1 FROM sessions WHERE device_id = OLD.device_id)
      BEGIN SELECT RAISE(ABORT, 'paired device is referenced by sessions'); END;
  `);

  addMistakesChildIdForeignKey(db);
  ensureMistakeCompatibilityIndexes(db);
  backfillMistakeCompatibility(db);
  fillMissingCompatEvidence(db);
  backfillMistakeLevel(db);

  db.prepare(
    "DELETE FROM safety_incidents WHERE status = 'resolved' AND resolved_at < ?",
  ).run(Date.now() - 30 * 24 * 60 * 60 * 1000);

  db.prepare(
    "INSERT OR IGNORE INTO source_installation (singleton_id, installation_id) VALUES (1, ?)",
  ).run(randomUUID());

  // 首次启动：建一个默认孩子
  const existing = db.prepare("SELECT id FROM children WHERE id = 'default'").get();
  if (!existing) {
    db.prepare("INSERT INTO children (id, name, grade) VALUES (?, ?, ?)").run(
      "default", "小宝", "二年级"
    );
    db.prepare(
      "INSERT INTO settings (child_id, topic_whitelist) VALUES (?, ?)"
    ).run(
      "default",
      JSON.stringify(["作业", "老师", "课本", "同学", "数学", "语文", "英语", "拼音", "生字"])
    );
  }

  // v0.5 (no-pairing): seed a virtual "default" device so sessions /
  // mistake-photo routes that still write device_id can satisfy the
  // FK without requiring every kid device to redeem a pairing code.
  // The credential hash is the literal "noop" marker — no real
  // device will ever match it, and requireDevice no longer reads
  // paired_devices anyway.
  db.prepare(
    `INSERT OR IGNORE INTO paired_devices
       (device_id, child_id, credential_hash, device_name, created_at, last_seen_at)
     VALUES ('default', 'default', 'noop', 'default (no pairing)', 0, 0)`,
  ).run();
}

function ensureMistakeCompatibilityIndexes(db: Database.Database): void {
  db.transaction(() => {
    db.exec(`
      DROP INDEX IF EXISTS idx_mistakes_child_problem;
      DROP INDEX IF EXISTS idx_mistakes_child_problem_source;
      DROP INDEX IF EXISTS idx_mistakes_evidence_key;
    `);

    const hasDuplicateProblem = db.prepare(`
      SELECT 1 FROM mistakes
      WHERE problem IS NOT NULL
      GROUP BY child_id, problem, source
      HAVING COUNT(*) > 1
      LIMIT 1
    `).get();
    const hasDuplicateEvidence = db.prepare(`
      SELECT 1 FROM mistakes
      WHERE evidence_key IS NOT NULL
      GROUP BY evidence_key
      HAVING COUNT(*) > 1
      LIMIT 1
    `).get();

    db.exec(hasDuplicateProblem
      ? "CREATE INDEX idx_mistakes_child_problem_source ON mistakes(child_id, problem, source)"
      : "CREATE UNIQUE INDEX idx_mistakes_child_problem_source ON mistakes(child_id, problem, source)");
    db.exec(hasDuplicateEvidence
      ? "CREATE INDEX idx_mistakes_evidence_key ON mistakes(evidence_key) WHERE evidence_key IS NOT NULL"
      : "CREATE UNIQUE INDEX idx_mistakes_evidence_key ON mistakes(evidence_key) WHERE evidence_key IS NOT NULL");
  })();
}

export interface MistakeCompatibilityRecord {
  mistakeId: number;
  childId: string;
  source: string;
  occurredAt: number;
  problem: string | null;
  userAnswer?: string | null;
  correctAnswer?: string | null;
  // v0.9 (SB124-T01, issue #125): the full evidence record. Mistake_case
  // becomes the source-of-truth, so new compatibility writes must
  // carry the same fields as mistakes. Older callers may still
  // pass a minimal record; the helper tolerates that.
  sessionId?: string | null;
  subject?: string | null;
  errorType?: string | null;
  hint?: string | null;
  level?: number | null;
  imagePath?: string | null;
  visionInput?: string | null;
  visionReasoning?: string | null;
  visionModel?: string | null;
  visionTs?: number | null;
  evidenceKey?: string | null;
  evidenceStatus?: string | null;
  evidenceMethod?: string | null;
  evidenceConfirmedAt?: number | null;
  reviewedCount?: number | null;
}

/** Keep newly written legacy rows visible in the explicit mistake model. */
export function ensureMistakeCompatibility(
  db: Database.Database,
  record: MistakeCompatibilityRecord,
): void {
  const caseId = `mistake:${record.mistakeId}`;
  db.prepare(`
    INSERT OR IGNORE INTO mistake_cases (
      case_id, original_mistake_id, child_id, source, opened_at,
      session_id, ts, subject, problem, error_type, hint, level,
      image_path, vision_input, vision_reasoning, vision_model, vision_ts,
      user_answer, correct_answer,
      evidence_key, evidence_status, evidence_method, evidence_confirmed_at
    ) VALUES (
      ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?, ?, ?,
      ?, ?, ?, ?, ?,
      ?, ?,
      ?, ?, ?, ?
    )
  `).run(
    caseId, record.mistakeId, record.childId, record.source, record.occurredAt,
    record.sessionId ?? null, record.occurredAt, record.subject ?? null,
    record.problem, record.errorType ?? null, record.hint ?? null,
    record.level ?? null,
    record.imagePath ?? null, record.visionInput ?? null,
    record.visionReasoning ?? null, record.visionModel ?? null,
    record.visionTs ?? null,
    record.userAnswer ?? null, record.correctAnswer ?? null,
    record.evidenceKey ?? null, record.evidenceStatus ?? null,
    record.evidenceMethod ?? null, record.evidenceConfirmedAt ?? null,
  );
  db.prepare(`
    INSERT OR IGNORE INTO learning_attempts
      (attempt_id, case_id, attempt_kind, mistake_id, child_id, problem,
       user_answer, correct_answer, is_correct, occurred_at, source)
    VALUES (?, ?, 'original', ?, ?, ?, ?, ?, 0, ?, ?)
  `).run(
    `original:${caseId}`,
    caseId,
    record.mistakeId,
    record.childId,
    record.problem,
    record.userAnswer ?? null,
    record.correctAnswer ?? null,
    record.occurredAt,
    record.source,
  );
  db.prepare(`
    INSERT OR IGNORE INTO correction_obligations
      (case_id, status, opened_at, reviewed_count)
    VALUES (?, 'open', ?, ?)
  `).run(caseId, record.occurredAt, record.reviewedCount ?? 0);
}

function backfillMistakeCompatibility(db: Database.Database): void {
  db.transaction(() => {
    // v0.9 (SB124-T01 PR-B): use a stable "mistake:<id>" case_id for the
    // legacy compat mirror, but respect any pre-existing case row that
    // already has a UUID case_id (written by the new insertMistake).
    // INSERT OR IGNORE keeps the existing row; the subsequent joins
    // read the actual case_id back from mistake_cases so we don't
    // trip the learning_attempts.case_id FK on a missing parent.
    db.exec(`
      INSERT OR IGNORE INTO mistake_cases (
        case_id, original_mistake_id, child_id, source, opened_at,
        session_id, ts, subject, problem, error_type, hint, level,
        image_path, vision_input, vision_reasoning, vision_model, vision_ts,
        user_answer, correct_answer,
        evidence_key, evidence_status, evidence_method, evidence_confirmed_at
      )
      SELECT
        'mistake:' || id,
        id,
        child_id,
        COALESCE(NULLIF(source, ''), 'study-buddy'),
        ts,
        session_id,
        ts,
        subject,
        problem,
        error_type,
        hint,
        level,
        image_path,
        vision_input,
        vision_reasoning,
        vision_model,
        vision_ts,
        user_answer,
        correct_answer,
        evidence_key,
        evidence_status,
        evidence_method,
        evidence_confirmed_at
      FROM mistakes;

      INSERT OR IGNORE INTO learning_attempts (
        attempt_id, case_id, attempt_kind, mistake_id, child_id,
        problem, user_answer, correct_answer, is_correct, occurred_at, source
      )
      SELECT
        'original:' || mc.case_id,
        mc.case_id,
        'original',
        m.id,
        m.child_id,
        m.problem,
        m.user_answer,
        m.correct_answer,
        0,
        m.ts,
        COALESCE(NULLIF(m.source, ''), 'study-buddy')
      FROM mistakes m
      JOIN mistake_cases mc ON mc.original_mistake_id = m.id;

      INSERT OR IGNORE INTO correction_obligations
        (case_id, status, opened_at, reviewed_count)
      SELECT mc.case_id, 'open', m.ts, COALESCE(m.reviewed_count, 0)
      FROM mistakes m
      JOIN mistake_cases mc ON mc.original_mistake_id = m.id;
    `);
  })();
}

// Production DBs that were upgraded through PR #151 had compat rows
// already (INSERT OR IGNORE skipped them) with NULL evidence columns.
// Re-run backfill on those existing rows so the new columns get
// populated from mistakes. Idempotent: a row whose evidence is
// already populated is left untouched (the WHERE problem IS NULL
// guard skips the no-op rewrite).
function fillMissingCompatEvidence(db: Database.Database): void {
  db.exec(`
    UPDATE mistake_cases SET
      session_id = (SELECT session_id FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      ts = COALESCE(mistake_cases.ts, (SELECT ts FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id)),
      subject = (SELECT subject FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      problem = (SELECT problem FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      error_type = (SELECT error_type FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      hint = (SELECT hint FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      level = (SELECT level FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      image_path = (SELECT image_path FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      vision_input = (SELECT vision_input FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      vision_reasoning = (SELECT vision_reasoning FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      vision_model = (SELECT vision_model FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      vision_ts = (SELECT vision_ts FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      user_answer = (SELECT user_answer FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      correct_answer = (SELECT correct_answer FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      evidence_key = (SELECT evidence_key FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      evidence_status = (SELECT evidence_status FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      evidence_method = (SELECT evidence_method FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id),
      evidence_confirmed_at = (SELECT evidence_confirmed_at FROM mistakes WHERE mistakes.id = mistake_cases.original_mistake_id)
    WHERE problem IS NULL;

    UPDATE learning_attempts SET
      problem = (SELECT m.problem FROM mistake_cases mc JOIN mistakes m ON m.id = mc.original_mistake_id WHERE mc.case_id = learning_attempts.case_id),
      user_answer = (SELECT m.user_answer FROM mistake_cases mc JOIN mistakes m ON m.id = mc.original_mistake_id WHERE mc.case_id = learning_attempts.case_id),
      correct_answer = (SELECT m.correct_answer FROM mistake_cases mc JOIN mistakes m ON m.id = mc.original_mistake_id WHERE mc.case_id = learning_attempts.case_id)
    WHERE problem IS NULL;
  `);
}

function widenSourceEventVocabulary(db: Database.Database): void {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'source_events'",
  ).get() as { sql: string } | undefined;
  if (!row?.sql.includes("record_type = 'learning_attempt'")) return;

  db.transaction(() => {
    db.exec(`
      DROP TRIGGER IF EXISTS source_events_immutable_update;
      DROP TRIGGER IF EXISTS source_events_immutable_delete;
      ALTER TABLE source_events RENAME TO source_events_learning_attempt_only;
      ${SOURCE_EVENTS_TABLE_SQL};
      INSERT INTO source_events (
        seq, event_id, source_product, source_installation_id, subject_ref,
        record_type, record_id, revision, occurred_at, event_type,
        event_schema_version, payload_json, created_at
      )
      SELECT seq, event_id, source_product, source_installation_id, subject_ref,
        record_type, record_id, revision, occurred_at, event_type,
        event_schema_version, payload_json, created_at
      FROM source_events_learning_attempt_only;
      DROP TABLE source_events_learning_attempt_only;
    `);
  })();
}

// v0.8.x (#146/#148): backfill mistakes.level for any pre-existing
// rows. Idempotent: rows that already have a non-NULL level are
// left alone. Uses inferMistakeLevel (same heuristic the picker
// used pre-migration) so the backfill matches what the picker
// would have guessed from text.
function backfillMistakeLevel(db: Database.Database): void {
  const rows = db
    .prepare(
      "SELECT id, problem, error_type FROM mistakes WHERE level IS NULL",
    )
    .all() as Array<{ id: number; problem: string | null; error_type: string | null }>;
  if (rows.length === 0) return;
  const update = db.prepare("UPDATE mistakes SET level = ? WHERE id = ?");
  const tx = db.transaction((items: typeof rows) => {
    for (const r of items) {
      const level = inferMistakeLevel(r.problem, r.error_type);
      update.run(level, r.id);
    }
  });
  tx(rows);
}

// v0.8.x (PR #149): add a FK constraint on mistakes.child_id → children.id.
// SQLite can't ALTER TABLE ... ADD CONSTRAINT, so the migration uses
// the table-rebuild pattern. The rebuild drops the old table (taking
// its indexes with it) and renames the new one; the index recreation
// is delegated to ensureMistakeCompatibilityIndexes, which runs
// right after.
//
// Idempotency: detect if the FK is already present via
// `PRAGMA foreign_key_list(mistakes)` — if child_id has a FK, skip
// the rebuild entirely. This makes the function safe to call on
// fresh DBs (just-created, no FK yet), upgraded DBs (FK added),
// and re-runs (FK present, skipped).
//
// Robustness: the SELECT uses pragma_table_info to copy only
// columns that exist on the OLD table. This handles synthetic
// legacy test fixtures (and real production upgrades where the
// table was created with a subset of today's columns). Run inside
// a transaction so the temp table never escapes to sqlite_master.
function addMistakesChildIdForeignKey(db: Database.Database): void {
  const fks = db
    .prepare("PRAGMA foreign_key_list(mistakes)")
    .all() as Array<{ from: string; table: string; to: string }>;
  const childFk = fks.find((fk) => fk.from === "child_id");
  if (childFk) return; // already migrated

  // List the columns the OLD mistakes table has — only those get
  // copied to the new table. NULL is used for columns the old
  // table doesn't have (so they get the column DEFAULT).
  const oldCols = (
    db.prepare("PRAGMA table_info(mistakes)").all() as Array<{ name: string }>
  ).map((c) => c.name);

  db.transaction(() => {
    db.exec(`
      CREATE TABLE mistakes_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL DEFAULT (strftime('%s', 'now') * 1000),
        subject TEXT,
        problem TEXT,
        error_type TEXT,
        hint TEXT,
        reviewed_count INTEGER DEFAULT 0,
        image_path TEXT,
        vision_input TEXT,
        vision_reasoning TEXT,
        vision_model TEXT,
        vision_ts INTEGER,
        source TEXT DEFAULT 'study-buddy',
        user_answer TEXT,
        correct_answer TEXT,
        evidence_key TEXT,
        evidence_status TEXT,
        evidence_method TEXT,
        evidence_confirmed_at INTEGER,
        child_id TEXT NOT NULL DEFAULT 'default',
        level INTEGER,
        FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
        FOREIGN KEY (child_id) REFERENCES children(id) ON DELETE CASCADE
      )
    `);
    // Build INSERT...SELECT dynamically, projecting NULL for any
    // column the old table doesn't have. The COALESCE for child_id
    // ensures a non-null default ('default') even if the old row
    // somehow had it null (defense-in-depth — column is NOT NULL).
    const newCols = [
      "id", "session_id", "ts", "subject", "problem", "error_type",
      "hint", "reviewed_count", "image_path", "vision_input",
      "vision_reasoning", "vision_model", "vision_ts", "source",
      "user_answer", "correct_answer", "evidence_key", "evidence_status",
      "evidence_method", "evidence_confirmed_at", "child_id", "level",
    ];
    const selectExprs = newCols.map((c) => {
      if (c === "child_id") {
        return `COALESCE(${c}, 'default')`;
      }
      return oldCols.includes(c) ? c : `NULL AS ${c}`;
    });
    const insert = db.prepare(`
      INSERT INTO mistakes_new (${newCols.join(", ")})
      SELECT ${selectExprs.join(", ")}
      FROM mistakes
    `);
    insert.run();
    db.exec(`DROP TABLE mistakes; ALTER TABLE mistakes_new RENAME TO mistakes;`);
  })();
}

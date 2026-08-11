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

  // v0.8 (#34a-1, issue #98): deduplicate existing rows before building
  // the UNIQUE index below. Preserve independent source provenance: a game
  // attempt and a confirmed vision record may describe the same problem.
  // Keep the earliest row per (child_id, problem, source).
  // Wrapped in try/catch because the table may not exist yet on a fresh
  // DB (this DELETE runs before the CREATE TABLE block below).
  try {
    db.exec(`
      UPDATE mistakes SET source = 'study-buddy' WHERE source IS NULL OR source = '';
      DELETE FROM mistakes
      WHERE id NOT IN (
        SELECT MIN(id)
        FROM mistakes
        GROUP BY child_id, problem, source
      );
    `);
  } catch {
    /* fresh DB — mistakes table doesn't exist yet, nothing to dedupe */
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
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
    -- Dedupe repeated records within one source while preserving provenance
    -- when game and vision both contribute the same normalized problem.
    DROP INDEX IF EXISTS idx_mistakes_child_problem;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mistakes_child_problem_source
      ON mistakes(child_id, problem, source);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_mistakes_evidence_key
      ON mistakes(evidence_key) WHERE evidence_key IS NOT NULL;

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

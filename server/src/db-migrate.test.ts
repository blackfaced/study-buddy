import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";

// Bug 4: server/src/index.ts used `new Database(DB_PATH)` without running the
// schema migration, so when chat_turns.state (added by the mcp-server) didn't
// exist in the HTTP server's view, the /api/chat write would 500.
//
// Regression: `migrateSchema(db)` must ensure all v0.1 columns exist and be
// safe to call repeatedly (idempotent).

beforeEach(async () => {
  const { migrateSchema } = await import("./db-migrate.js");
  // stash the imported function on globalThis so individual tests can call it
  (globalThis as any).__migrateSchema = migrateSchema;
});

afterEach(() => {
  delete (globalThis as any).__migrateSchema;
});

function freshDb() {
  const db = new Database(":memory:");
  db.pragma("foreign_keys = ON");
  return db;
}

describe("migrateSchema", () => {
  it("creates the v0.1 tables on an empty database", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const names = tables.map((t) => t.name);
    expect(names).toContain("children");
    expect(names).toContain("sessions");
    expect(names).toContain("chat_turns");
    expect(names).toContain("posture_events");
    expect(names).toContain("mistakes");
    expect(names).toContain("mistake_photo_confirmations");
    expect(names).toContain("source_installation");
    expect(names).toContain("source_subjects");
    expect(names).toContain("source_events");
    expect(names).toContain("paired_devices");
    expect(names).toContain("pairing_codes");
    db.close();
  });

  it("installs immutable Source Event triggers at the schema boundary", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const triggerNames = db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'source_events' ORDER BY name")
      .all()
      .map((row: any) => row.name);
    expect(triggerNames).toEqual([
      "source_events_immutable_delete",
      "source_events_immutable_update",
    ]);
    db.close();
  });

  it("adds the `state` column to chat_turns (Bug 4 root cause)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(chat_turns)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("state");
    db.close();
  });

  it("adds the `writing_turns` column to sessions (denominator for offtopic rate)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("writing_turns");
    db.close();
  });

  it("adds device ownership to sessions for paired clients", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const columns = db.prepare("PRAGMA table_info(sessions)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toContain("device_id");
    const pairedDeviceColumns = db.prepare("PRAGMA table_info(paired_devices)").all() as Array<{ name: string }>;
    expect(pairedDeviceColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "device_id", "child_id", "credential_hash", "revoked_at", "last_seen_at",
    ]));
    db.close();
  });

  it("enforces device ownership references when upgrading a legacy sessions table", () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE children (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO children (id, name) VALUES ('default', '小宝');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0,
        ended_at INTEGER,
        subject TEXT,
        total_minutes INTEGER DEFAULT 0,
        avg_focus_score REAL DEFAULT 0,
        posture_warning_count INTEGER DEFAULT 0,
        offtopic_count INTEGER DEFAULT 0,
        offtopic_recovered INTEGER DEFAULT 0
      );
      INSERT INTO sessions (id, child_id) VALUES ('legacy', 'default');
    `);
    (globalThis as any).__migrateSchema(db);

    expect(() => db.prepare(
      "UPDATE sessions SET device_id = 'missing-device' WHERE id = 'legacy'",
    ).run()).toThrow();
    db.prepare(
      `INSERT INTO paired_devices
         (device_id, child_id, credential_hash, device_name, created_at, last_seen_at)
       VALUES ('device-1', 'default', 'digest', 'iPad', 1, 1)`,
    ).run();
    db.prepare("UPDATE sessions SET device_id = 'device-1' WHERE id = 'legacy'").run();
    expect(() => db.prepare(
      "UPDATE paired_devices SET device_id = 'renamed' WHERE device_id = 'device-1'",
    ).run()).toThrow();
    expect(() => db.prepare(
      "UPDATE paired_devices SET device_id = NULL WHERE device_id = 'device-1'",
    ).run()).toThrow();
    db.close();
  });

  it("adds the `source` column to mistakes (study-buddy / game / vision)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(mistakes)").all() as Array<{ name: string }>;
    const colNames = cols.map((c) => c.name);
    expect(colNames).toContain("source");
    db.close();
  });

  it("creates mistake-case compatibility tables and preserves duplicate legacy evidence", () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE children (id TEXT PRIMARY KEY, name TEXT NOT NULL);
      INSERT INTO children (id, name) VALUES
        ('default', '小宝'),
        ('other', '另一个孩子');
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY,
        child_id TEXT NOT NULL,
        started_at INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO sessions (id, child_id) VALUES ('legacy', 'default');
      INSERT INTO sessions (id, child_id) VALUES ('legacy-other', 'other');
      CREATE TABLE mistakes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        subject TEXT,
        problem TEXT,
        error_type TEXT,
        source TEXT,
        user_answer TEXT,
        correct_answer TEXT,
        child_id TEXT NOT NULL
      );
      INSERT INTO mistakes
        (session_id, ts, subject, problem, error_type, source, user_answer, correct_answer, child_id)
      VALUES
        ('legacy', 10, 'math', '1+1', 'compute', 'game', '3', '2', 'default'),
        ('legacy', 20, 'math', '1+1', 'compute', 'game', '4', '2', 'default'),
        ('legacy-other', 30, 'math', '1+1', 'compute', 'game', '5', '2', 'other');
    `);

    (globalThis as any).__migrateSchema(db);

    expect(db.prepare("SELECT COUNT(*) AS count FROM mistakes").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT child_id, COUNT(*) AS count FROM mistake_cases GROUP BY child_id ORDER BY child_id").all()).toEqual([
      { child_id: "default", count: 2 },
      { child_id: "other", count: 1 },
    ]);
    expect(db.prepare("SELECT COUNT(*) AS count FROM learning_attempts").get()).toEqual({ count: 3 });
    expect(db.prepare("SELECT COUNT(*) AS count FROM correction_obligations").get()).toEqual({ count: 3 });
    expect(db.prepare(
      "SELECT attempt_kind, user_answer, correct_answer FROM learning_attempts ORDER BY occurred_at",
    ).all()).toEqual([
      { attempt_kind: "original", user_answer: "3", correct_answer: "2" },
      { attempt_kind: "original", user_answer: "4", correct_answer: "2" },
      { attempt_kind: "original", user_answer: "5", correct_answer: "2" },
    ]);

    db.prepare(
      `INSERT INTO mistake_cases (case_id, original_mistake_id, child_id, source, opened_at)
       VALUES ('manual:1', 1000, 'default', 'manual', 40)`,
    ).run();
    db.prepare(
      `INSERT INTO learning_attempts
       (attempt_id, case_id, attempt_kind, child_id, problem, user_answer, correct_answer, is_correct, occurred_at, source)
       VALUES ('attempt:manual:1', 'manual:1', 'correction', 'default', '1+1', '2', '2', 1, 50, 'manual')`,
    ).run();
    db.prepare(
      `INSERT INTO correction_obligations (case_id, status, opened_at)
       VALUES ('manual:1', 'open', 40)`,
    ).run();
    expect(db.prepare("SELECT attempt_kind, is_correct FROM learning_attempts WHERE attempt_id = 'attempt:manual:1'").get()).toEqual({
      attempt_kind: "correction",
      is_correct: 1,
    });

    expect(() => (globalThis as any).__migrateSchema(db)).not.toThrow();
    expect(db.prepare("SELECT COUNT(*) AS count FROM learning_attempts").get()).toEqual({ count: 4 });
    db.close();
  });

  it("adds confirmed-only mistake photo evidence fields and idempotency receipts", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const columns = db.prepare("PRAGMA table_info(mistakes)").all() as Array<{ name: string }>;
    expect(columns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "evidence_key", "evidence_status", "evidence_method", "evidence_confirmed_at",
    ]));
    const receiptColumns = db.prepare("PRAGMA table_info(mistake_photo_confirmations)").all() as Array<{ name: string }>;
    expect(receiptColumns.map((column) => column.name)).toEqual(expect.arrayContaining([
      "draft_id", "mistake_id", "session_id", "child_id", "device_id",
      "confirmation_method", "confirmed_at",
    ]));
    const indexColumns = db.prepare("PRAGMA index_info(idx_mistakes_child_problem_source)").all() as Array<{ name: string }>;
    expect(indexColumns.map((column) => column.name)).toEqual(["child_id", "problem", "source"]);
    db.close();
  });

  it("is idempotent — running it twice does not throw", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    expect(() => (globalThis as any).__migrateSchema(db)).not.toThrow();
    db.close();
  });

  it("keeps one immutable installation identity across migrations", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const first = db
      .prepare("SELECT installation_id AS id FROM source_installation")
      .get() as { id: string };
    (globalThis as any).__migrateSchema(db);
    const second = db
      .prepare("SELECT installation_id AS id FROM source_installation")
      .get() as { id: string };
    expect(second.id).toBe(first.id);
    expect(first.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(() =>
      db.prepare("UPDATE source_installation SET installation_id = ?").run("replacement"),
    ).toThrow(/immutable/);
    expect(() => db.prepare("DELETE FROM source_installation").run()).toThrow(
      /immutable/,
    );
    db.close();
  });

  it("binds every source event to the persistent source installation", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const foreignKeys = db.prepare("PRAGMA foreign_key_list(source_events)").all() as Array<{
      from: string;
      table: string;
      to: string;
    }>;
    expect(foreignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "source_installation_id",
          table: "source_installation",
          to: "installation_id",
        }),
      ]),
    );
    db.close();
  });

  it("after migration, chat_turns accepts INSERT with the `state` column", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    // default child is already seeded by migrateSchema — use it
    db.prepare("INSERT INTO sessions (id, child_id) VALUES (?, ?)").run("s1", "default");
    expect(() => {
      db.prepare(
        "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("s1", "child", "hi", "learning", 0, "writing");
    }).not.toThrow();
    const row = db
      .prepare("SELECT state FROM chat_turns WHERE session_id = ?")
      .get("s1") as { state: string };
    expect(row.state).toBe("writing");
    db.close();
  });

  it("seeds the default child + settings row on first run", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const child = db.prepare("SELECT * FROM children WHERE id = 'default'").get() as any;
    expect(child).toBeDefined();
    expect(child.name).toBe("小宝");
    const settings = db.prepare("SELECT * FROM settings WHERE child_id = 'default'").get() as any;
    expect(settings).toBeDefined();
    db.close();
  });

  it("creates the game_sessions table for v0.6 time-mode runs", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(game_sessions)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "id", "child_id", "app_id", "duration_sec", "total_questions",
        "correct_count", "started_at", "ended_at", "created_at",
      ])
    );
    db.close();
  });

  // v0.7 (issue #57): writing_words + writing_attempts tables
  it("creates the writing_words table (v0.7 write app library)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(writing_words)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["char", "added_at", "added_by"]),
    );
    db.close();
  });

  it("writing_words.char is the PRIMARY KEY (duplicate INSERT OR IGNORE is a no-op)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    // Two-step: insert, then try again. The second should fail loudly
    // unless we wrap in INSERT OR IGNORE — confirm the PRIMARY KEY
    // constraint is actually in place.
    db.prepare("INSERT OR IGNORE INTO writing_words (char) VALUES (?)").run("一");
    db.prepare("INSERT OR IGNORE INTO writing_words (char) VALUES (?)").run("一");
    const count = (db.prepare("SELECT COUNT(*) as c FROM writing_words").get() as any).c;
    expect(count).toBe(1);
    db.close();
  });

  it("creates the writing_attempts table (v0.7 stroke history)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining(["id", "char", "level", "stroke_path", "ts"]),
    );
    db.close();
  });

  it("adds explainable handwriting assessment fields without replacing legacy attempt columns", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    const cols = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;
    const names = cols.map((c) => c.name);
    expect(names).toEqual(
      expect.arrayContaining([
        "level",
        "stroke_path",
        "score",
        "display_band",
        "status",
        "strokes_json",
        "assessment_json",
        "process_json",
        "algorithm_version",
        "model_review_json",
      ]),
    );
    db.close();
  });

  it("upgrades a legacy writing_attempts table in place", () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE writing_words (
        char TEXT PRIMARY KEY,
        added_at INTEGER NOT NULL,
        added_by TEXT
      );
      CREATE TABLE writing_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        char TEXT NOT NULL,
        level REAL NOT NULL,
        stroke_path TEXT,
        ts INTEGER NOT NULL
      );
    `);

    expect(() => (globalThis as any).__migrateSchema(db)).not.toThrow();
    const cols = db.prepare("PRAGMA table_info(writing_attempts)").all() as Array<{ name: string }>;
    expect(cols.map((column) => column.name)).toEqual(
      expect.arrayContaining([
        "score",
        "display_band",
        "status",
        "strokes_json",
        "assessment_json",
        "process_json",
        "algorithm_version",
        "model_review_json",
      ]),
    );
    db.close();
  });

  it("writing_attempts cascades on writing_words delete (FK)", () => {
    const db = freshDb();
    (globalThis as any).__migrateSchema(db);
    db.prepare("INSERT INTO writing_words (char) VALUES (?)").run("一");
    db.prepare("INSERT INTO writing_attempts (char, level, stroke_path) VALUES (?, ?, ?)").run("一", 1.0, "M 0 0 L 1 1");
    db.prepare("DELETE FROM writing_words WHERE char = ?").run("一");
    const count = (db.prepare("SELECT COUNT(*) as c FROM writing_attempts").get() as any).c;
    expect(count).toBe(0);
    db.close();
  });

  it("widens the #104 learning-attempt-only Source Event table without losing sequence", () => {
    const db = freshDb();
    db.exec(`
      CREATE TABLE source_installation (
        singleton_id INTEGER PRIMARY KEY,
        installation_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE source_subjects (
        child_id TEXT PRIMARY KEY,
        subject_ref TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE source_events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        source_product TEXT NOT NULL CHECK (source_product = 'study_buddy'),
        source_installation_id TEXT NOT NULL,
        subject_ref TEXT NOT NULL,
        record_type TEXT NOT NULL CHECK (record_type = 'learning_attempt'),
        record_id TEXT NOT NULL,
        revision INTEGER NOT NULL,
        occurred_at INTEGER NOT NULL,
        event_type TEXT NOT NULL CHECK (event_type = 'learning_attempt_recorded'),
        event_schema_version INTEGER NOT NULL,
        payload_json TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      INSERT INTO source_installation VALUES (1, 'installation-1', 1);
      INSERT INTO source_subjects VALUES ('default', 'subject-1', 1);
      INSERT INTO source_events VALUES (
        7, 'event-7', 'study_buddy', 'installation-1', 'subject-1',
        'learning_attempt', 'mistake:7', 1, 7,
        'learning_attempt_recorded', 1,
        '{"kind":"learning_attempt"}', 7
      );
    `);

    expect(() => (globalThis as any).__migrateSchema(db)).not.toThrow();
    expect(
      db.prepare("SELECT seq, record_id FROM source_events").get(),
    ).toEqual({ seq: 7, record_id: "mistake:7" });
    expect(() => db.prepare(
      `INSERT INTO source_events (
         event_id, source_product, source_installation_id, subject_ref,
         record_type, record_id, revision, occurred_at, event_type,
         event_schema_version, payload_json
       ) VALUES ('event-8', 'study_buddy', 'installation-1', 'subject-1',
         'learning_session', 'session:8', 1, 8,
         'source_record_withdrawn', 1, NULL)`,
    ).run()).not.toThrow();
    expect(
      db.prepare("SELECT seq FROM source_events WHERE event_id = 'event-8'").get(),
    ).toEqual({ seq: 8 });
    db.close();
  });
});

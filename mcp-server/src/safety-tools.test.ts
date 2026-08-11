import Database from "better-sqlite3";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, initDb } from "./db.js";
import { handleTool } from "./tools.js";

describe("parent-visible minimized safety signals", () => {
  let db: Database.Database;

  beforeAll(() => {
    initDb(":memory:");
    db = getDb();
  });

  beforeEach(() => {
    db.prepare("DELETE FROM safety_incidents").run();
    db.prepare("DELETE FROM sessions").run();
    db.prepare("DELETE FROM sqlite_sequence WHERE name = 'safety_incidents'").run();
    db.prepare(
      "INSERT INTO sessions (id, child_id, started_at, subject) VALUES ('safe-session', 'default', ?, '作业')",
    ).run(Date.now());
    db.prepare(
      `INSERT INTO safety_incidents
         (session_id, child_id, ts, category, urgency, status)
       VALUES ('safe-session', 'default', ?, 'bullying', 'attention', 'needs_attention')`,
    ).run(Date.now());
  });

  afterAll(() => db.close());

  it("adds only minimized safety information to today's report", async () => {
    const report = await handleTool("get_today_report", { childId: "default" }) as any;

    expect(report.safety).toMatchObject({
      needsAttention: 1,
      events: [{ id: 1, category: "bullying", urgency: "attention", status: "needs_attention" }],
    });
    expect(JSON.stringify(report.safety)).not.toMatch(/content|message|raw/i);
  });

  it("keeps an unresolved signal visible after its calendar day", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T10:00:00+08:00"));
    db.prepare("UPDATE safety_incidents SET ts = ? WHERE id = 1").run(
      new Date("2026-08-10T10:00:00+08:00").getTime(),
    );

    const report = await handleTool("get_today_report", { childId: "default" }) as any;

    expect(report.safety.needsAttention).toBe(1);
    expect(report.safety.events).toMatchObject([{ id: 1, status: "needs_attention" }]);
    vi.useRealTimers();
  });

  it("expires resolved metadata after 30 days but never expires pending signals", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T10:00:00+08:00"));
    const old = new Date("2026-07-01T10:00:00+08:00").getTime();
    db.prepare(
      `INSERT INTO safety_incidents
         (session_id, child_id, ts, category, urgency, status, resolution, resolved_at)
       VALUES ('safe-session', 'default', ?, 'abuse', 'attention', 'resolved', 'acknowledged', ?)`,
    ).run(old, old);
    db.prepare("UPDATE safety_incidents SET ts = ? WHERE id = 1").run(old);

    const report = await handleTool("get_today_report", { childId: "default" }) as any;

    expect(report.safety.needsAttention).toBe(1);
    expect(db.prepare("SELECT id FROM safety_incidents ORDER BY id").all()).toEqual([{ id: 1 }]);
    vi.useRealTimers();
  });

  it.each(["acknowledged", "false_positive"])("lets a guardian resolve as %s without changing policy", async (resolution) => {
    db.prepare("UPDATE safety_incidents SET status = 'needs_attention', resolution = NULL, resolved_at = NULL WHERE id = 1").run();
    vi.setSystemTime(new Date("2026-08-12T10:00:00+08:00"));

    const result = await handleTool("resolve_safety_event", { incidentId: 1, resolution });

    expect(result).toEqual({ id: 1, status: "resolved", resolution });
    expect(db.prepare("SELECT status, resolution, resolved_at FROM safety_incidents WHERE id = 1").get()).toEqual({
      status: "resolved",
      resolution,
      resolved_at: Date.now(),
    });
    vi.useRealTimers();
  });
});

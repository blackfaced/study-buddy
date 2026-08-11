import Database from "better-sqlite3";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { getDb, initDb } from "./db.js";
import { handleTool } from "./tools.js";

let db: Database.Database;
let originalTimezone: string | undefined;

beforeAll(() => {
  originalTimezone = process.env.TZ;
  process.env.TZ = "Asia/Shanghai";
  initDb(":memory:");
  db = getDb();
});

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(() => {
  db.close();
  if (originalTimezone === undefined) {
    delete process.env.TZ;
  } else {
    process.env.TZ = originalTimezone;
  }
});

describe("get_today_report", () => {
  it("labels a 00:30 report with the current local calendar date", async () => {
    vi.setSystemTime(new Date("2026-08-08T00:30:00+08:00"));

    const report = await handleTool("get_today_report", {}) as { date: string };

    expect(report.date).toBe("2026-08-08");
  });

  it("labels a 23:30 report with the current local calendar date", async () => {
    vi.setSystemTime(new Date("2026-08-08T23:30:00+08:00"));

    const report = await handleTool("get_today_report", {}) as { date: string };

    expect(report.date).toBe("2026-08-08");
  });
});

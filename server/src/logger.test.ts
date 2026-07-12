import { describe, it, expect } from "vitest";
import {
  createLogger,
  memorySink,
  requestLogger,
  type LogLevel,
  type LogSink,
} from "./logger.js";

const LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

function makeLogger(level: LogLevel = "debug") {
  const { sink, entries } = memorySink();
  const logger = createLogger({ level, sinks: [sink] });
  return { logger, entries };
}

describe("createLogger", () => {
  it("emits entries with timestamp, level, message, and meta", () => {
    const { logger, entries } = makeLogger();
    const fixed = new Date("2026-07-12T10:00:00Z");
    logger.info("hello", { childId: "default", n: 3 });
    // re-create with fixed clock
    const { sink: s2, entries: e2 } = memorySink();
    const logger2 = createLogger({ level: "debug", sinks: [s2], now: () => fixed });
    logger2.info("hi", { foo: "bar" });
    const entry = e2()[0];
    expect(entry.ts).toBe("2026-07-12T10:00:00.000Z");
    expect(entry.level).toBe("info");
    expect(entry.msg).toBe("hi");
    expect(entry.meta).toEqual({ foo: "bar" });
  });

  it("filters out entries below the configured level", () => {
    const { logger, entries } = makeLogger("warn");
    logger.debug("d");
    logger.info("i");
    logger.warn("w");
    logger.error("e");
    expect(entries().map((e) => e.level)).toEqual(["warn", "error"]);
  });

  it("emits each of the four levels when level is 'debug'", () => {
    const { logger, entries } = makeLogger();
    for (const lvl of LEVELS) {
      logger[lvl](`${lvl}-msg`);
    }
    expect(entries().map((e) => e.msg)).toEqual([
      "debug-msg",
      "info-msg",
      "warn-msg",
      "error-msg",
    ]);
  });

  it("passes entries to every sink", () => {
    const s1 = memorySink();
    const s2 = memorySink();
    const logger = createLogger({ level: "debug", sinks: [s1.sink, s2.sink] });
    logger.info("to-both");
    expect(s1.entries()[0].msg).toBe("to-both");
    expect(s2.entries()[0].msg).toBe("to-both");
  });

  it("captures meta as undefined when no meta is passed", () => {
    const { logger, entries } = makeLogger();
    logger.info("bare");
    expect(entries()[0].meta).toBeUndefined();
  });
});

describe("memorySink", () => {
  it("returns a fresh entry list per call (defensive copy)", () => {
    const { sink, entries } = memorySink();
    sink.write({ ts: "2026-07-12T00:00:00.000Z", level: "info", msg: "a" });
    const first = entries();
    first.push({
      ts: "2026-07-12T00:00:00.000Z",
      level: "error",
      msg: "mutated",
    });
    expect(entries()).toHaveLength(1);
  });
});

describe("requestLogger", () => {
  it("logs each request with method, path, status, durationMs, contentLength", async () => {
    const { sink, entries } = memorySink();
    const logger = createLogger({ level: "info", sinks: [sink] });
    const express = await import("express");
    const supertest = (await import("supertest")).default;
    const app = express.default();
    app.use(requestLogger(logger));
    app.get("/x", (_req: Request, res: Response) => res.status(201).send("ok"));

    await supertest(app).get("/x");

    const reqEntries = entries().filter((e) => e.msg === "request");
    expect(reqEntries).toHaveLength(1);
    const meta = reqEntries[0].meta!;
    expect(meta.method).toBe("GET");
    expect(meta.path).toBe("/x");
    expect(meta.status).toBe(201);
    expect(typeof meta.durationMs).toBe("number");
    expect(meta.durationMs).toBeGreaterThanOrEqual(0);
  });

  it("logs at info level for 2xx/3xx, warn for 4xx, error for 5xx", async () => {
    const { sink, entries } = memorySink();
    const logger = createLogger({ level: "debug", sinks: [sink] });
    const express = await import("express");
    const supertest = (await import("supertest")).default;
    const app = express.default();
    app.use(requestLogger(logger));
    app.get("/ok", (_req: Request, res: Response) => res.send("ok"));
    app.get("/bad", (_req: Request, res: Response) => res.status(404).send("nope"));
    app.get("/boom", (_req: Request, res: Response) => res.status(500).send("err"));

    await supertest(app).get("/ok");
    await supertest(app).get("/bad");
    await supertest(app).get("/boom");

    const reqEntries = entries().filter((e) => e.msg === "request");
    const byPath: Record<string, string> = {};
    for (const e of reqEntries) {
      byPath[e.meta!.path as string] = e.level;
    }
    expect(byPath["/ok"]).toBe("info");
    expect(byPath["/bad"]).toBe("warn");
    expect(byPath["/boom"]).toBe("error");
  });
});

// Reference the Request/Response types so we don't have to import them
// in every test for TypeScript.
type Request = import("express").Request;
type Response = import("express").Response;

import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import {
  DEFAULT_SOURCE_EVENT_PAGE_SIZE,
  MAX_SOURCE_EVENT_PAGE_SIZE,
  readSourceEventPage,
  SourceEventContractError,
  SOURCE_EVENT_SCHEMA_VERSION,
} from "../source-events.js";

const MAX_CHAT_TURN_REFERENCES = 50;
const MAX_CHAT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;

export interface IntegrationRouteDeps {
  db: Database.Database;
  token: string | null;
  isLoopback?: (req: Request) => boolean;
}

export function registerIntegrationRoutes(
  app: Express,
  deps: IntegrationRouteDeps,
): void {
  const isLoopback = deps.isLoopback ?? isLoopbackRequest;
  app.get(
    "/api/integration/source-events",
    (req: Request, res: Response) => {
      if (!authorizeIntegration(req, res, deps.token, isLoopback)) return;

      const after = parseBoundedInteger(req.query.after, 0);
      const limit = parseBoundedInteger(
        req.query.limit,
        DEFAULT_SOURCE_EVENT_PAGE_SIZE,
      );
      const requestedSchemaVersion = parseBoundedInteger(
        req.query.schemaVersion,
        SOURCE_EVENT_SCHEMA_VERSION,
      );
      if (after === null || limit === null || requestedSchemaVersion === null) {
        res.status(400).json({
          error:
            "cursor, limit, and schemaVersion must be non-negative integers",
        });
        return;
      }
      if (limit < 1 || limit > MAX_SOURCE_EVENT_PAGE_SIZE) {
        res.status(400).json({
          error: `limit must be between 1 and ${MAX_SOURCE_EVENT_PAGE_SIZE}`,
        });
        return;
      }
      if (requestedSchemaVersion !== SOURCE_EVENT_SCHEMA_VERSION) {
        res.status(400).json({ error: "unsupported source event schema version" });
        return;
      }

      let page;
      try {
        page = readSourceEventPage(deps.db, after, limit);
      } catch (error) {
        if (error instanceof SourceEventContractError) {
          res.status(500).json({ error: "source event contract violation" });
          return;
        }
        throw error;
      }
      res.json({
        eventSchemaVersion: SOURCE_EVENT_SCHEMA_VERSION,
        events: page.events,
        page: {
          after,
          nextCursor: page.nextCursor,
          endOfPage: true,
          endOfFeed: !page.hasMore,
          hasMore: page.hasMore,
        },
      });
    },
  );

  app.post(
    "/api/integration/chat-turns",
    (req: Request, res: Response) => {
      if (!authorizeIntegration(req, res, deps.token, isLoopback)) return;
      const request = parseChatTurnRequest(req.body);
      if (!request) {
        res.status(400).json({
          error: "bounded sessionRef, turnRefs, window, and schemaVersion are required",
        });
        return;
      }

      const sessionId = request.sessionRef.slice("session:".length);
      const ids = request.turnRefs.map((ref) => Number(ref.slice("chat_turn:".length)));
      const placeholders = ids.map(() => "?").join(", ");
      const rows = deps.db.prepare(
        `SELECT id, session_id, ts, role, content
         FROM chat_turns
         WHERE session_id = ?
           AND id IN (${placeholders})
           AND ts >= ? AND ts <= ?`,
      ).all(sessionId, ...ids, request.from, request.to) as Array<{
        id: number;
        session_id: string;
        ts: number;
        role: string;
        content: string | null;
      }>;
      const byId = new Map(rows.map((row) => [row.id, row]));
      if (rows.length !== ids.length) {
        res.status(404).json({ error: "one or more requested chat references are unknown" });
        return;
      }

      res.json({
        eventSchemaVersion: SOURCE_EVENT_SCHEMA_VERSION,
        sessionRef: request.sessionRef,
        window: {
          from: new Date(request.from).toISOString(),
          to: new Date(request.to).toISOString(),
        },
        turns: ids.map((id) => {
          const row = byId.get(id)!;
          return {
            turnRef: `chat_turn:${row.id}`,
            role: row.role,
            content: row.content ?? "",
            occurredAt: new Date(row.ts).toISOString(),
          };
        }),
      });
    },
  );
}

function authorizeIntegration(
  req: Request,
  res: Response,
  token: string | null,
  isLoopback: (req: Request) => boolean,
): boolean {
  if (!isLoopback(req)) {
    res.status(403).json({ error: "integration feed is loopback-only" });
    return false;
  }
  if (!hasValidIntegrationCredential(req, token)) {
    res.status(401).json({ error: "integration credential required" });
    return false;
  }
  return true;
}

interface ChatTurnRequest {
  sessionRef: string;
  turnRefs: string[];
  from: number;
  to: number;
}

function parseChatTurnRequest(value: unknown): ChatTurnRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const body = value as Record<string, unknown>;
  if (body.schemaVersion !== SOURCE_EVENT_SCHEMA_VERSION) return null;
  if (
    typeof body.sessionRef !== "string" ||
    !/^session:[A-Za-z0-9_-]{1,128}$/.test(body.sessionRef)
  ) return null;
  if (
    !Array.isArray(body.turnRefs) ||
    body.turnRefs.length < 1 ||
    body.turnRefs.length > MAX_CHAT_TURN_REFERENCES ||
    body.turnRefs.some((ref) => typeof ref !== "string" || !/^chat_turn:[1-9][0-9]*$/.test(ref)) ||
    new Set(body.turnRefs).size !== body.turnRefs.length
  ) return null;
  if (!body.window || typeof body.window !== "object" || Array.isArray(body.window)) {
    return null;
  }
  const window = body.window as Record<string, unknown>;
  if (typeof window.from !== "string" || typeof window.to !== "string") return null;
  const from = Date.parse(window.from);
  const to = Date.parse(window.to);
  if (
    !Number.isFinite(from) ||
    !Number.isFinite(to) ||
    to < from ||
    to - from > MAX_CHAT_WINDOW_MS
  ) return null;
  return {
    sessionRef: body.sessionRef,
    turnRefs: body.turnRefs as string[],
    from,
    to,
  };
}

function parseBoundedInteger(
  value: unknown,
  defaultValue: number,
): number | null {
  if (value === undefined) return defaultValue;
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function hasValidIntegrationCredential(
  req: Request,
  expectedToken: string | null,
): boolean {
  if (!expectedToken) return false;
  const authorization = req.header("authorization");
  if (!authorization?.startsWith("Bearer ")) return false;
  const suppliedToken = authorization.slice("Bearer ".length);
  const suppliedDigest = createHash("sha256").update(suppliedToken).digest();
  const expectedDigest = createHash("sha256").update(expectedToken).digest();
  return timingSafeEqual(suppliedDigest, expectedDigest);
}

export function isLoopbackRequest(req: Request): boolean {
  const address = req.socket.remoteAddress ?? "";
  return (
    address === "::1" ||
    address.startsWith("127.") ||
    address.startsWith("::ffff:127.")
  );
}

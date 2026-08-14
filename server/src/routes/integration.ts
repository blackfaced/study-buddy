import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import {
  DEFAULT_SOURCE_EVENT_PAGE_SIZE,
  isValidSourceEventCursor,
  MAX_SOURCE_EVENT_PAGE_SIZE,
  chatTurnRecordId,
  parseChatSessionRef,
  parseChatTurnRecordId,
  readSourceEventPage,
  SourceEventContractError,
  SOURCE_EVENT_SCHEMA_VERSION,
} from "../source-events.js";

const MAX_CHAT_TURN_REFERENCES = 50;
const MAX_CHAT_WINDOW_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_CHAT_RESPONSE_CHARS = 128_000;

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
      if (!isValidSourceEventCursor(deps.db, after)) {
        res.status(400).json({ error: "cursor was not issued by this feed" });
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

      const sessionId = parseChatSessionRef(request.sessionRef)!;
      const ids = request.turnRefs.map((ref) => parseChatTurnRecordId(ref)!);
      const placeholders = ids.map(() => "?").join(", ");
      const rows = deps.db.prepare(
        `SELECT ct.id, ct.session_id, ct.ts, ct.role, ct.content
         FROM chat_turns AS ct
         INNER JOIN source_events AS se
           ON se.record_type = 'chat_turn'
          AND se.record_id = 'chat_turn:' || ct.id
          AND se.revision = 1
          AND se.event_type = 'chat_turn_recorded'
         WHERE ct.session_id = ?
           AND ct.id IN (${placeholders})
           AND ct.ts >= ? AND ct.ts <= ?`,
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
      const responseChars = rows.reduce(
        (total, row) => total + (row.content?.length ?? 0),
        0,
      );
      if (responseChars > MAX_CHAT_RESPONSE_CHARS) {
        res.status(413).json({ error: "requested chat content exceeds response limit" });
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
            turnRef: chatTurnRecordId(row.id),
            role: row.role,
            content: row.content ?? "",
            occurredAt: new Date(row.ts).toISOString(),
          };
        }),
      });
    },
  );
}

export function authorizeIntegration(
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
    parseChatSessionRef(body.sessionRef) === null
  ) return null;
  if (
    !Array.isArray(body.turnRefs) ||
    body.turnRefs.length < 1 ||
    body.turnRefs.length > MAX_CHAT_TURN_REFERENCES ||
    body.turnRefs.some((ref) =>
      typeof ref !== "string" || parseChatTurnRecordId(ref) === null
    ) ||
    new Set(body.turnRefs).size !== body.turnRefs.length
  ) return null;
  if (!body.window || typeof body.window !== "object" || Array.isArray(body.window)) {
    return null;
  }
  const window = body.window as Record<string, unknown>;
  if (typeof window.from !== "string" || typeof window.to !== "string") return null;
  const from = parseIsoTimestamp(window.from);
  const to = parseIsoTimestamp(window.to);
  if (
    from === null ||
    to === null ||
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

function parseIsoTimestamp(value: string): number | null {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value
    ? parsed
    : null;
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

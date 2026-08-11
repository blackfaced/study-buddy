import { createHash, timingSafeEqual } from "node:crypto";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import {
  DEFAULT_SOURCE_EVENT_PAGE_SIZE,
  MAX_SOURCE_EVENT_PAGE_SIZE,
  readSourceEventPage,
  SOURCE_EVENT_SCHEMA_VERSION,
} from "../source-events.js";

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
      if (!isLoopback(req)) {
        res.status(403).json({ error: "integration feed is loopback-only" });
        return;
      }
      if (!hasValidIntegrationCredential(req, deps.token)) {
        res.status(401).json({ error: "integration credential required" });
        return;
      }

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

      const page = readSourceEventPage(deps.db, after, limit);
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

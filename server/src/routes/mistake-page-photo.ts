// src/routes/mistake-page-photo.ts
//
// SB124-T04 #128: 整页照片批量确认进入错题收件箱 (T04-A endpoint slice).
// POST /api/mistake-photo/page — upload a homework page photo, run the
//   layout analysis pass, return the persisted draft + identified regions.
// GET  /api/mistake-photo/page/:id — fetch the persisted draft.
//
// Per-region OCR (T04-B), confirm/discard (T04-C), and the client UI
// (T04-D) arrive in follow-up PRs. The workflow already persists the
// raw image bytes so the per-region OCR doesn't have to re-upload.

import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import sharp from "sharp";
import type { Logger } from "../logger.js";
import type { VisionClient } from "../vision.js";
import { devicePrincipal, type DeviceRequestAuthenticator } from "../device-auth.js";
import {
  findOwnedActiveSession,
  requireOwnedActiveSession,
  respondOwnedSessionFailure,
} from "./session.js";
import {
  MISTAKE_PAGE_PHOTO_MAX_BYTES,
  MISTAKE_PAGE_PHOTO_TYPES,
  type MistakePagePhotoWorkflow,
  pageAnalyzeAdapter,
} from "../mistake-page-photo-workflow.js";
import { loadPageDraft, runRegionOcr } from "../region-ocr-workflow.js";
import {
  confirmCandidate,
  discardCandidate,
  CandidateConflictError,
  CandidateNotFoundError,
} from "../candidate-workflow.js";

export interface MistakePagePhotoRouteDeps {
  db: Database.Database;
  logger: Logger;
  visionClient: VisionClient | null;
  upload: any;
  auth: DeviceRequestAuthenticator;
  workflow: MistakePagePhotoWorkflow;
}

const PAGE_DRAFT_ID_PATTERN = /^[A-Za-z0-9_-]{8,80}$/;

function validPageDraftId(value: unknown): value is string {
  return typeof value === "string" && PAGE_DRAFT_ID_PATTERN.test(value);
}

function expectedSharpFormat(mime: string): "jpeg" | "png" | "webp" {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpeg";
}

function extensionFor(mime: string): "jpg" | "png" | "webp" {
  if (mime === "image/png") return "png";
  if (mime === "image/webp") return "webp";
  return "jpg";
}

export function registerMistakePagePhotoRoutes(
  app: Express,
  deps: MistakePagePhotoRouteDeps,
): void {
  const { db, logger, visionClient, upload, auth, workflow } = deps;

  app.post(
    "/api/mistake-photo/page",
    auth.requireDevice,
    safePhotoUpload(upload),
    async (req: Request, res: Response) => {
      const session = requireOwnedActiveSession(req, res, db);
      if (!session) return;
      if (!req.file) return res.status(400).json({ error: "photo is required" });
      if (!MISTAKE_PAGE_PHOTO_TYPES.has(req.file.mimetype)) {
        return res.status(415).json({ error: "page photo type must be JPEG, PNG, or WebP" });
      }
      if (req.file.size > MISTAKE_PAGE_PHOTO_MAX_BYTES) {
        return res.status(413).json({ error: `page photo exceeds ${MISTAKE_PAGE_PHOTO_MAX_BYTES / 1024} KB` });
      }
      try {
        const metadata = await sharp(req.file.buffer, { failOn: "error" }).metadata();
        if (metadata.format !== expectedSharpFormat(req.file.mimetype)) {
          return res.status(415).json({ error: "page photo contents do not match its type" });
        }
      } catch {
        return res.status(415).json({ error: "page photo is not a valid image" });
      }
      const draftId = req.body?.draftId;
      if (!validPageDraftId(draftId)) {
        return res.status(400).json({ error: "valid draftId is required (8-80 chars, [A-Za-z0-9_-])" });
      }
      if (!visionClient) return res.status(503).json({ error: "vision not configured" });

      const principal = devicePrincipal(res);
      try {
        const draft = await workflow.createPageDraft({
          id: draftId,
          childId: session.child_id,
          sessionId: session.id,
          deviceId: principal.deviceId,
          bytes: req.file.buffer,
          extension: extensionFor(req.file.mimetype),
          analyze: pageAnalyzeAdapter(visionClient),
        });
        const current = findOwnedActiveSession(db, session.id, principal);
        if (current.status !== "ok") {
          // The user's session ended mid-analysis (parent logged out,
          // device reset, etc.). The draft is persisted but the
          // session is no longer valid — mark cancelled so a stale
          // draft doesn't sit around for the full TTL.
          workflow.markCancelled(draft.id);
          return respondOwnedSessionFailure(res, current.status);
        }
        return res.status(201).json(publicDraft(draft));
      } catch (error: any) {
        if (error?.name === "PageDraftOwnershipError") {
          return res.status(403).json({ error: "page draft does not belong to this session" });
        }
        logger.error("mistake page photo analysis failed", {
          errorType: error?.name ?? "Error",
          timedOut: error?.name === "AbortError",
        });
        const code = error?.name === "AbortError" ? 504 : 502;
        return res.status(code).json({ error: "page layout vision failed" });
      }
    },
  );

  app.get(
    "/api/mistake-photo/page/:draftId",
    auth.requireDevice,
    async (req: Request, res: Response) => {
      const session = requireOwnedActiveSession(req, res, db);
      if (!session) return;
      const draftId = req.params.draftId;
      if (!validPageDraftId(draftId)) {
        return res.status(400).json({ error: "invalid draftId" });
      }
      const draft = await workflow.getPageDraft(draftId, { childId: session.child_id });
      if (!draft) return res.status(404).json({ error: "page draft not found or expired" });
      // Even if it survived the childId filter, verify the session +
      // device match the original owner. (Defensive — childId
      // isolation is the primary guarantee.)
      if (draft.sessionId !== session.id) {
        return res.status(403).json({ error: "page draft does not belong to this session" });
      }
      const principal = devicePrincipal(res);
      if (draft.deviceId !== principal.deviceId) {
        return res.status(403).json({ error: "page draft does not belong to this device" });
      }
      return res.json(publicDraft(draft));
    },
  );

  // ============== T04-B PR-B: per-region OCR trigger ==============
  // POST /api/mistake-photo/page/:draftId/regions
  // Body: none. Reads the draft's persisted image bytes + layout
  // regions, runs analyzeMistakeImage on each crop, writes one row
  // per region to mistake_photo_candidates. Returns the candidate
  // list (regionIndex + problem + confidence) so the review UI
  // (T04-D) can render it.
  //
  // Auth: same as the layout endpoint above — requireDevice +
  // requireOwnedActiveSession, plus childId/sessionId/deviceId
  // checks on the draft.
  app.post(
    "/api/mistake-photo/page/:draftId/regions",
    auth.requireDevice,
    async (req: Request, res: Response) => {
      const session = requireOwnedActiveSession(req, res, db);
      if (!session) return;
      const draftId = req.params.draftId;
      if (!validPageDraftId(draftId)) {
        return res.status(400).json({ error: "invalid draftId" });
      }
      if (!visionClient) return res.status(503).json({ error: "vision not configured" });

      const draft = loadPageDraft(db, draftId);
      if (!draft) return res.status(404).json({ error: "page draft not found" });
      if (draft.childId !== session.child_id) {
        return res.status(404).json({ error: "page draft not found" });
      }
      if (draft.sessionId !== session.id) {
        return res.status(403).json({ error: "page draft does not belong to this session" });
      }
      const principal = devicePrincipal(res);
      if (draft.deviceId !== principal.deviceId) {
        return res.status(403).json({ error: "page draft does not belong to this device" });
      }

      try {
        const candidates = await runRegionOcr(draft, { db, visionClient });
        return res.json({
          draftId,
          candidates: candidates.map((c) => ({
            regionIndex: c.regionIndex,
            subject: c.subject,
            problem: c.problem,
            confidence: c.confidence,
            visionModel: c.visionModel,
            errorMessage: c.errorMessage,
          })),
        });
      } catch (err) {
        logger.error("per-region OCR failed unexpectedly", {
          errorType: err instanceof Error ? err.name : "Error",
        });
        return res.status(502).json({ error: "per-region OCR failed" });
      }
    },
  );

  // ============== T04-C PR-C: confirm / discard candidates ==============
  // POST /api/mistake-photo/candidate/:candidateId/confirm
  //   body: { sessionId, userAnswer, correctAnswer, errorType? }
  //   200: { caseId, mistakeId, idempotent }
  //   404: candidate not found / cross-child
  //   409: candidate was discarded (re-confirm blocked)
  //   400: empty problem (cannot promote an empty OCR result)
  app.post(
    "/api/mistake-photo/candidate/:candidateId/confirm",
    auth.requireDevice,
    async (req: Request, res: Response) => {
      const session = requireOwnedActiveSession(req, res, db);
      if (!session) return;
      const rawId = req.params.candidateId;
      const candidateId = Number(rawId);
      if (!Number.isInteger(candidateId) || candidateId <= 0) {
        return res.status(400).json({ error: "invalid candidateId" });
      }
      const { userAnswer, correctAnswer, errorType } = (req.body ?? {}) as {
        userAnswer?: unknown;
        correctAnswer?: unknown;
        errorType?: unknown;
      };
      if (typeof userAnswer !== "string" || userAnswer.length === 0) {
        return res.status(400).json({ error: "userAnswer is required" });
      }
      if (typeof correctAnswer !== "string" || correctAnswer.length === 0) {
        return res.status(400).json({ error: "correctAnswer is required" });
      }
      if (errorType !== undefined && errorType !== null && typeof errorType !== "string") {
        return res.status(400).json({ error: "errorType must be a string" });
      }

      const candidateRow = db
        .prepare(
          `SELECT child_id FROM mistake_photo_candidates WHERE id = ?`,
        )
        .get(candidateId) as { child_id: string } | undefined;
      if (!candidateRow || candidateRow.child_id !== session.child_id) {
        // Don't leak existence — 404 covers both "doesn't exist" and
        // "belongs to another child".
        return res.status(404).json({ error: "candidate not found" });
      }

      try {
        const result = confirmCandidate(db, candidateId, {
          userAnswer,
          correctAnswer,
          errorType: typeof errorType === "string" ? errorType : null,
        });
        return res.json({
          candidateId,
          caseId: result.caseId,
          mistakeId: result.mistakeId,
          idempotent: result.idempotent,
        });
      } catch (err) {
        if (err instanceof CandidateNotFoundError) {
          return res.status(404).json({ error: "candidate not found" });
        }
        if (err instanceof CandidateConflictError) {
          // empty-problem or status='discarded' both surface as 409
          // so the client knows it's a state issue, not a not-found.
          return res.status(409).json({
            error:
              err.message.includes("empty-problem")
                ? "candidate has no problem text"
                : `candidate is in status '${err.currentStatus}'`,
          });
        }
        logger.error("candidate confirm failed", {
          candidateId,
          errorType: err instanceof Error ? err.name : "Error",
        });
        return res.status(500).json({ error: "confirm failed" });
      }
    },
  );

  // POST /api/mistake-photo/candidate/:candidateId/discard
  //   body: { sessionId }
  //   200: { discarded: true, idempotent: boolean }
  //   404: candidate not found / cross-child
  //   409: candidate was already confirmed (use mark-correct, not discard)
  app.post(
    "/api/mistake-photo/candidate/:candidateId/discard",
    auth.requireDevice,
    async (req: Request, res: Response) => {
      const session = requireOwnedActiveSession(req, res, db);
      if (!session) return;
      const rawId = req.params.candidateId;
      const candidateId = Number(rawId);
      if (!Number.isInteger(candidateId) || candidateId <= 0) {
        return res.status(400).json({ error: "invalid candidateId" });
      }

      const candidateRow = db
        .prepare(
          `SELECT child_id FROM mistake_photo_candidates WHERE id = ?`,
        )
        .get(candidateId) as { child_id: string } | undefined;
      if (!candidateRow || candidateRow.child_id !== session.child_id) {
        return res.status(404).json({ error: "candidate not found" });
      }

      try {
        const result = discardCandidate(db, candidateId);
        return res.json({ candidateId, ...result });
      } catch (err) {
        if (err instanceof CandidateNotFoundError) {
          return res.status(404).json({ error: "candidate not found" });
        }
        if (err instanceof CandidateConflictError) {
          return res.status(409).json({
            error: `candidate is in status '${err.currentStatus}'`,
          });
        }
        logger.error("candidate discard failed", {
          candidateId,
          errorType: err instanceof Error ? err.name : "Error",
        });
        return res.status(500).json({ error: "discard failed" });
      }
    },
  );
}

function safePhotoUpload(upload: any) {
  // Multer throws if no file is attached under the configured field
  // name. The single-photo route uses field "photo" — match that for
  // consistency.
  return upload.single("photo");
}

function publicDraft(draft: {
  id: string;
  childId: string;
  state: string;
  regions: unknown[];
  layoutModel: string;
  layoutConfidence: "ok" | "low";
  imageExtension: string;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
}) {
  return {
    id: draft.id,
    childId: draft.childId,
    state: draft.state,
    regions: draft.regions,
    layoutModel: draft.layoutModel,
    layoutConfidence: draft.layoutConfidence,
    imageExtension: draft.imageExtension,
    createdAt: draft.createdAt,
    expiresAt: draft.expiresAt,
    completedAt: draft.completedAt,
  };
}

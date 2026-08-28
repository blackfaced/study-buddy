import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import sharp from "sharp";
import type { Logger } from "../logger.js";
import type { VisionClient } from "../vision.js";
import { analyzeMistakeImage } from "../vision.js";
import { devicePrincipal, type DeviceRequestAuthenticator } from "../device-auth.js";
import {
  findOwnedActiveSession,
  requireOwnedActiveSession,
  respondOwnedSessionFailure,
  type OwnedSessionFailure,
} from "./session.js";
import { insertMistake } from "./mistake-api.js";
import {
  MISTAKE_PHOTO_MAX_BYTES,
  MISTAKE_PHOTO_TYPES,
  MistakePhotoWorkflow,
  normalizeProblemText,
  validDraftId,
} from "../mistake-photo-workflow.js";

export interface MistakePhotoRouteDeps {
  db: Database.Database;
  logger: Logger;
  visionClient: VisionClient | null;
  upload: any;
  auth: DeviceRequestAuthenticator;
  workflow: MistakePhotoWorkflow;
  beforeSourceEventAppend?: (recordType: "learning_attempt") => void;
}

export function registerMistakePhotoRoutes(app: Express, deps: MistakePhotoRouteDeps): void {
  const { db, logger, visionClient, upload, auth, workflow } = deps;

  app.post(
    "/api/mistake-photo",
    auth.requireDevice,
    safePhotoUpload(upload),
    async (req: Request, res: Response) => {
      const session = requireOwnedActiveSession(req, res, db);
      if (!session) return;
      if (!req.file) return res.status(400).json({ error: "photo is required" });
      if (!MISTAKE_PHOTO_TYPES.has(req.file.mimetype)) {
        return res.status(415).json({ error: "photo type must be JPEG, PNG, or WebP" });
      }
      if (req.file.size > MISTAKE_PHOTO_MAX_BYTES) {
        return res.status(413).json({ error: "photo exceeds 500 KB" });
      }
      try {
        const metadata = await sharp(req.file.buffer, { failOn: "error" }).metadata();
        if (metadata.format !== expectedSharpFormat(req.file.mimetype)) {
          return res.status(415).json({ error: "photo contents do not match its type" });
        }
      } catch {
        return res.status(415).json({ error: "photo is not a valid image" });
      }
      const draftId = req.body?.draftId;
      if (!validDraftId(draftId)) {
        return res.status(400).json({ error: "valid draftId is required" });
      }
      const receipt = findConfirmationReceipt(db, draftId);
      if (receipt) {
        if (receipt.sessionId !== session.id) {
          return res.status(403).json({ error: "draft belongs to another session" });
        }
        return res.json(publicReceipt(receipt));
      }
      if (!visionClient) return res.status(503).json({ error: "vision not configured" });

      const principal = devicePrincipal(res);
      try {
        const draft = await workflow.analyze({
          id: draftId,
          sessionId: session.id,
          childId: session.child_id,
          deviceId: principal.deviceId,
          bytes: req.file.buffer,
          extension: extensionFor(req.file.mimetype),
          analyze: (signal) => analyzeMistakeImage(
            visionClient,
            req.file!.buffer.toString("base64"),
            { signal },
          ),
        });
        const current = findOwnedActiveSession(db, session.id, principal);
        if (current.status !== "ok") {
          workflow.cancel(draft.id);
          return respondOwnedSessionFailure(res, current.status);
        }
        return res.json(publicDraft(draft));
      } catch (error: any) {
        if (error?.name === "DraftOwnershipError") {
          return res.status(403).json({ error: "draft does not belong to this session" });
        }
        logger.error("mistake photo analysis failed", {
          errorType: error?.name ?? "Error",
          timedOut: error?.name === "AbortError",
        });
        return res.status(error?.name === "AbortError" ? 504 : 502).json({ error: "vision failed" });
      }
    },
  );

  app.get("/api/mistake-photo/:draftId", auth.requireDevice, (req, res) => {
    const session = requireOwnedActiveSession(req, res, db);
    if (!session) return;
    const draftId = req.params.draftId;
    if (!validDraftId(draftId)) return res.status(400).json({ error: "invalid draftId" });
    const receipt = findConfirmationReceipt(db, draftId);
    if (receipt) {
      if (receipt.sessionId !== session.id) {
        return res.status(403).json({ error: "draft belongs to another session" });
      }
      return res.json(publicReceipt(receipt));
    }
    const draft = workflow.get(draftId);
    if (!draft) return res.status(404).json({ error: "draft not found or expired" });
    if (!ownedDraft(draft, session.id, devicePrincipal(res))) {
      return res.status(403).json({ error: "draft does not belong to this session" });
    }
    return res.json(publicDraft(draft));
  });

  app.post("/api/mistake-photo/:draftId/cancel", auth.requireDevice, (req, res) => {
    const session = requireOwnedActiveSession(req, res, db);
    if (!session) return;
    const draftId = req.params.draftId;
    if (!validDraftId(draftId)) return res.status(400).json({ error: "invalid draftId" });
    const draft = workflow.get(draftId);
    if (draft && !ownedDraft(draft, session.id, devicePrincipal(res))) {
      return res.status(403).json({ error: "draft does not belong to this session" });
    }
    const receipt = findConfirmationReceipt(db, draftId);
    if (receipt) {
      if (receipt.sessionId !== session.id) {
        return res.status(403).json({ error: "draft belongs to another session" });
      }
      return res.json(publicReceipt(receipt));
    }
    workflow.cancel(draftId);
    return res.json({ state: "cancelled" });
  });

  app.post("/api/mistake-photo/:draftId/confirm", auth.requireDevice, (req, res) => {
    const session = requireOwnedActiveSession(req, res, db);
    if (!session) return;
    const draftId = req.params.draftId;
    if (!validDraftId(draftId)) return res.status(400).json({ error: "invalid draftId" });
    const normalized = normalizeProblemText(typeof req.body?.problemText === "string" ? req.body.problemText : "");
    if (!normalized || normalized.length > 2000) {
      return res.status(400).json({ error: "problemText must contain 1 to 2000 characters" });
    }

    const receipt = findConfirmationReceipt(db, draftId);
    if (receipt) {
      if (receipt.sessionId !== session.id) {
        return res.status(403).json({ error: "draft belongs to another session" });
      }
      return res.json(publicReceipt(receipt));
    }
    const draft = workflow.get(draftId);
    if (!draft) return res.status(410).json({ error: "draft expired; analyze the photo again" });
    if (draft.state !== "review") return res.status(409).json({ error: "draft is still being analyzed" });
    if (!ownedDraft(draft, session.id, devicePrincipal(res))) {
      return res.status(403).json({ error: "draft does not belong to this session" });
    }
    const method = normalized === draft.proposedProblem
      ? "explicit_acceptance"
      : "explicit_correction";
    const confirmedAt = Date.now();

    try {
      const result = db.transaction(() => {
        const current = findOwnedActiveSession(db, session.id, devicePrincipal(res));
        if (current.status !== "ok") throw new SessionChanged(current.status);
        // T10 mirror work (issue #166): vision confirm writes the
        // closure-loop primary tables directly via `insertMistake()`.
        // It handles dedupe by (child_id, problem, source), writes
        // mistake_cases + learning_attempts (original) +
        // correction_obligations (open), INSERTs a mistakes mirror
        // row (to keep `mistake_photo_confirmations.mistake_id` FK
        // satisfied until PR-D v2.4 drops the column), and appends
        // the learning_attempt source event.
        const insertResult = insertMistake(
          db,
          {
            childId: session.child_id,
            problem: normalized,
            // Vision path has no typed user/correct answer — the
            // closure loop contract is "we have a wrong answer
            // worth tracking"; typed answer text arrives later
            // (issue #160 capture user answer in review).
            userAnswer: "",
            correctAnswer: "",
            errorType: "confirmed",
            source: "vision",
            subject: "math",
          },
          deps.beforeSourceEventAppend,
        );
        const mistakeId = insertResult.id;
        db.prepare(
          `INSERT OR IGNORE INTO mistake_photo_confirmations
             (draft_id, mistake_id, session_id, child_id, device_id,
              confirmation_method, confirmed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          draftId,
          mistakeId,
          session.id,
          session.child_id,
          devicePrincipal(res).deviceId,
          method,
          confirmedAt,
        );
        return {
          caseId: insertResult.caseId,
          mistakeId,
          problemText: normalized,
          confirmationMethod: method,
        };
      })();
      workflow.complete(draftId);
      return res.json({ state: "confirmed", ...result });
    } catch (error) {
      if (error instanceof SessionChanged) {
        return respondOwnedSessionFailure(res, error.status);
      }
      logger.error("mistake photo confirmation failed", { errorType: "database" });
      return res.status(500).json({ error: "mistake could not be confirmed" });
    }
  });
}

function safePhotoUpload(upload: any) {
  return (req: Request, res: Response, next: () => void) => {
    upload.single("photo")(req, res, (error: any) => {
      if (error?.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: "photo exceeds 500 KB" });
      }
      if (error) return res.status(400).json({ error: "invalid photo upload" });
      next();
    });
  };
}

function publicDraft(draft: {
  id: string;
  proposedProblem: string;
  expiresAt: number;
  state: string;
  confidence: "ok" | "low";
}) {
  return {
    draftId: draft.id,
    state: draft.state,
    problemText: draft.proposedProblem,
    confidence: draft.confidence,
    expiresAt: draft.expiresAt,
  };
}

function ownedDraft(
  draft: { sessionId: string; childId: string; deviceId: string },
  sessionId: string,
  principal: { childId: string; deviceId: string },
) {
  return draft.sessionId === sessionId
    && draft.childId === principal.childId
    && draft.deviceId === principal.deviceId;
}

interface ConfirmationReceipt {
  sessionId: string;
  caseId: string;
  mistakeId: number;
  problemText: string;
  confirmationMethod: string;
}

function findConfirmationReceipt(
  db: Database.Database,
  draftId: string,
): ConfirmationReceipt | null {
  const row = db.prepare(
    `SELECT c.session_id AS sessionId, mc.case_id AS caseId, m.id AS mistakeId,
            m.problem AS problemText,
            c.confirmation_method AS confirmationMethod
       FROM mistake_photo_confirmations c
       JOIN mistakes m ON m.id = c.mistake_id
       JOIN mistake_cases mc ON mc.original_mistake_id = m.id
      WHERE c.draft_id = ?`,
  ).get(draftId) as ConfirmationReceipt | undefined;
  return row ?? null;
}

function publicReceipt(receipt: ConfirmationReceipt) {
  const { sessionId: _sessionId, ...result } = receipt;
  return { state: "confirmed", ...result };
}

function extensionFor(mimetype: string): string {
  if (mimetype === "image/png") return "png";
  if (mimetype === "image/webp") return "webp";
  return "jpg";
}

function expectedSharpFormat(mimetype: string): "jpeg" | "png" | "webp" {
  if (mimetype === "image/png") return "png";
  if (mimetype === "image/webp") return "webp";
  return "jpeg";
}

class SessionChanged extends Error {
  constructor(readonly status: OwnedSessionFailure) {
    super("owned session changed");
  }
}

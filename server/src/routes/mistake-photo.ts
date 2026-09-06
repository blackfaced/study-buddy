import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import sharp from "sharp";
import type { Logger } from "../logger.js";
import type { MistakeItem, VisionClient } from "../vision.js";
import { analyzeMistakeItems, reviseMistakeItem } from "../vision.js";
import { devicePrincipal, type DeviceRequestAuthenticator } from "../device-auth.js";
import { findOwnedActiveSession } from "../session-queries.js";
import {
  requireOwnedActiveSession,
  respondOwnedSessionFailure,
} from "./session.js";
import {
  confirmMistakePhotoDraft,
  findMistakePhotoConfirmation,
  SessionChangedError,
  type MistakePhotoConfirmationReceipt,
} from "../capture-service.js";
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
      const receipt = findMistakePhotoConfirmation(db, draftId);
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
          // Multi-item 拍错题: the vision model splits every wrong spot
          // into its own item; proposedProblem stays the first item's
          // problem for backward-compatible clients.
          analyze: async (signal) => {
            const analysis = await analyzeMistakeItems(
              visionClient,
              req.file!.buffer.toString("base64"),
              signal,
            );
            return {
              problemText: analysis.items[0]?.problem ?? "",
              model: analysis.model,
              confidence: analysis.confidence,
              items: analysis.items,
            };
          },
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
    const receipt = findMistakePhotoConfirmation(db, draftId);
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
    const receipt = findMistakePhotoConfirmation(db, draftId);
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
    // Multi-item 拍错题: itemIndex picks which split item to confirm
    // (default 0 — the legacy whole-draft behavior).
    const rawIndex: unknown = req.body?.itemIndex;
    const itemIndex = rawIndex === undefined ? 0 : rawIndex;
    if (!Number.isInteger(itemIndex) || (itemIndex as number) < 0) {
      return res.status(400).json({ error: "itemIndex must be a non-negative integer" });
    }

    const receipt = findMistakePhotoConfirmation(db, draftId, itemIndex as number);
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
    if ((itemIndex as number) >= Math.max(draft.items.length, 1)) {
      return res.status(400).json({ error: "itemIndex out of range" });
    }
    const item = draft.items[itemIndex as number];
    // problemText defaults to the item's problem; an explicit body value
    // (parent edit) wins and marks the confirmation a correction.
    const rawText: unknown = req.body?.problemText;
    const normalized = normalizeProblemText(
      rawText === undefined ? item?.problem ?? "" : typeof rawText === "string" ? rawText : "",
    );
    if (!normalized || normalized.length > 2000) {
      return res.status(400).json({ error: "problemText must contain 1 to 2000 characters" });
    }
    try {
      const result = confirmMistakePhotoDraft(
        db,
        {
          draftId,
          itemIndex: itemIndex as number,
          problemText: normalized,
          proposedProblem: item?.problem ?? draft.proposedProblem,
          sessionId: session.id,
          childId: session.child_id,
          deviceId: devicePrincipal(res).deviceId,
          subject: item?.subject,
          userAnswer: item?.userAnswer,
          correctAnswer: item?.correctAnswer,
          errorType: item?.errorType,
        },
        deps.beforeSourceEventAppend,
      );
      // Keep the draft alive until every item is confirmed; only then
      // is the review over.
      workflow.markConfirmed(draftId, itemIndex as number);
      if (draft.confirmedIndexes.length >= draft.items.length) {
        workflow.complete(draftId);
      }
      return res.json({ state: "confirmed", ...result });
    } catch (error) {
      if (error instanceof SessionChangedError) {
        return respondOwnedSessionFailure(res, error.status);
      }
      logger.error("mistake photo confirmation failed", { errorType: "database" });
      return res.status(500).json({ error: "mistake could not be confirmed" });
    }
  });

  // POST /api/mistake-photo/:draftId/items/:index/revise
  // Body: { instruction } — the parent's 1~200-char natural-language
  // fix ("学科改成语文"). A text-only LLM call rewrites that one item;
  // the draft is updated in place and the revised item returned.
  app.post(
    "/api/mistake-photo/:draftId/items/:index/revise",
    auth.requireDevice,
    async (req: Request, res: Response) => {
      const session = requireOwnedActiveSession(req, res, db);
      if (!session) return;
      const draftId = req.params.draftId;
      if (!validDraftId(draftId)) return res.status(400).json({ error: "invalid draftId" });
      const index = Number(req.params.index);
      if (!Number.isInteger(index) || index < 0) {
        return res.status(400).json({ error: "invalid item index" });
      }
      const instruction = typeof req.body?.instruction === "string" ? req.body.instruction.trim() : "";
      if (instruction.length < 1 || instruction.length > 200) {
        return res.status(400).json({ error: "instruction 需要 1~200 个字符" });
      }
      if (!visionClient) return res.status(503).json({ error: "vision not configured" });
      const draft = workflow.get(draftId);
      if (!draft) return res.status(404).json({ error: "draft not found or expired" });
      if (!ownedDraft(draft, session.id, devicePrincipal(res))) {
        return res.status(403).json({ error: "draft does not belong to this session" });
      }
      if (draft.state !== "review") {
        return res.status(409).json({ error: "draft is still being analyzed" });
      }
      if (index >= draft.items.length) {
        return res.status(404).json({ error: "item not found" });
      }
      try {
        const item = await workflow.reviseItem(draftId, index, (current) =>
          reviseMistakeItem(visionClient, current, instruction));
        if (!item) return res.status(404).json({ error: "item not found" });
        return res.json({ index, item });
      } catch (error) {
        // Same contract as /api/capture/organize: log the failure
        // detail so an API outage is distinguishable from a
        // model-off-script reply, then 502.
        logger.error("mistake photo item revise failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        return res.status(502).json({ error: "修改失败，请稍后重试" });
      }
    },
  );
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
  items: MistakeItem[];
  expiresAt: number;
  state: string;
  confidence: "ok" | "low";
}) {
  return {
    draftId: draft.id,
    state: draft.state,
    problemText: draft.proposedProblem,
    // Multi-item 拍错题: one entry per wrong spot, reasoning included so
    // the parent sees why each was flagged before confirming.
    items: draft.items,
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

function publicReceipt(receipt: MistakePhotoConfirmationReceipt) {
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

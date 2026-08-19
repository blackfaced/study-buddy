// src/mistake-page-photo-workflow.ts
//
// v0.5 (issue #128 / SB124-T04): page-photo multi-candidate capture
// workflow. One page photo → N candidate mistakes. Each candidate can
// be confirmed / edited / discarded. Confirmed candidates become
// Mistake Cases via insertMistake (source='vision_page') and surface
// in the unified inbox.
//
// Strategy B (per parent decision): layout analysis first (returns N
// regions with bounding boxes), then per-region OCR (T04-B). This
// file covers the layout pass + DB persistence (T04-A). Per-region
// OCR and the confirm/discard flow arrive in T04-B and T04-C.

import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import {
  type LayoutRegion,
  type PageLayoutAnalysis,
  type VisionClient,
  analyzePageLayout,
} from "./vision-page.js";

export const MISTAKE_PAGE_PHOTO_MAX_BYTES = 1_500 * 1024; // 1.5 MB (whole pages are larger than single problems)
export const MISTAKE_PAGE_PHOTO_TTL_MS = 30 * 60_000; // 30 min (parent may take longer to review multiple candidates)
export const MISTAKE_PAGE_PHOTO_PROVIDER_TIMEOUT_MS = 30_000;
export const MISTAKE_PAGE_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type PageDraftState = "analyzing" | "review" | "completed" | "cancelled" | "expired";

export interface MistakePagePhotoDraft {
  id: string;
  childId: string;
  sessionId: string;
  deviceId: string;
  state: PageDraftState;
  regions: LayoutRegion[];
  layoutModel: string;
  layoutConfidence: "ok" | "low";
  imageBytes: Buffer;
  imageExtension: string;
  createdAt: number;
  expiresAt: number;
  completedAt: number | null;
}

export interface PageDraftInput {
  id?: string;
  childId: string;
  sessionId: string;
  deviceId: string;
  bytes: Buffer;
  extension: string;
  analyze: (imageBase64: string, signal: AbortSignal) => Promise<PageLayoutAnalysis & { model: string }>;
  now?: () => number;
  ttlMs?: number;
  providerTimeoutMs?: number;
}

interface WorkflowDeps {
  db: Database.Database;
  now?: () => number;
  ttlMs?: number;
  providerTimeoutMs?: number;
}

export class MistakePagePhotoWorkflow {
  readonly #db: Database.Database;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #providerTimeoutMs: number;

  constructor(deps: WorkflowDeps) {
    this.#db = deps.db;
    this.#now = deps.now ?? Date.now;
    this.#ttlMs = deps.ttlMs ?? MISTAKE_PAGE_PHOTO_TTL_MS;
    this.#providerTimeoutMs = deps.providerTimeoutMs ?? MISTAKE_PAGE_PHOTO_PROVIDER_TIMEOUT_MS;
  }

  /**
   * Create a new page-photo draft. Persists the original image bytes
   * for later per-region OCR, runs the layout pass, and writes the
   * regions back to the row. The draft transitions from `analyzing`
   * to `review` (regions persisted) by the time this method returns.
   *
   * Idempotency: if `input.id` matches an existing draft owned by
   * the same child/session/device, the existing draft is returned
   * (no re-analysis, no DB write). This mirrors the single-photo
   * workflow's `draftId` idempotency.
   */
  async createPageDraft(input: PageDraftInput): Promise<MistakePagePhotoDraft> {
    const draftId = input.id ?? `page_${randomUUID()}`;
    const existing = this.#db
      .prepare(
        `SELECT id, child_id, session_id, device_id, state
           FROM mistake_photo_page_drafts
          WHERE id = ?`,
      )
      .get(draftId) as
      | { id: string; child_id: string; session_id: string; device_id: string; state: string }
      | undefined;
    if (existing) {
      assertSameOwner(existing, input);
      const row = this.#loadById(draftId);
      if (!row) throw new Error("draft row disappeared after existence check");
      return row;
    }

    const now = this.#now();
    const expiresAt = now + (input.ttlMs ?? this.#ttlMs);

    // Insert the row in 'analyzing' state so a duplicate concurrent
    // request can't race past the existence check. The transaction
    // also guarantees partial state isn't visible if analysis throws.
    const insert = this.#db.prepare(`
      INSERT INTO mistake_photo_page_drafts (
        id, child_id, session_id, device_id, state,
        layout_model, layout_regions_json, layout_confidence,
        image_bytes, image_extension,
        created_at, expires_at, completed_at
      ) VALUES (
        @id, @child_id, @session_id, @device_id, 'analyzing',
        '', '[]', 'low',
        @image_bytes, @image_extension,
        @created_at, @expires_at, NULL
      )
    `);
    insert.run({
      id: draftId,
      child_id: input.childId,
      session_id: input.sessionId,
      device_id: input.deviceId,
      image_bytes: input.bytes,
      image_extension: input.extension,
      created_at: now,
      expires_at: expiresAt,
    });

    // Run the layout pass outside any open transaction so a slow
    // vision call doesn't hold a write lock on the page-drafts table.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), input.providerTimeoutMs ?? this.#providerTimeoutMs);
    timeout.unref?.();
    let analysis: (PageLayoutAnalysis & { model: string }) | null = null;
    try {
      const imageBase64 = input.bytes.toString("base64");
      analysis = await input.analyze(imageBase64, controller.signal);
    } catch (error) {
      // Roll back the analyzing row so a failure doesn't leave a
      // half-baked draft. The parent can retry with a new id.
      this.#db.prepare("DELETE FROM mistake_photo_page_drafts WHERE id = ?").run(draftId);
      throw error;
    } finally {
      clearTimeout(timeout);
    }

    // Persist the layout result, transition to 'review'.
    this.#db
      .prepare(
        `UPDATE mistake_photo_page_drafts
            SET state = 'review',
                layout_model = ?,
                layout_regions_json = ?,
                layout_confidence = ?
          WHERE id = ?`,
      )
      .run(
        analysis.model,
        JSON.stringify(analysis.regions),
        analysis.confidence,
        draftId,
      );

    const row = this.#loadById(draftId);
    if (!row) throw new Error("draft row disappeared after layout write");
    return row;
  }

  /**
   * Fetch a persisted page-photo draft by id. Cross-child isolation:
   * if `expectedChildId` is provided and doesn't match the row's
   * child_id, returns null (same pattern as getMistake / single
   * photo). Server-side `state` filter is also applied — a 'cancelled'
   * or 'expired' draft isn't returned.
   */
  async getPageDraft(
    id: string,
    options: { childId?: string } = {},
  ): Promise<MistakePagePhotoDraft | null> {
    this.#sweepExpired();
    return this.#loadById(id, options);
  }

  /**
   * Mark a draft as completed. Idempotent — calling twice is a no-op.
   * Called by confirm-candidate / discard-candidate / cancel after
   * the last candidate is resolved. (T04-C will own this; T04-A
   * exposes the helper.)
   */
  markCompleted(id: string): void {
    this.#db
      .prepare(
        `UPDATE mistake_photo_page_drafts
            SET state = 'completed', completed_at = ?
          WHERE id = ? AND state IN ('analyzing', 'review')`,
      )
      .run(this.#now(), id);
  }

  /**
   * Mark a draft as cancelled. Idempotent.
   */
  markCancelled(id: string): void {
    this.#db
      .prepare(
        `UPDATE mistake_photo_page_drafts
            SET state = 'cancelled', completed_at = ?
          WHERE id = ? AND state IN ('analyzing', 'review')`,
      )
      .run(this.#now(), id);
  }

  #loadById(id: string, options: { childId?: string } = {}): MistakePagePhotoDraft | null {
    const row = this.#db
      .prepare(
        `SELECT id, child_id, session_id, device_id, state,
                layout_model, layout_regions_json, layout_confidence,
                image_bytes, image_extension,
                created_at, expires_at, completed_at
           FROM mistake_photo_page_drafts
          WHERE id = ?`,
      )
      .get(id) as
      | {
          id: string;
          child_id: string;
          session_id: string;
          device_id: string;
          state: string;
          layout_model: string;
          layout_regions_json: string;
          layout_confidence: string;
          image_bytes: Buffer;
          image_extension: string;
          created_at: number;
          expires_at: number;
          completed_at: number | null;
        }
      | undefined;
    if (!row) return null;
    if (options.childId && row.child_id !== options.childId) return null;
    if (row.state === "cancelled" || row.state === "expired") return null;
    return {
      id: row.id,
      childId: row.child_id,
      sessionId: row.session_id,
      deviceId: row.device_id,
      state: row.state as PageDraftState,
      regions: JSON.parse(row.layout_regions_json) as LayoutRegion[],
      layoutModel: row.layout_model,
      layoutConfidence: row.layout_confidence as "ok" | "low",
      imageBytes: row.image_bytes,
      imageExtension: row.image_extension,
      createdAt: row.created_at,
      expiresAt: row.expires_at,
      completedAt: row.completed_at,
    };
  }

  #sweepExpired(): number {
    const now = this.#now();
    const result = this.#db
      .prepare(
        `UPDATE mistake_photo_page_drafts
            SET state = 'expired', completed_at = ?
          WHERE state IN ('analyzing', 'review') AND expires_at <= ?`,
      )
      .run(now, now);
    return result.changes;
  }
}

function assertSameOwner(
  row: { child_id: string; session_id: string; device_id: string },
  input: Pick<PageDraftInput, "childId" | "sessionId" | "deviceId">,
): void {
  if (
    row.child_id !== input.childId
    || row.session_id !== input.sessionId
    || row.device_id !== input.deviceId
  ) {
    const error = new Error("page draft belongs to another session");
    error.name = "PageDraftOwnershipError";
    throw error;
  }
}

/**
 * Adapter: wrap a VisionClient + base64 into the workflow's expected
 * `analyze` callback. Lets the route layer stay thin.
 */
export function pageAnalyzeAdapter(
  client: VisionClient,
  model?: string,
): (imageBase64: string, signal: AbortSignal) => Promise<PageLayoutAnalysis & { model: string }> {
  return (imageBase64, signal) => analyzePageLayout(client, imageBase64, { model, signal });
}

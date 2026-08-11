import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const MISTAKE_PHOTO_MAX_BYTES = 500 * 1024;
export const MISTAKE_PHOTO_TTL_MS = 10 * 60_000;
export const MISTAKE_PHOTO_PROVIDER_TIMEOUT_MS = 20_000;
export const MISTAKE_PHOTO_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export interface MistakePhotoDraft {
  id: string;
  sessionId: string;
  childId: string;
  deviceId: string;
  proposedProblem: string;
  model: string;
  createdAt: number;
  expiresAt: number;
  state: "analyzing" | "review";
  pending?: Promise<void>;
  abort?: () => void;
}

interface WorkflowOptions {
  rootDir: string;
  now?: () => number;
  ttlMs?: number;
  providerTimeoutMs?: number;
}

interface AnalyzeInput {
  id: string;
  sessionId: string;
  childId: string;
  deviceId: string;
  bytes: Buffer;
  extension: string;
  analyze: (signal: AbortSignal) => Promise<{ problemText: string; model: string }>;
}

export class MistakePhotoWorkflow {
  readonly #drafts = new Map<string, MistakePhotoDraft>();
  readonly #pendingDir: string;
  readonly #now: () => number;
  readonly #ttlMs: number;
  readonly #providerTimeoutMs: number;

  constructor(options: WorkflowOptions) {
    this.#pendingDir = join(options.rootDir, ".pending");
    this.#now = options.now ?? Date.now;
    this.#ttlMs = options.ttlMs ?? MISTAKE_PHOTO_TTL_MS;
    this.#providerTimeoutMs = options.providerTimeoutMs ?? MISTAKE_PHOTO_PROVIDER_TIMEOUT_MS;
    mkdirSync(this.#pendingDir, { recursive: true });
    this.cleanupOrphanFiles();
  }

  async analyze(input: AnalyzeInput): Promise<MistakePhotoDraft> {
    this.sweepExpired();
    const existing = this.#drafts.get(input.id);
    if (existing) {
      assertSameOwner(existing, input);
      if (existing.pending) await existing.pending;
      const completed = this.#drafts.get(input.id);
      if (!completed) throw new Error("analysis failed");
      return completed;
    }

    const createdAt = this.#now();
    const draft: MistakePhotoDraft = {
      id: input.id,
      sessionId: input.sessionId,
      childId: input.childId,
      deviceId: input.deviceId,
      proposedProblem: "",
      model: "",
      createdAt,
      expiresAt: createdAt + this.#ttlMs,
      state: "analyzing",
    };
    this.#drafts.set(input.id, draft);

    const path = join(this.#pendingDir, `${input.id}.${input.extension}`);
    const controller = new AbortController();
    draft.abort = () => controller.abort();
    const timeout = setTimeout(() => controller.abort(), this.#providerTimeoutMs);
    timeout.unref?.();
    draft.pending = (async () => {
      try {
        writeFileSync(path, input.bytes, { flag: "wx" });
        const analysis = await Promise.race([
          input.analyze(controller.signal),
          new Promise<never>((_resolve, reject) => {
            controller.signal.addEventListener("abort", () => {
              const error = new Error("vision provider timed out");
              error.name = "AbortError";
              reject(error);
            }, { once: true });
          }),
        ]);
        draft.proposedProblem = normalizeProblemText(analysis.problemText);
        draft.model = analysis.model;
        draft.state = "review";
        delete draft.pending;
        delete draft.abort;
      } catch (error) {
        this.#drafts.delete(input.id);
        throw error;
      } finally {
        clearTimeout(timeout);
        removeFile(path);
      }
    })();

    await draft.pending;
    this.#scheduleExpiry(draft.id, draft.expiresAt);
    return draft;
  }

  get(id: string): MistakePhotoDraft | null {
    this.sweepExpired();
    return this.#drafts.get(id) ?? null;
  }

  cancel(id: string): boolean {
    this.sweepExpired();
    const draft = this.#drafts.get(id);
    draft?.abort?.();
    return this.#drafts.delete(id);
  }

  complete(id: string): void {
    this.#drafts.delete(id);
  }

  sweepExpired(): number {
    const now = this.#now();
    let removed = 0;
    for (const [id, draft] of this.#drafts) {
      if (draft.expiresAt > now) continue;
      this.#drafts.delete(id);
      removed += 1;
    }
    return removed;
  }

  cleanupOrphanFiles(): number {
    let removed = 0;
    for (const name of readdirSync(this.#pendingDir)) {
      removeFile(join(this.#pendingDir, name));
      removed += 1;
    }
    return removed;
  }

  #scheduleExpiry(id: string, expiresAt: number): void {
    const timer = setTimeout(() => {
      const draft = this.#drafts.get(id);
      if (draft && draft.expiresAt <= this.#now()) this.#drafts.delete(id);
    }, Math.max(0, expiresAt - this.#now()));
    timer.unref?.();
  }
}

export function normalizeProblemText(value: string): string {
  return value
    .replace(/\r\n?/g, "\n")
    .replace(/[\t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function validDraftId(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}

function assertSameOwner(
  draft: MistakePhotoDraft,
  input: Pick<AnalyzeInput, "sessionId" | "childId" | "deviceId">,
): void {
  if (
    draft.sessionId !== input.sessionId
    || draft.childId !== input.childId
    || draft.deviceId !== input.deviceId
  ) {
    const error = new Error("draft belongs to another session");
    error.name = "DraftOwnershipError";
    throw error;
  }
}

function removeFile(path: string): void {
  try { unlinkSync(path); } catch { /* already gone */ }
}

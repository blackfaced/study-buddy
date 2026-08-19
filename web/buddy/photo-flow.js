(function () {
  function createPhotoFlow(deps) {
    let current = emptyState();
    let activeAbort = null;

    function emit() {
      deps.onState({ ...current });
    }

    function replace(next) {
      current = next;
      emit();
    }

    function releaseLocal() {
      if (current.previewUrl) deps.revokePreview(current.previewUrl);
    }

    return {
      get state() { return { ...current }; },

      preview(blob, previewUrl) {
        if (current.phase !== "idle") return false;
        replace({ ...emptyState(), phase: "preview", blob, previewUrl });
        return true;
      },

      async retake(sessionId) {
        if (current.phase === "preview") {
          releaseLocal();
          replace(emptyState());
          return true;
        }
        if (current.phase === "analyzing") {
          await this.cancel(sessionId);
          return true;
        }
        return false;
      },

      async cancel(sessionId) {
        if (current.phase === "confirming" || current.phase === "idle") return false;
        const draftId = current.draftId;
        replace({ ...current, phase: "cancelling" });
        activeAbort?.abort();
        try {
          if (draftId) await deps.cancelDraft(sessionId, draftId);
        } finally {
          releaseLocal();
          deps.clearDraft();
          replace(emptyState());
        }
        return true;
      },

      async analyze(sessionId) {
        if (current.phase !== "preview" || !current.blob) return false;
        const draftId = current.draftId || deps.newDraftId();
        deps.saveDraft(sessionId, draftId);
        replace({ ...current, phase: "analyzing", draftId, error: "" });
        const controller = deps.makeAbortController();
        activeAbort = controller;
        try {
          const result = await deps.upload(sessionId, draftId, current.blob, controller.signal);
          if (result.state === "confirmed") {
            releaseLocal();
            deps.clearDraft();
            replace({ ...emptyState(), phase: "confirmed", result });
            return true;
          }
          replace({
            ...current,
            phase: "review",
            draftId: result.draftId,
            problemText: result.problemText,
            confidence: result.confidence ?? "ok",
            expiresAt: result.expiresAt,
            error: "",
          });
          return true;
        } catch (error) {
          if (["cancelling", "idle"].includes(current.phase)) return false;
          deps.clearDraft();
          replace({ ...current, phase: "preview", draftId: "", error: deps.errorMessage(error) });
          return false;
        } finally {
          if (activeAbort === controller) activeAbort = null;
        }
      },

      async confirm(sessionId, problemText) {
        if (current.phase !== "review") return false;
        replace({ ...current, phase: "confirming", error: "" });
        try {
          const result = await deps.confirmDraft(sessionId, current.draftId, problemText);
          releaseLocal();
          deps.clearDraft();
          replace({ ...emptyState(), phase: "confirmed", result });
          return true;
        } catch (error) {
          replace({ ...current, phase: "review", error: deps.errorMessage(error) });
          return false;
        }
      },

      async restore(sessionId, draftId) {
        if (!sessionId || !draftId || current.phase !== "idle") return false;
        try {
          const result = await deps.restoreDraft(sessionId, draftId);
          if (result.state === "confirmed") {
            deps.clearDraft();
            replace({ ...emptyState(), phase: "confirmed", result });
            return true;
          }
          replace({
            ...emptyState(),
            phase: "review",
            draftId: result.draftId,
            problemText: result.problemText,
            confidence: result.confidence ?? "ok",
            expiresAt: result.expiresAt,
          });
          return true;
        } catch {
          deps.clearDraft();
          replace(emptyState());
          return false;
        }
      },

      resetConfirmed() {
        if (current.phase === "confirmed") replace(emptyState());
      },
    };
  }

  function emptyState() {
    return {
      phase: "idle",
      blob: null,
      previewUrl: "",
      draftId: "",
      problemText: "",
      confidence: "ok",
      expiresAt: 0,
      error: "",
      result: null,
    };
  }

  window.BuddyPhotoFlow = { createPhotoFlow };
})();

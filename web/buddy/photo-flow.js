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

    function setItem(index, patch) {
      const items = current.items.map((it, i) => (i === index ? { ...it, ...patch } : it));
      replace({ ...current, items });
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
        if (current.phase === "idle") return false;
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
            items: deps.extractItems(result),
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

      // Multi-item 拍错题: confirm one split item at a time. The draft
      // (and its sessionStorage restore key) stays alive until every
      // item is recorded; only then does the overlay close.
      async confirmItem(sessionId, itemIndex) {
        if (current.phase !== "review") return false;
        const item = current.items[itemIndex];
        if (!item || item.confirmed || item.confirming) return false;
        setItem(itemIndex, { confirming: true, error: "" });
        try {
          const result = await deps.confirmDraft(sessionId, current.draftId, itemIndex);
          const items = current.items.map((it, i) =>
            i === itemIndex ? { ...it, confirming: false, confirmed: true, error: "" } : it);
          if (items.every((it) => it.confirmed)) {
            releaseLocal();
            deps.clearDraft();
            replace({ ...emptyState(), phase: "confirmed", result });
          } else {
            replace({ ...current, items, error: "" });
          }
          return true;
        } catch (error) {
          setItem(itemIndex, { confirming: false, error: deps.errorMessage(error) });
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
            items: deps.extractItems(result),
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

      // 家长不手改字段（issue #220）：输入自然语言"要求"，由 LLM 改写
      // 这一条；成功后该卡片的字段整体换成服务端返回的 revised item。
      async reviseItem(sessionId, itemIndex, instruction) {
        if (current.phase !== "review") return false;
        const item = current.items[itemIndex];
        if (!item || item.confirmed || item.revising) return false;
        setItem(itemIndex, { revising: true, error: "" });
        try {
          const result = await deps.reviseDraft(sessionId, current.draftId, itemIndex, instruction);
          const revised = result && result.item ? result.item : {};
          setItem(itemIndex, { ...revised, revising: false, error: "" });
          return true;
        } catch (error) {
          setItem(itemIndex, { revising: false, error: deps.errorMessage(error) });
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
      items: [],
      confidence: "ok",
      expiresAt: 0,
      error: "",
      result: null,
    };
  }

  window.BuddyPhotoFlow = { createPhotoFlow };
})();

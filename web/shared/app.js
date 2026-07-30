// web/shared/app.js
// ====================================================================
// Study Buddy — cross-app helpers
// ====================================================================
// Single source of truth for the three patterns every hung app ends up
// re-implementing:
//
//   1. warmupTTS()      — speak a silent utterance so a later async
//                          speak(text) inside a microtask doesn't fail
//                          silently on iOS Safari (gesture context).
//   2. fetch(path,opts) — JSON-aware fetch with common headers
//                          (Accept, Content-Type) and a parsed body.
//   3. cameraPause(o)   — bind a "focus → stop video, blur → delayed
//                          restart" pattern to a trigger element so
//                          iOS keyboard mic works and TTS doesn't get
//                          muted mid-utterance.
//
// Loaded via:
//   <script src="/shared/app.js"></script>
// Exposes `window.StudyBuddy` with the three helpers.
//
// All helpers are no-ops when the corresponding browser feature is
// missing (no speechSynthesis, no fetch, etc.) so apps can call them
// unconditionally.
// ====================================================================
(function () {
  const SB = (window.StudyBuddy = window.StudyBuddy || {});

  // ---- 1. warmupTTS --------------------------------------------------
  /**
   * Speak a 1-char silent utterance to "warm" the speech engine so a
   * subsequent speak(text) inside an async callback doesn't silently
   * fail on iOS Safari (gesture context expires across microtasks).
   *
   * MUST be called from a synchronous user-gesture handler.
   * Safe to call when speechSynthesis is missing or throws.
   */
  SB.warmupTTS = function warmupTTS() {
    if (typeof window === "undefined") return;
    if (!("speechSynthesis" in window)) return;
    try {
      const u = new SpeechSynthesisUtterance(" ");
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch {
      // Some browsers throw on speak() with empty text; ignore.
    }
  };

  // ---- 2. fetch ------------------------------------------------------
  /**
   * Thin fetch wrapper that:
   *   - sets `Accept: application/json` by default
   *   - auto-serialises a plain-object body and sets Content-Type
   *   - returns parsed JSON for JSON responses, text otherwise
   *   - throws on non-2xx with the response text attached
   *
   * @param {string} path
   * @param {object} [opts] - fetch options. `opts.body` may be a
   *   plain object (auto-serialised), FormData, Blob, or a string.
   * @returns {Promise<any>}
   */
  SB.fetch = async function fetchJSON(path, opts = {}) {
    if (typeof fetch !== "function") {
      throw new Error("StudyBuddy.fetch: global fetch is not available");
    }
    const headers = { Accept: "application/json", ...(opts.headers || {}) };
    const init = { ...opts, headers };
    if (init.body !== undefined && init.body !== null) {
      const isFormData = typeof FormData !== "undefined" && init.body instanceof FormData;
      const isBlob = typeof Blob !== "undefined" && init.body instanceof Blob;
      const isString = typeof init.body === "string";
      if (!isFormData && !isBlob && !isString) {
        if (!headers["Content-Type"]) headers["Content-Type"] = "application/json";
        init.body = JSON.stringify(init.body);
      }
    }
    const resp = await fetch(path, init);
    if (!resp.ok) {
      let text = "";
      try { text = await resp.text(); } catch { /* ignore */ }
      const err = new Error(`StudyBuddy.fetch: ${path} -> ${resp.status} ${text}`);
      err.status = resp.status;
      err.text = text;
      throw err;
    }
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("application/json")) return resp.json();
    return resp.text();
  };

  // ---- 3. cameraPause ------------------------------------------------
  /**
   * Bind a "focus → stop video; blur → delayed restart" pattern to a
   * trigger element (typically an <input>). Useful on iOS Safari so
   * that:
   *   - the keyboard's mic can take the audio channel while the user
   *     is typing (camera paused)
   *   - the camera doesn't restart immediately on blur and steal the
   *     channel from in-flight TTS (delayed by `resumeDelayMs`)
   *
   * @param {object}   opts
   * @param {Element}  opts.triggerEl       REQUIRED — the input to bind
   * @param {Function} [opts.getStream]     () => MediaStream | null
   *   Called on focus; the returned stream's tracks are stopped.
   * @param {Function} [opts.openCamera]    () => Promise<MediaStream|>
   *   Called on blur (after delay) to get a fresh stream.
   * @param {Function} [opts.onPause]       () => void
   * @param {Function} [opts.onResume]      () => void
   * @param {number}   [opts.resumeDelayMs] Default 2500.
   * @returns {Function} off() — removes listeners and cancels pending timer.
   */
  SB.cameraPause = function cameraPause(opts) {
    const o = opts || {};
    const triggerEl = o.triggerEl;
    if (!triggerEl) {
      throw new Error("StudyBuddy.cameraPause: triggerEl is required");
    }
    const getStream = o.getStream;
    const openCamera = o.openCamera;
    const onPause = o.onPause;
    const onResume = o.onResume;
    const resumeDelayMs = typeof o.resumeDelayMs === "number" ? o.resumeDelayMs : 2500;

    let paused = false;
    let resumeTimer = null;

    const clearTimer = () => {
      if (resumeTimer) { clearTimeout(resumeTimer); resumeTimer = null; }
    };

    const handleFocus = () => {
      const stream = typeof getStream === "function" ? getStream() : null;
      if (stream && typeof stream.getTracks === "function") {
        try { stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
      }
      // Cancel any pending resume; the user is typing again.
      clearTimer();
      paused = true;
      if (typeof onPause === "function") {
        try { onPause(); } catch { /* ignore */ }
      }
    };

    const handleBlur = () => {
      if (!paused) return;
      paused = false;
      clearTimer();
      resumeTimer = setTimeout(async () => {
        resumeTimer = null;
        // The user may have re-focused the input in the delay window.
        if (document && document.activeElement === triggerEl) return;
        if (typeof openCamera === "function") {
          try { await openCamera(); } catch { /* ignore openCamera errors */ }
        }
        if (typeof onResume === "function") {
          try { onResume(); } catch { /* ignore */ }
        }
      }, resumeDelayMs);
    };

    triggerEl.addEventListener("focus", handleFocus);
    triggerEl.addEventListener("blur", handleBlur);

    return function off() {
      triggerEl.removeEventListener("focus", handleFocus);
      triggerEl.removeEventListener("blur", handleBlur);
      clearTimer();
    };
  };
})();

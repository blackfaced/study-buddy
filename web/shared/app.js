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
  const DEVICE_CREDENTIAL_KEY = "study-buddy.device-credential";

  SB.auth = {
    getCredential() {
      try {
        return window.localStorage.getItem(DEVICE_CREDENTIAL_KEY);
      } catch {
        return null;
      }
    },
    setCredential(credential) {
      if (typeof credential !== "string" || !credential.startsWith("sb_")) {
        throw new Error("StudyBuddy.auth: invalid device credential");
      }
      window.localStorage.setItem(DEVICE_CREDENTIAL_KEY, credential);
    },
    clearCredential() {
      try { window.localStorage.removeItem(DEVICE_CREDENTIAL_KEY); } catch { /* ignore */ }
    },
  };

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
    const credential = SB.auth.getCredential();
    if (credential && !headers.Authorization && !headers.authorization) {
      if (!isSecureSameOriginTarget(path)) {
        throw new Error("StudyBuddy.fetch: device credential requires secure same-origin transport");
      }
      headers.Authorization = `Bearer ${credential}`;
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

  function isSecureSameOriginTarget(path) {
    const target = new URL(path, window.location.href);
    if (target.origin !== window.location.origin) return false;
    if (target.protocol === "https:") return true;
    return target.protocol === "http:" && (
      target.hostname === "localhost" ||
      target.hostname === "127.0.0.1" ||
      target.hostname === "[::1]"
    );
  }

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

  // ---- 3. test-instance env badge -------------------------------------
  // The 3002 test instance shares this code but not the kid's data
  // (AGENTS.md "Two instances"). A screenshot of the test instance once
  // got mistaken for production data (Codex review 9/5), so every page
  // that calls applyEnvBadge() shows a small 测试环境 pill when
  // /api/health reports env=test.

  /** Pure: badge text for a health-env value, or null for none. */
  SB.envBadgeText = function (env) {
    return env === "test" ? "测试环境" : null;
  };

  /** Fetch /api/health and pin a 测试环境 badge on test instances.
   *  No-op on prod, on fetch failure, or without a DOM. */
  SB.applyEnvBadge = async function () {
    if (typeof document === "undefined" || !document.body) return;
    let health;
    try {
      health = await SB.fetch("/api/health");
    } catch {
      return;
    }
    const text = SB.envBadgeText(health && health.env);
    if (!text || document.getElementById("env-badge")) return;
    const badge = document.createElement("div");
    badge.id = "env-badge";
    badge.textContent = text;
    badge.style.cssText =
      "position:fixed;top:4px;left:50%;transform:translateX(-50%);" +
      "background:#ff9800;color:#fff;font-size:12px;font-weight:bold;" +
      "padding:2px 12px;border-radius:10px;z-index:1000;pointer-events:none;";
    document.body.appendChild(badge);
  };
})();

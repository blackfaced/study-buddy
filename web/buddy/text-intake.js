// web/buddy/text-intake.js
// =====================================================================
// 文字描述 intake + 今日待订正 inbox for the buddy page, visible only in
// photo-only mode (BUDDY_CHAT_ENABLED=false — the .app.photo-only class
// gates the sections' CSS visibility). This replaces the standalone
// /capture/ page: the parent types a messy one-line description, the
// server organizes it via LLM (POST /api/capture/organize), the parent
// edits the 5 fields in a preview card, and 确认录入 POSTs to the
// existing /api/capture/manual.
//
// Classic script, exposes window.BuddyTextIntake. Loaded after
// photo-only.js in web/buddy/index.html. Pure helpers (normalize /
// validate / buildManualBody / renderInboxEntry) are unit-tested in
// text-intake.test.js; the DOM wiring is covered by the e2e smoke test.
// =====================================================================
(function () {
  var SUBJECTS = ["math", "chinese", "english"];
  var SUBJECT_LABELS = { math: "数学", chinese: "语文", english: "英语" };
  var FIELD_LABELS = {
    problem: "题目",
    userAnswer: "孩子写的答案",
    correctAnswer: "正确答案",
    subject: "学科",
    errorType: "错因",
  };

  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function str(v) {
    if (typeof v === "string") return v.trim();
    if (typeof v === "number") return String(v);
    return "";
  }

  /**
   * Coerce the /api/capture/organize response into the 5-string preview
   * shape. Unknown subjects drop to "" so the parent picks one.
   */
  function normalizeOrganized(raw) {
    var r = raw && typeof raw === "object" ? raw : {};
    var subject = str(r.subject);
    if (SUBJECTS.indexOf(subject) < 0) subject = "";
    return {
      problem: str(r.problem),
      userAnswer: str(r.userAnswer),
      correctAnswer: str(r.correctAnswer),
      subject: subject,
      errorType: str(r.errorType),
    };
  }

  /**
   * Validate the preview fields before 确认录入. Returns an error message
   * or null. Mirrors the /api/capture/manual contract: problem,
   * userAnswer, correctAnswer, subject required; errorType optional.
   */
  function validateFields(fields) {
    var required = ["problem", "userAnswer", "correctAnswer", "subject"];
    for (var i = 0; i < required.length; i++) {
      var key = required[i];
      if (!fields[key] || !String(fields[key]).trim()) {
        return FIELD_LABELS[key] + " 不能为空";
      }
    }
    return null;
  }

  /** Body for POST /api/capture/manual. Empty errorType → null. */
  function buildManualBody(fields) {
    var errorType = String(fields.errorType || "").trim();
    return {
      problem: String(fields.problem || "").trim(),
      userAnswer: String(fields.userAnswer || "").trim(),
      correctAnswer: String(fields.correctAnswer || "").trim(),
      subject: String(fields.subject || "").trim(),
      errorType: errorType || null,
    };
  }

  /**
   * One inbox <li>. The whole entry links to the review workspace;
   * childId is hardcoded to "default" (same convention as the old
   * /capture/ inbox — the PIN gate already scopes this device to one kid).
   */
  function renderInboxEntry(c) {
    var subject = c.subject ? SUBJECT_LABELS[c.subject] || c.subject : "未分科";
    var errorType = c.errorType ? " · " + escapeHtml(c.errorType) : "";
    var reviewUrl = "/review/?caseId=" + encodeURIComponent(c.caseId) + "&childId=default";
    return (
      '<li class="ti-inbox-entry">' +
      '<a class="ti-inbox-link" href="' + reviewUrl + '">' +
      "<div>" + escapeHtml(c.problem || "(无题目)") + "</div>" +
      '<div class="meta"><span>' + escapeHtml(subject) + "</span>" + errorType + "</div>" +
      "</a></li>"
    );
  }

  function emptyInboxCopy() {
    return "今天还没有待订正的错题";
  }

  // ---------------- DOM wiring (e2e-covered, not unit-tested) ----------------
  var bound = false;

  function $(id) {
    return document.getElementById(id);
  }

  function setStatus(text, isError) {
    var el = $("ti-status");
    if (!el) return;
    el.textContent = text;
    el.style.color = isError ? "#c62828" : "#806748";
  }

  function readPreviewFields() {
    return normalizeOrganized({
      problem: $("ti-field-problem").value,
      userAnswer: $("ti-field-userAnswer").value,
      correctAnswer: $("ti-field-correctAnswer").value,
      subject: $("ti-field-subject").value,
      errorType: $("ti-field-errorType").value,
    });
  }

  function showPreview(fields) {
    $("ti-field-problem").value = fields.problem;
    $("ti-field-userAnswer").value = fields.userAnswer;
    $("ti-field-correctAnswer").value = fields.correctAnswer;
    $("ti-field-subject").value = fields.subject;
    $("ti-field-errorType").value = fields.errorType;
    $("ti-preview").style.display = "";
  }

  function hidePreview() {
    $("ti-preview").style.display = "none";
  }

  async function onOrganize() {
    var textEl = $("ti-text");
    var text = textEl.value.trim();
    if (!text) {
      setStatus("先用一两句话描述错题", true);
      return;
    }
    var btn = $("ti-organize");
    btn.disabled = true;
    hidePreview();
    setStatus("整理中…", false);
    try {
      var data = await window.StudyBuddy.fetch("/api/capture/organize", {
        method: "POST",
        body: { text: text },
      });
      showPreview(normalizeOrganized(data));
      setStatus("", false);
    } catch (err) {
      setStatus(serverErrorCopy(err, "整理失败，请重试"), true);
    } finally {
      btn.disabled = false;
    }
  }

  async function onConfirm() {
    var fields = readPreviewFields();
    var invalid = validateFields(fields);
    if (invalid) {
      setStatus(invalid, true);
      return;
    }
    var btn = $("ti-confirm");
    btn.disabled = true;
    try {
      await window.StudyBuddy.fetch("/api/capture/manual", {
        method: "POST",
        body: buildManualBody(fields),
      });
      hidePreview();
      $("ti-text").value = "";
      setStatus("已录入 ✓", false);
      await loadInbox();
    } catch (err) {
      setStatus(serverErrorCopy(err, "录入失败，请重试"), true);
    } finally {
      btn.disabled = false;
    }
  }

  function serverErrorCopy(err, fallback) {
    try {
      var parsed = JSON.parse(err && err.text);
      if (parsed && parsed.error) return parsed.error;
    } catch { /* not a JSON error body */ }
    return fallback;
  }

  async function loadInbox() {
    var list = $("ti-inbox");
    if (!list) return;
    try {
      var data = await window.StudyBuddy.fetch("/api/capture/inbox");
      var cases = (data && data.cases) || [];
      if (cases.length === 0) {
        list.innerHTML = '<li class="ti-inbox-empty">' + emptyInboxCopy() + "</li>";
        return;
      }
      list.innerHTML = cases.map(renderInboxEntry).join("");
    } catch {
      list.innerHTML = '<li class="ti-inbox-empty">收件箱加载失败</li>';
    }
  }

  /**
   * Called by the buddy page after the PIN gate opens — the caller
   * (unlockBuddyUI) only calls this when chatEnabled === false. The
   * section elements always exist in the DOM; visibility is CSS-gated
   * by .photo-only.
   */
  function onUnlock() {
    if (!bound) {
      bound = true;
      var organizeBtn = $("ti-organize");
      var confirmBtn = $("ti-confirm");
      var cancelBtn = $("ti-cancel");
      if (organizeBtn) organizeBtn.addEventListener("click", onOrganize);
      if (confirmBtn) confirmBtn.addEventListener("click", onConfirm);
      if (cancelBtn) cancelBtn.addEventListener("click", function () { hidePreview(); setStatus("", false); });
    }
    loadInbox();
  }

  window.BuddyTextIntake = {
    SUBJECTS: SUBJECTS,
    SUBJECT_LABELS: SUBJECT_LABELS,
    normalizeOrganized: normalizeOrganized,
    validateFields: validateFields,
    buildManualBody: buildManualBody,
    renderInboxEntry: renderInboxEntry,
    emptyInboxCopy: emptyInboxCopy,
    onUnlock: onUnlock,
  };
})();

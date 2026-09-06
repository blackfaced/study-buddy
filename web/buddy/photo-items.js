// web/buddy/photo-items.js
// =====================================================================
// Multi-item 拍错题 review helpers. The vision model splits every wrong
// spot in the photo into its own item; the overlay renders one card per
// item, the parent can fix a card via a natural-language instruction
// (POST /items/:index/revise) and confirms each item separately
// (POST /confirm {itemIndex}). Classic script, exposes
// window.BuddyPhotoItems. Loaded before voice.js in web/buddy/index.html.
// Pure helpers are unit-tested in photo-items.test.js; the DOM wiring in
// voice.js is manual-tested on the iPad.
// =====================================================================
(function () {
  var SUBJECTS = ["math", "chinese", "english"];
  var SUBJECT_LABELS = { math: "数学", chinese: "语文", english: "英语" };

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
   * Coerce one item into the 6-string shape. Unknown subjects drop to ""
   * so the parent picks one from the 数学/语文/英语 select.
   */
  function normalizeItem(raw) {
    var r = raw && typeof raw === "object" ? raw : {};
    var subject = str(r.subject);
    if (SUBJECTS.indexOf(subject) < 0) subject = "";
    return {
      problem: str(r.problem),
      userAnswer: str(r.userAnswer),
      correctAnswer: str(r.correctAnswer),
      subject: subject,
      errorType: str(r.errorType),
      reasoning: str(r.reasoning),
    };
  }

  /**
   * Items for the review overlay. Legacy single-problem drafts (no
   * `items` array — or an empty one) fall back to one item built from
   * the top-level problemText so old cached drafts still render.
   */
  function extractItems(draft) {
    var d = draft && typeof draft === "object" ? draft : {};
    if (Array.isArray(d.items) && d.items.length > 0) {
      return d.items.map(normalizeItem);
    }
    return [normalizeItem({ problem: d.problemText })];
  }

  function subjectOptionsHtml(selected) {
    var html = '<option value="">未分科</option>';
    for (var i = 0; i < SUBJECTS.length; i++) {
      var s = SUBJECTS[i];
      html += '<option value="' + s + '"' + (s === selected ? " selected" : "") + ">" +
        SUBJECT_LABELS[s] + "</option>";
    }
    return html;
  }

  function fieldRow(label, value) {
    if (!value) return "";
    return '<div class="ti-photo-field"><span class="ti-photo-label">' + label +
      '</span><div class="ti-photo-value">' + escapeHtml(value) + "</div></div>";
  }

  /**
   * One review card for a split item. All item fields are read-only text
   * — the parent never hand-edits the final values (issues #219/#220):
   * the subject select is the only direct control, everything else goes
   * through the AI 改 instruction box. A confirmed card greys out, shows
   * 已记录 ✓ and drops every interactive control.
   */
  function renderItemCard(item, index) {
    var it = item && typeof item === "object" ? item : {};
    if (it.confirmed) {
      return (
        '<div class="ti-photo-item confirmed" data-index="' + index + '">' +
        fieldRow("题目", it.problem) +
        fieldRow("学科", SUBJECT_LABELS[it.subject] || "") +
        '<div class="ti-photo-done">已记录 ✓</div>' +
        "</div>"
      );
    }
    // While a revise or confirm is in flight every control on the card is
    // disabled — a second tap must not fire a duplicate request.
    var disabled = it.revising || it.confirming ? " disabled" : "";
    return (
      '<div class="ti-photo-item" data-index="' + index + '">' +
      fieldRow("题目", it.problem) +
      '<label class="ti-photo-field"><span class="ti-photo-label">学科</span>' +
      '<select data-subject-index="' + index + '"' + disabled + ">" + subjectOptionsHtml(it.subject || "") + "</select></label>" +
      fieldRow("孩子答案", it.userAnswer) +
      fieldRow("参考答案", it.correctAnswer) +
      fieldRow("解析", it.reasoning) +
      '<div class="ti-photo-revise">' +
      '<input type="text" maxlength="200" data-revise-index="' + index + '"' + disabled +
      ' placeholder="要改哪里？例如：学科改成语文" />' +
      '<button type="button" data-revise-btn="' + index + '"' + disabled + ">AI 改</button>" +
      "</div>" +
      (it.error ? '<div class="ti-photo-item-error">' + escapeHtml(it.error) + "</div>" : "") +
      '<button type="button" class="ti-photo-confirm" data-confirm-index="' + index + '"' + disabled + ">记录这条</button>" +
      "</div>"
    );
  }

  /** Body for POST /items/:index/revise; null when the instruction is invalid. */
  function buildReviseBody(instruction) {
    var text = str(instruction);
    if (!text || text.length > 200) return null;
    return { instruction: text };
  }

  // Same 502-flake pattern as text-intake's organizeWithRetry: absorb one
  // transient failure so the parent doesn't have to re-tap AI 改.
  async function reviseWithRetry(fetchFn, draftId, index, body) {
    var url = "/api/mistake-photo/" + encodeURIComponent(draftId) + "/items/" + index + "/revise";
    try {
      return await fetchFn(url, { method: "POST", body: body });
    } catch {
      return await fetchFn(url, { method: "POST", body: body });
    }
  }

  /** Server error copy from a JSON error body, else the fallback. */
  function errorText(err, fallback) {
    try {
      var parsed = JSON.parse(err && err.text);
      if (parsed && parsed.error) return parsed.error;
    } catch { /* not a JSON error body */ }
    return fallback;
  }

  window.BuddyPhotoItems = {
    SUBJECTS: SUBJECTS,
    SUBJECT_LABELS: SUBJECT_LABELS,
    escapeHtml: escapeHtml,
    normalizeItem: normalizeItem,
    extractItems: extractItems,
    subjectOptionsHtml: subjectOptionsHtml,
    renderItemCard: renderItemCard,
    buildReviseBody: buildReviseBody,
    reviseWithRetry: reviseWithRetry,
    errorText: errorText,
  };
})();

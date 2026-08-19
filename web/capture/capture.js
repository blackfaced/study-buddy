// web/capture/capture.js
// =====================================================================
// 手动录入 + 今日待订正 (SB124-T03 #127).
// =====================================================================
// Two views share the same page:
//   1. Manual entry form (POST /api/capture/manual)
//   2. Inbox list       (GET  /api/capture/inbox)
//
// After a successful create, the inbox is reloaded so the new case
// appears in the list immediately. The form is then reset for the
// next entry. Cancel resets the form without submitting.
// =====================================================================

const FORM = document.getElementById("manual-form");
const STATUS = document.getElementById("form-status");
const INBOX = document.getElementById("inbox-list");
const COUNT = document.getElementById("inbox-count");
const SUBMIT = document.getElementById("submit-btn");
const CANCEL = document.getElementById("cancel-btn");

const SUBJECT_LABELS = { math: "数学", chinese: "语文", english: "英语" };

// Form submit — POST to /api/capture/manual, then refresh inbox.
FORM.addEventListener("submit", async (e) => {
  e.preventDefault();
  setStatus("", null);
  const fd = new FormData(FORM);
  const body = {
    problem: String(fd.get("problem") || "").trim(),
    userAnswer: String(fd.get("userAnswer") || "").trim(),
    correctAnswer: String(fd.get("correctAnswer") || "").trim(),
    subject: String(fd.get("subject") || "").trim(),
    errorType: String(fd.get("errorType") || "").trim() || null,
  };
  // Client-side guard mirrors the server contract: required fields
  // must be non-empty. The server is still the source of truth.
  for (const [key, value] of Object.entries(body)) {
    if (key === "errorType") continue;
    if (!value) {
      setStatus(`${fieldLabel(key)} 不能为空`, "error");
      return;
    }
  }
  SUBMIT.disabled = true;
  try {
    const res = await fetch("/api/capture/manual", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await safeJson(res);
      setStatus(err?.error || `提交失败 (${res.status})`, "error");
      return;
    }
    const out = await res.json();
    setStatus(`已录入 ✓ (错题 #${out.id})`, "success");
    FORM.reset();
    await loadInbox();
  } catch (e) {
    setStatus("网络错误,请重试", "error");
  } finally {
    SUBMIT.disabled = false;
  }
});

// Cancel button just resets the form (no API call).
CANCEL.addEventListener("click", () => {
  FORM.reset();
  setStatus("", null);
});

async function loadInbox() {
  try {
    const res = await fetch("/api/capture/inbox");
    if (!res.ok) {
      INBOX.innerHTML = `<li class="inbox-empty">收件箱加载失败 (${res.status})</li>`;
      return;
    }
    const { cases } = await res.json();
    if (!cases || cases.length === 0) {
      INBOX.innerHTML = `<li class="inbox-empty">今天还没有待订正的错题</li>`;
      COUNT.textContent = "0";
      return;
    }
    INBOX.innerHTML = cases.map(renderInboxEntry).join("");
    COUNT.textContent = String(cases.length);
  } catch {
    INBOX.innerHTML = `<li class="inbox-empty">收件箱加载失败</li>`;
  }
}

function renderInboxEntry(c) {
  const subject = c.subject ? SUBJECT_LABELS[c.subject] || c.subject : "未分科";
  const source = c.source || "game";
  const errorType = c.errorType ? ` · ${escapeHtml(c.errorType)}` : "";
  // The whole entry is a link to the review workspace (SB124-T05 #129).
  // childId is hardcoded to "default" for now — v0.1 has no multi-child
  // picker on the inbox page (the /buddy/ PIN gate already scoped
  // the request to one kid). The review workspace reads childId from
  // the URL and falls back to "default" if missing.
  const reviewUrl = `/review/?caseId=${encodeURIComponent(c.caseId)}&childId=default`;
  return `
    <li class="inbox-entry">
      <a class="inbox-link" href="${reviewUrl}">
        <div>${escapeHtml(c.problem || "(无题目)")}</div>
        <div class="meta">
          <span class="pill" data-source="${escapeAttr(source)}">${escapeHtml(source)}</span>
          <span>${escapeHtml(subject)}</span>
          <span>订正 ${c.reviewedCount}/3</span>
          ${errorType}
        </div>
        <span class="open-hint" aria-hidden="true">订正 ›</span>
      </a>
    </li>
  `;
}

function setStatus(text, tone) {
  STATUS.textContent = text;
  if (tone) STATUS.setAttribute("data-tone", tone);
  else STATUS.removeAttribute("data-tone");
}

function fieldLabel(key) {
  return { problem: "题目", userAnswer: "你写的答案", correctAnswer: "正确答案", subject: "学科" }[key] || key;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) {
  return escapeHtml(s);
}
async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

loadInbox();

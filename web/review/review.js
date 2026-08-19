// web/review/review.js
// =====================================================================
// 订正工作台 (SB124-T05 #129).
// =====================================================================
// The kid opens a Mistake Case from the inbox, sees the problem +
// their original wrong answer + the correct answer, and re-solves
// independently. First correct closes the obligation; wrong attempts
// stay open but are appended to the timeline.
//
// URL: /review/?caseId=case:...&childId=default
// =====================================================================

const ROOT = document.getElementById("root");
const BACK = document.getElementById("back-link");
const LOADING = document.getElementById("loading");

const SUBJECT_LABELS = { math: "数学", chinese: "语文", english: "英语" };
const KIND_LABELS = { original: "原始错题", correction: "你的订正" };

const params = new URLSearchParams(location.search);
const caseId = params.get("caseId") || "";
const childId = params.get("childId") || "default";

if (!caseId) {
  ROOT.innerHTML = `<p class="error-msg">缺少 caseId 参数。请从<a href="/capture/">收件箱</a>进入。</p>`;
} else {
  loadCase();
}

async function loadCase() {
  try {
    const res = await fetch(`/api/capture/case/${encodeURIComponent(caseId)}?childId=${encodeURIComponent(childId)}`);
    if (!res.ok) {
      const err = await safeJson(res);
      const msg = err?.error || `加载失败 (${res.status})`;
      ROOT.innerHTML = `<p class="error-msg">${escapeHtml(msg)}</p>`;
      return;
    }
    const data = await res.json();
    renderCase(data);
  } catch {
    ROOT.innerHTML = `<p class="error-msg">网络错误,请重试</p>`;
  }
}

function renderCase(c) {
  LOADING.remove();
  const subject = c.subject ? (SUBJECT_LABELS[c.subject] || c.subject) : "未分科";
  const isClosed = c.obligationStatus !== "open";
  const html = `
    <section class="card" aria-label="错题内容">
      <div class="case-header">
        <span class="pill" data-source="${escapeAttr(c.source)}">${escapeHtml(c.source)}</span>
        <span class="pill">${escapeHtml(subject)}</span>
      </div>
      <h2>题目</h2>
      <div class="problem">${escapeHtml(c.problem || "(无题目)")}</div>
      <div class="meta">
        <div class="meta-row wrong">
          <span class="label">你之前写的:</span>
          <span class="value">${escapeHtml(c.userAnswer ?? "—")}</span>
        </div>
        <div class="meta-row correct">
          <span class="label">正确答案:</span>
          <span class="value">${escapeHtml(c.correctAnswer ?? "—")}</span>
        </div>
        ${c.errorType ? `
        <div class="meta-row">
          <span class="label">错因:</span>
          <span class="value">${escapeHtml(c.errorType)}</span>
        </div>` : ""}
      </div>
    </section>

    ${isClosed ? `
    <div class="closed-banner" role="status">
      ✓ 已订正完成 — 这个错题已关闭,不可再次提交
    </div>` : `
    <section class="card" aria-label="你的订正">
      <h2>你的订正</h2>
      <form class="form" id="attempt-form" novalidate>
        <label>
          你的答案
          <input id="answer" name="answer" required maxlength="200" placeholder="在这里输入你的答案">
        </label>
        <div class="actions">
          <button class="btn btn-primary" type="submit" id="submit-btn">提交订正</button>
        </div>
        <div class="status" id="form-status" role="status" aria-live="polite"></div>
      </form>
    </section>`}

    <section class="card" aria-label="时间线">
      <h2>时间线 (${c.attempts.length} 次尝试)</h2>
      <ul class="timeline">
        ${c.attempts.map(renderAttempt).join("")}
      </ul>
    </section>
  `;
  ROOT.innerHTML = html;
  if (!isClosed) {
    const form = document.getElementById("attempt-form");
    form.addEventListener("submit", submitAttempt);
  }
}

function renderAttempt(a) {
  const icon = a.isCorrect ? "✓" : "✗";
  const cls = a.kind === "original" ? "original" : a.isCorrect ? "correct" : "wrong";
  const when = new Date(a.occurredAt).toLocaleString();
  const userAns = a.userAnswer ?? "—";
  const kindLabel = KIND_LABELS[a.kind] || a.kind;
  return `
    <li class="${cls}">
      <span class="icon">${icon}</span>
      <span><b>${escapeHtml(kindLabel)}</b>: ${escapeHtml(userAns)}</span>
      <span class="when">${escapeHtml(when)}</span>
    </li>
  `;
}

async function submitAttempt(e) {
  e.preventDefault();
  const status = document.getElementById("form-status");
  const submit = document.getElementById("submit-btn");
  const answer = (document.getElementById("answer").value || "").trim();
  if (!answer) {
    setStatus(status, "答案不能为空", "error");
    return;
  }
  submit.disabled = true;
  try {
    const res = await fetch(`/api/capture/case/${encodeURIComponent(caseId)}/attempt`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ childId, answer }),
    });
    const data = await safeJson(res);
    if (!res.ok) {
      setStatus(status, data?.error || `提交失败 (${res.status})`, "error");
      submit.disabled = false;
      return;
    }
    if (data.isCorrect) {
      setStatus(status, "🎉 答对了!这道题已订正完成", "success");
    } else {
      setStatus(status, "再想想,可以再看一眼答案再试", "error");
    }
    // Reload the case to refresh the timeline + close banner
    setTimeout(() => loadCase(), 800);
  } catch {
    setStatus(status, "网络错误,请重试", "error");
    submit.disabled = false;
  }
}

function setStatus(node, text, tone) {
  node.textContent = text;
  if (tone) node.setAttribute("data-tone", tone);
  else node.removeAttribute("data-tone");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function escapeAttr(s) { return escapeHtml(s); }
async function safeJson(res) {
  try { return await res.json(); } catch { return null; }
}

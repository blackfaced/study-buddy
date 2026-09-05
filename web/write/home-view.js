// web/write/home-view.js
// =====================================================================
// Home view module — extracted from client.js (refactor PR 8).
// =====================================================================
//
// Owns the home view: the word-library list, the add-chars input,
// and the "start practice" button. The rest of client.js (the
// practice view) only knows about the library via the session
// module — it doesn't care how the list got there.
//
// Public API:
//   attachHomeView({ dom, api, fetch, createNode, onLibraryLoaded, onStart })
//     .renderLibrary(words)  — paint the word cells, enable/disable start
//     .loadLibrary()        — fetch + render
//     .addChars()           — POST new chars from the input
//
// The DOM is passed in (not grabbed with document.getElementById)
// so the module is testable with hand-rolled fakes. The fetch is
// also injected — production uses window.StudyBuddy.fetch
// (added in PR #61), tests pass a stub. createNode is injected so
// tests can hand-roll Node-shape fakes; production defaults to
// document.createElement. (Refactor regression fix: the original
// renderLibrary built plain {tagName, className, ...} literals and
// called wordList.appendChild, which throws on the real DOM. The
// fix routes every node construction through createNode.)
// =====================================================================

/** Default: browser's document.createElement. Tests inject a fake
 *  that returns Node-shape objects (see home-view.test.js). */
function defaultCreateNode(tag) {
  if (typeof document === "undefined" || typeof document.createElement !== "function") {
    throw new Error("home-view: no document available; pass createNode explicitly");
  }
  return document.createElement(tag);
}

export function attachHomeView({ dom, api, fetch, createNode, onLibraryLoaded, onStart }) {
  const { wordList, startBtn, charsInput, homeError } = dom;
  const _createNode = createNode || defaultCreateNode;
  // Multi-select state: which chars the kid has checked. Re-rendering
  // a new library preserves the selection for any char that's still
  // present (keyed by the char itself, not the cell index).
  const selected = new Set();

  function refreshStartBtn() {
    const n = selected.size;
    startBtn.disabled = n === 0;
    startBtn.textContent = n === 0 ? "开始练" : `开始练 (${n} 个字)`;
  }

  function renderLibrary(library) {
    wordList.innerHTML = "";
    // Drop any selected chars that aren't in the new library — a
    // deleted char shouldn't stay "checked" in our state.
    const inNew = new Set(library.map((w) => w.char));
    for (const c of [...selected]) if (!inNew.has(c)) selected.delete(c);
    for (const w of library) {
      const cell = _createNode("div");
      cell.className = "word-cell";
      cell.title = `练过 ${w.attemptCount} 次`;
      const cb = _createNode("input");
      cb.type = "checkbox";
      // Tag the checkbox with the char it represents. We use a direct
      // property (not dataset, which the test's plain-object fake
      // doesn't implement) so getSelected can look it up later.
      cb.char = w.char;
      cb.checked = selected.has(w.char);
      // The change handler reads `this.checked` off the DOM node we
      // just built, so the test's "simulate a click" pattern (set
      // checked = true, call onchange) works without touching the
      // native HTMLInputElement prototype.
      cb.onchange = function () { onToggle(w.char, this.checked); };
      cell.appendChild(cb);
      const ch = _createNode("span");
      ch.textContent = w.char;
      cell.appendChild(ch);
      if (w.attemptCount > 0) {
        const c = _createNode("span");
        c.className = "attempts";
        c.textContent = `×${w.attemptCount}`;
        cell.appendChild(c);
      }
      const del = _createNode("button");
      del.textContent = "×";
      del.title = `删 "${w.char}"`;
      del.onclick = async () => {
        if (!confirm(`确定删 "${w.char}" 吗？历史练习也会一起删。`)) return;
        try {
          await fetch(api + "/words/" + encodeURIComponent(w.char), { method: "DELETE" });
        } catch { /* ignore — loadLibrary will re-render anyway */ }
        await loadLibrary();
      };
      cell.appendChild(del);
      wordList.appendChild(cell);
    }
    refreshStartBtn();
  }

  function onToggle(char, isChecked) {
    if (isChecked) selected.add(char);
    else selected.delete(char);
    refreshStartBtn();
  }

  function getSelected() {
    // Preserve the order in which the chars appear in the rendered
    // library, not the order in which the kid clicked (so the practice
    // session is deterministic across re-clicks). We key the cell
    // lookup by the checkbox's `char` property instead of fragile
    // DOM order (a checkbox's nextSibling could be an "attempts" label
    // if the char has been practiced, not the char span itself).
    // Array.from: a real HTMLCollection has no .map/.find — calling
    // them threw in the browser and made 开始练 a dead button, while
    // the array-based test fakes never noticed.
    const checked = Array.from(wordList.children)
      .map((cell) => Array.from(cell.children).find((c) => c.tagName === "input" && c.checked))
      .filter(Boolean)
      .map((cb) => cb.char);
    return checked.length > 0 ? checked : [...selected];
  }

  // Issue #80: homeError wears .error-msg by default (red), so even
  // success-style text like "新增 N 个" looked scary to a kid. The
  // success state uses .success-msg (green) instead. The wrapper
  // also resets the class so a stale success line doesn't bleed
  // into the next attempt.
  function setError(text, kind) {
    homeError.textContent = text;
    homeError.className = kind === "success" ? "success-msg" : "error-msg";
  }

  function clearError() {
    homeError.textContent = "";
    homeError.className = "";
  }

  async function loadLibrary() {
    try {
      const data = await fetch(api + "/words");
      const words = (data && data.words) || [];
      renderLibrary(words);
      if (onLibraryLoaded) onLibraryLoaded(words);
    } catch (e) {
      // Surface the real error so the user can tell cert/network/4xx/5xx
      // apart instead of seeing a generic "加载字库失败" every time.
      const msg = e && e.message ? e.message : String(e);
      setError(`加载字库失败: ${msg}`, "error");
    }
  }

  async function addChars() {
    clearError();
    const chars = charsInput.value.trim();
    if (!chars) {
      setError("请输入要练的字", "error");
      return;
    }
    try {
      const r = await fetch(api + "/words", {
        method: "POST",
        body: { chars, addedBy: "parent" },
      });
      charsInput.value = "";
      if (r.added === 0) {
        setError("没有新增（可能都是重复字或非汉字）", "error");
      } else if (r.skipped > 0) {
        // "added some, skipped some" — green, not red. Kid added a
        // new char, that's a success. The skipped count is info,
        // not a failure.
        setError(`✓ 新增 ${r.added} 个，跳过 ${r.skipped} 个重复`, "success");
      }
      // Full success (added > 0, skipped === 0): leave homeError
      // empty. The cards appearing in the library is the feedback.
      await loadLibrary();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      setError(`添加失败: ${msg}`, "error");
    }
  }

  // Issue #80: when the kid types in the input, any stale error or
  // success message from a prior attempt clears. The kid shouldn't
  // stare at a red "没有新增" while composing the next batch.
  // Returned as `_onInput` so the production wiring (client.js) can
  // attach it to the input's 'input' event.
  function _onInput() {
    clearError();
  }

  return { renderLibrary, loadLibrary, addChars, _onInput, getSelected };
}

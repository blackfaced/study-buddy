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

  function renderLibrary(library) {
    wordList.innerHTML = "";
    for (const w of library) {
      const cell = _createNode("div");
      cell.className = "word-cell";
      cell.title = `练过 ${w.attemptCount} 次`;
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
    startBtn.disabled = library.length === 0;
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
      homeError.textContent = `加载字库失败: ${msg}`;
    }
  }

  async function addChars() {
    homeError.textContent = "";
    const chars = charsInput.value.trim();
    if (!chars) {
      homeError.textContent = "请输入要练的字";
      return;
    }
    try {
      const r = await fetch(api + "/words", {
        method: "POST",
        body: { chars, addedBy: "parent" },
      });
      charsInput.value = "";
      if (r.added === 0) {
        homeError.textContent = "没有新增（可能都是重复字或非汉字）";
      } else if (r.skipped > 0) {
        homeError.textContent = `新增 ${r.added} 个，跳过 ${r.skipped} 个重复`;
      }
      await loadLibrary();
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      homeError.textContent = `添加失败: ${msg}`;
    }
  }

  return { renderLibrary, loadLibrary, addChars };
}

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
//   attachHomeView({ dom, api, fetch, onLibraryLoaded, onStart })
//     .renderLibrary(words)  — paint the word cells, enable/disable start
//     .loadLibrary()        — fetch + render
//     .addChars()           — POST new chars from the input
//
// The DOM is passed in (not grabbed with document.getElementById)
// so the module is testable with hand-rolled fakes. The fetch is
// also injected — production uses window.StudyBuddy.fetch
// (added in PR #61), tests pass a stub.
// =====================================================================

export function attachHomeView({ dom, api, fetch, onLibraryLoaded, onStart }) {
  const { wordList, startBtn, charsInput, homeError } = dom;

  function renderLibrary(library) {
    wordList.innerHTML = "";
    for (const w of library) {
      const cell = { tagName: "div", className: "word-cell", title: `练过 ${w.attemptCount} 次`, children: [] };
      const ch = { tagName: "span", textContent: w.char };
      cell.children.push(ch);
      if (w.attemptCount > 0) {
        const c = { tagName: "span", className: "attempts", textContent: `×${w.attemptCount}` };
        cell.children.push(c);
      }
      const del = {
        tagName: "button",
        textContent: "×",
        title: `删 "${w.char}"`,
        onclick: async () => {
          if (!confirm(`确定删 "${w.char}" 吗？历史练习也会一起删。`)) return;
          try {
            await fetch(api + "/words/" + encodeURIComponent(w.char), { method: "DELETE" });
          } catch { /* ignore — loadLibrary will re-render anyway */ }
          await loadLibrary();
        },
      };
      cell.children.push(del);
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
    } catch {
      homeError.textContent = "加载字库失败";
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
    } catch {
      homeError.textContent = "添加失败";
    }
  }

  return { renderLibrary, loadLibrary, addChars };
}

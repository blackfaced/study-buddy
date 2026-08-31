// web/write/dictation-view.js
// =====================================================================
// Dictation mode DOM renderer (issue #196). One function: paint the
// practice-view elements for the current dictation session state.
//
// The AC1 rule lives here: `session.visibleText()` is the ONLY source
// of target text, and it returns null before submit — so this renderer
// structurally cannot leak the answer early. The reveal area is also
// display:none until revealed.
//
// Public API:
//   renderDictation({ dom, session, createNode })
//     dom: { progressHeader, status, reveal, hanziTarget,
//            replayBtn, undoBtn, submitBtn, nextBtn,
//            againBtn, retryBtn, prevBtn }
// =====================================================================

const KIND_LABEL = { word: "词", sentence: "句子" };

function show(el, visible) {
  el.style.display = visible ? "" : "none";
}

export function renderDictation({ dom, session, createNode }) {
  const phase = session.phase;
  const item = session.current();

  // Dictation never shows the HanziWriter reference (AC1: the target
  // stays hidden until the kid submits).
  dom.hanziTarget.style.display = "none";

  if (phase === "done") {
    dom.progressHeader.textContent = "";
    dom.status.textContent = "默写完成！🎉";
    show(dom.reveal, false);
    for (const btn of [dom.replayBtn, dom.undoBtn, dom.submitBtn, dom.nextBtn,
                       dom.againBtn, dom.retryBtn, dom.prevBtn]) {
      show(btn, false);
    }
    return;
  }

  const total = session.items.length;
  const label = KIND_LABEL[item?.kind] ?? "题";
  dom.progressHeader.textContent = `听写 第 ${session.itemIndex + 1}/${total} 题（${label}）`;

  if (phase === "answering") {
    dom.status.textContent = "仔细听 🔊 写在格子里（或纸上），写好点提交";
    show(dom.reveal, false);
    dom.reveal.innerHTML = "";
    show(dom.replayBtn, true);
    show(dom.undoBtn, true);
    show(dom.submitBtn, true);
    show(dom.nextBtn, false);
    show(dom.againBtn, false);
    show(dom.retryBtn, false);
    show(dom.prevBtn, false);
    return;
  }

  // revealed — per-char self-check comparison (AC3). The kid's ink
  // stays on the stage; the target appears below it, one char per box.
  dom.status.textContent = "对照一下，一样吗？";
  dom.reveal.innerHTML = "";
  const text = session.visibleText() ?? "";
  for (const ch of text) {
    const box = createNode("span");
    box.className = "dictation-reveal-char";
    box.textContent = ch;
    dom.reveal.appendChild(box);
  }
  show(dom.reveal, true);
  show(dom.replayBtn, false);
  show(dom.undoBtn, false);
  show(dom.submitBtn, false);
  show(dom.nextBtn, true);
  show(dom.againBtn, false);
  show(dom.retryBtn, false);
  show(dom.prevBtn, false);
}

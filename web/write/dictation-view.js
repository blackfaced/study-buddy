// web/write/dictation-view.js
// =====================================================================
// Dictation mode DOM renderer (issue #196 + #197 outcome confirmation).
// One function: paint the practice-view elements for the current
// dictation session state.
//
// The AC1 rule lives here: `session.visibleText()` is the ONLY source
// of target text, and it returns null before submit — so this renderer
// structurally cannot leak the answer early. The reveal area is also
// display:none until revealed.
//
// #197: the revealed phase shows the outcome-confirmation row
// (✓ 写对了 / ✗ 写错了 / 🔤 拼音错 + ✍️ 字丑 toggle); 下一题 stays
// disabled until the language outcome is chosen. At done, 提交结果
// appears only when every item is confirmed.
//
// Public API:
//   renderDictation({ dom, session, createNode })
//     dom: { progressHeader, status, reveal, hanziTarget,
//            replayBtn, undoBtn, submitBtn, nextBtn,
//            againBtn, retryBtn, prevBtn,
//            outcomeRow, outcomeCorrect, outcomeWrong, outcomePinyin,
//            outcomePoor }
// =====================================================================

const KIND_LABEL = { word: "词", sentence: "句子" };

function show(el, visible) {
  el.style.display = visible ? "" : "none";
}

function markSelected(el, selected) {
  if (selected) el.classList.add("selected");
  else el.classList.remove("selected");
}

export function renderDictation({ dom, session, createNode }) {
  const phase = session.phase;
  const item = session.current();
  if (item?.kind === "sentence")
    dom.reveal.classList.add("dictation-reveal-sentence");
  else dom.reveal.classList.remove("dictation-reveal-sentence");

  // Dictation never shows the HanziWriter reference (AC1: the target
  // stays hidden until the kid submits).
  dom.hanziTarget.style.display = "none";

  if (phase === "done") {
    dom.progressHeader.textContent = "";
    show(dom.reveal, false);
    show(dom.outcomeRow, false);
    for (const btn of [
      dom.replayBtn,
      dom.undoBtn,
      dom.nextBtn,
      dom.againBtn,
      dom.retryBtn,
      dom.prevBtn,
    ]) {
      show(btn, false);
    }
    // #197: done = all items compared. The final 提交结果 posts the
    // confirmed outcomes; it appears only when every item has one.
    if (session.allConfirmed()) {
      dom.status.textContent = "都写完了！点「提交结果」记下来";
      dom.submitBtn.textContent = "提交结果";
      show(dom.submitBtn, true);
    } else {
      dom.status.textContent = "默写完成！🎉";
      show(dom.submitBtn, false);
    }
    return;
  }

  const total = session.items.length;
  const label = KIND_LABEL[item?.kind] ?? "题";
  dom.progressHeader.textContent = `听写 第 ${session.itemIndex + 1}/${total} 题（${label}）`;

  if (phase === "answering") {
    dom.status.textContent =
      item.kind === "sentence"
        ? "仔细听 🔊 写在横线上，可以换行（或写在纸上），写好点提交"
        : "仔细听 🔊 每个格子写一个字（或写在纸上），写好点提交";
    show(dom.reveal, false);
    dom.reveal.innerHTML = "";
    show(dom.outcomeRow, false);
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
  if (item.kind === "sentence") {
    dom.reveal.textContent = text;
  } else {
    for (const ch of text) {
      const box = createNode("span");
      box.className = "dictation-reveal-char";
      box.textContent = ch;
      dom.reveal.appendChild(box);
    }
  }
  show(dom.reveal, true);
  show(dom.replayBtn, false);
  show(dom.undoBtn, false);
  show(dom.submitBtn, false);
  show(dom.nextBtn, true);
  show(dom.againBtn, false);
  show(dom.retryBtn, false);
  show(dom.prevBtn, false);

  // #197: outcome confirmation. 下一题 unlocks only after the language
  // outcome is chosen — the submission needs every item confirmed.
  show(dom.outcomeRow, true);
  markSelected(dom.outcomeCorrect, item?.language === "correct");
  markSelected(dom.outcomeWrong, item?.language === "wrong");
  markSelected(dom.outcomePinyin, item?.language === "pinyin");
  markSelected(dom.outcomePoor, item?.handwriting === "poor");
  dom.nextBtn.disabled = !item?.language;
}

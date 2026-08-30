// web/buddy/photo-only.js
// Photo-only mode for /buddy/ (env BUDDY_CHAT_ENABLED=false).
//
// Product call: the kid was free-chatting with the buddy and parents
// pushed back, so the chat UI gets hidden. Photo capture (拍错题) must
// stay — it is the mistake ledger's biggest intake source. Nothing is
// deleted: the chat DOM/code stays in place, only hidden, so flipping
// the env back restores the full buddy.
//
// Classic script, exposes window.BuddyPhotoOnly. Loaded by both
// web/buddy/index.html (applyPhotoOnlyMode) and web/index.html
// (portalEntry).
(function () {
  /**
   * Hide the chat UI and flag the app root so CSS can make the 📷
   * button the prominent, centered action. Keeps #photo-btn, .btn-row
   * (翻转/写完啦), the header and the camera preview untouched.
   *
   * @param {{app: Element, chat: Element, input: Element, sendBtn: Element}} els
   */
  function applyPhotoOnlyMode(els) {
    els.app.classList.add("photo-only");
    els.chat.style.display = "none";
    els.input.style.display = "none";
    els.sendBtn.style.display = "none";
  }

  /**
   * Portal entry copy for the buddy link. Returns null when chat is
   * enabled so the portal keeps its static "小书童陪伴" markup.
   *
   * @param {boolean} chatEnabled
   * @returns {{emoji: string, title: string, desc: string} | null}
   */
  function portalEntry(chatEnabled) {
    if (chatEnabled) return null;
    return { emoji: "📷", title: "拍错题", desc: "把做错的题拍下来" };
  }

  window.BuddyPhotoOnly = { applyPhotoOnlyMode, portalEntry };
})();

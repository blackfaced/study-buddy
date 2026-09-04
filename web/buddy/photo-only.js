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
  // Kid-facing copy in photo-only mode. The chat branding (小书童) must
  // not leak through: the portal entry says 拍错题, so the page, the PIN
  // gate and the camera-permission prompt all speak photo capture.
  var COPY = {
    title: "拍错题",
    name: "拍错题",
    avatar: "📷",
    pinHint: "拍错题要大人先开个门",
    permTitle: "拍错题要用摄像头",
    permHint: "需要打开摄像头才能拍题哦",
    photoStatus: "确认清楚后，点「分析题目」。",
    serverTitle: "连不上服务器",
  };

  function setText(el, text) {
    if (el) el.textContent = text;
  }

  function hide(el) {
    if (el) el.style.display = "none";
  }

  /**
   * Hide the chat UI, flag the app root so CSS can make the 📷 button
   * the prominent centered action, and swap the chat-era branding for
   * 拍错题 copy. Keeps #photo-btn and #flip-btn (aiming the rear camera
   * at a worksheet needs it); hides #video-toggle (homework posture
   * loop) and #end-btn (chat-session teardown). All element lookups are
   * optional so a minimal caller never crashes.
   *
   * @param {{app: Element, chat: Element, input: Element, sendBtn: Element,
   *   videoToggle?: Element, endBtn?: Element, name?: Element,
   *   avatar?: Element, pinHint?: Element, permTitle?: Element,
   *   permHint?: Element, photoStatus?: Element, serverTitle?: Element,
   *   doc?: Document}} els
   */
  function applyPhotoOnlyMode(els) {
    els.app.classList.add("photo-only");
    hide(els.chat);
    hide(els.input);
    hide(els.sendBtn);
    hide(els.videoToggle);
    hide(els.endBtn);

    setText(els.name, COPY.name);
    setText(els.avatar, COPY.avatar);
    setText(els.pinHint, COPY.pinHint);
    setText(els.permTitle, COPY.permTitle);
    setText(els.permHint, COPY.permHint);
    setText(els.photoStatus, COPY.photoStatus);
    setText(els.serverTitle, COPY.serverTitle);
    if (els.doc) els.doc.title = COPY.title;
  }

  /**
   * Portal entry copy for the buddy link. Returns null when chat is
   * enabled so the portal keeps its static "小书童陪伴" markup.
   *
   * @param {boolean} chatEnabled
   * @returns {{emoji: string, title: string, desc: string} | null}
   */
  function portalEntry(chatEnabled) {
    // Strict === false: an old server without the field (undefined)
    // must keep the default static copy.
    if (chatEnabled !== false) return null;
    return { emoji: "📷", title: "拍错题", desc: "把做错的题拍下来" };
  }

  window.BuddyPhotoOnly = { applyPhotoOnlyMode, portalEntry };
})();

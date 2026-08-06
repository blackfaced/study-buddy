// web/write/home-view.test.js
//
// Tests for the home-view module extracted from client.js (PR 8 of
// the refactor series). The module owns:
//   - loadLibrary()  — fetch the word list from the server
//   - renderLibrary() — paint the word cells + enable/disable start
//   - addChars()      — POST new chars from the input
//   - bindHomeEvents() — wire up the add-btn click + Enter key
//
// We test the pure logic (no DOM): the "library has items /
// doesn't" decisions, the start button enable rule, and the
// "input empty → error" rule. The DOM-painting is verified
// end-to-end via the existing Playwright verify scripts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachHomeView } from "./home-view.js";

/** Build a fake DOM container with the bits home-view touches. The
 *  fake appendChild enforces Node-shape the same way the real DOM
 *  does, so renderLibrary can't pass plain objects (regression:
 *  PR #70's refactor wrote `{tagName, className, ...}` literals
 *  and called appendChild, which throws on the real DOM but the
 *  old fake silently accepted). */
function makeFakeNode(tag = "div") {
  return { tagName: tag, nodeType: 1, children: [], textContent: "" };
}
function makeDom() {
  const wordList = {
    innerHTML: "",
    children: [],
    appendChild(c) {
      if (!c || typeof c.nodeType !== "number" || typeof c.appendChild !== "function") {
        throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
      }
      this.children.push(c);
    },
  };
  const startBtn = { disabled: true };
  const charsInput = { value: "" };
  const homeError = { textContent: "" };
  const addBtn = { onclick: null };
  return { wordList, startBtn, charsInput, homeError, addBtn };
}

/** A fake createNode that returns a proper Node-shape (mimics
 *  document.createElement). Tests pass this in via the createNode
 *  dependency; production uses document.createElement by default. */
function makeFakeCreateNode() {
  const calls = [];
  function createNode(tag) {
    const node = makeFakeNode(tag);
    // wrap appendChild so that pushing to children also tracks
    // nesting, mirroring the real DOM's tree.
    const origAppend = node.appendChild;
    node.appendChild = function (c) {
      if (!c || typeof c.nodeType !== "number" || typeof c.appendChild !== "function") {
        throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
      }
      this.children.push(c);
      return c;
    };
    calls.push(tag);
    return node;
  }
  return { createNode, calls };
}

test("home-view: renderLibrary enables the start button when library has chars", () => {
  const dom = makeDom();
  const { createNode, calls } = makeFakeCreateNode();
  const calls2 = { fetchCount: 0, errorText: null };
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => ({ words: [{ char: "一", attemptCount: 0 }] }),
    onLibraryLoaded: () => { calls2.fetchCount++; },
  });
  home.renderLibrary([{ char: "一", attemptCount: 0 }]);
  assert.equal(dom.startBtn.disabled, false, "start should be enabled with 1 char");
  assert.equal(dom.wordList.children.length, 1, "should paint 1 cell");
  // 1 cell div + 1 char span + 1 delete button = 3 createNode calls
  assert.equal(calls.length, 3, "should construct div + span + button");
});

test("home-view: renderLibrary disables the start button when library is empty", () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([]);
  assert.equal(dom.startBtn.disabled, true);
  assert.equal(dom.wordList.children.length, 0);
});

test("home-view: renderLibrary shows attempt count when > 0", () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([{ char: "天", attemptCount: 3 }]);
  const cell = dom.wordList.children[0];
  assert.equal(cell.children.length, 3, "char + attempts label + delete button");
  assert.equal(cell.children[1].className, "attempts");
  assert.equal(cell.children[1].textContent, "×3");
});

test("home-view: renderLibrary does not show attempt label when count is 0", () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([{ char: "一", attemptCount: 0 }]);
  const cell = dom.wordList.children[0];
  assert.equal(cell.children.length, 2, "char + delete button (no attempts label)");
});

test("home-view: renderLibrary constructs nodes via createNode (regression — PR #70 plain-object bug)", () => {
  // Regression: PR #70's refactor built plain {tagName, className,
  // ...} literals and called wordList.appendChild(plainObject),
  // which throws on the real DOM with "parameter 1 is not of type
  // 'Node'". The fix routes every node through createNode. This
  // test asserts the dependency is actually used.
  const dom = makeDom();
  const { createNode, calls } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([
    { char: "一", attemptCount: 0 },
    { char: "韩", attemptCount: 2 },
  ]);
  // 2 cells: each has div + char span + (maybe) attempts span + delete button
  // Cell 1 (attemptCount=0): div + span + button = 3
  // Cell 2 (attemptCount=2): div + span + span + button = 4
  // Total = 7
  assert.equal(calls.length, 7, "createNode called for every node built");
  assert.equal(dom.wordList.children.length, 2, "two cells painted");
});

test("home-view: loadLibrary sets error message when fetch fails", async () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => { throw new Error("network down"); },
  });
  await home.loadLibrary();
  assert.match(dom.homeError.textContent, /加载字库失败/);
  assert.match(dom.homeError.textContent, /network down/, "should include the underlying error message so user can diagnose");
  assert.equal(dom.startBtn.disabled, true, "start should stay disabled on error");
});

test("home-view: loadLibrary surfaces a network/TypeError (real iOS / Android cert fail case)", async () => {
  // iOS Safari + Android Chrome both throw a generic TypeError
  // "Failed to fetch" when the cert isn't trusted. We need the
  // UI to show the real message, not just "加载字库失败", so the
  // user can tell the difference between cert / network / 4xx / 5xx.
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => { throw new TypeError("Failed to fetch"); },
  });
  await home.loadLibrary();
  assert.match(dom.homeError.textContent, /Failed to fetch/, "must include the real browser error");
});

test("home-view: loadLibrary surfaces HTTP error from StudyBuddy.fetch (status + text)", async () => {
  // StudyBuddy.fetch throws with err.message like
  // "StudyBuddy.fetch: /api/write/words -> 500 internal error".
  // The UI must show that, not a generic 加载字库失败.
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => {
      const e = new Error("StudyBuddy.fetch: /api/write/words -> 500 internal error");
      e.status = 500;
      throw e;
    },
  });
  await home.loadLibrary();
  assert.match(dom.homeError.textContent, /500/);
  assert.match(dom.homeError.textContent, /StudyBuddy\.fetch/);
});

test("home-view: addChars shows 'enter chars' error when input is empty", async () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  dom.charsInput.value = "   ";
  let posted = false;
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => { posted = true; return { added: 0, skipped: 0 }; },
  });
  await home.addChars();
  assert.equal(posted, false, "should NOT have called the server");
  assert.match(dom.homeError.textContent, /请输入要练的字/);
});

test("home-view: addChars calls POST and re-renders on success", async () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  dom.charsInput.value = "一二三";
  const calls = { postUrl: null, postBody: null, libraryAfterPost: null };
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async (url, opts) => {
      // The first call is the POST (has opts.body). The second
      // is the GET for loadLibrary — capture only the POST.
      if (opts && opts.method === "POST") {
        calls.postUrl = url;
        calls.postBody = opts.body;
        return { added: 3, skipped: 0 };
      }
      return { words: [] };
    },
    onLibraryLoaded: (words) => { calls.libraryAfterPost = words; },
  });
  await home.addChars();
  assert.match(calls.postUrl, /\/api\/write\/words/);
  assert.equal(calls.postBody.chars, "一二三");
  assert.equal(calls.postBody.addedBy, "parent");
  assert.deepEqual(calls.libraryAfterPost, []);
});

test("home-view: addChars shows 'no new' message when server returns added=0", async () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  dom.charsInput.value = "重复";
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => ({ added: 0, skipped: 5 }),
  });
  await home.addChars();
  assert.match(dom.homeError.textContent, /没有新增/);
});

test("home-view: addChars shows 'skipped' message when some are duplicates", async () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  dom.charsInput.value = "新字";
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => ({ added: 1, skipped: 1 }),
  });
  await home.addChars();
  assert.match(dom.homeError.textContent, /新增 1 个/);
  assert.match(dom.homeError.textContent, /跳过 1 个重复/);
  assert.match(dom.homeError.className, /success/,
    "skipped message is success-msg (green), not error-msg (red) — see issue #80");
});

// ---------------------------------------------------------------------------
// Issue #80: '没有新增' error scares the kid because the homeError text
// stays red even when the last action was a success, and a stale
// failure message from a prior attempt can still be on screen when
// the kid comes back to the home view.
// Fix:
//   1. Clear homeError on every keystroke in the input (no stale msg).
//   2. Style success vs error differently via .error-msg / .success-msg
//      classes (so '新增 N 个' isn't red).
//   3. When add is a full success (added > 0, skipped === 0), don't
//      write any text — the cards appearing is feedback enough.
// ---------------------------------------------------------------------------

test("home-view: addChars on full success leaves homeError empty (no red text scares kid)", async () => {
  // Issue #80: previously this branch left homeError untouched (text
  // ""), which is fine — but the test pins down the new rule that
  // we must NOT switch to a 'success' text. The cards appearing is
  // the feedback.
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  dom.charsInput.value = "一二三";
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => ({ added: 3, skipped: 0 }),
  });
  await home.addChars();
  assert.equal(dom.homeError.textContent, "", "no text on full success — cards are the feedback");
  assert.equal(dom.homeError.className || "", "", "no .error-msg class either");
});

test("home-view: addChars with 'skipped' message marks the homeError as success, not error", async () => {
  // The 'skipped' line ("新增 N 个，跳过 M 个") used to be styled as
  // error (red) because homeError always wore .error-msg. That's
  // terrifying for a kid who just added 1 new char. Now it's a
  // .success-msg.
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  dom.charsInput.value = "新字";
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => ({ added: 1, skipped: 1 }),
  });
  await home.addChars();
  assert.match(dom.homeError.textContent, /新增 1 个/);
  // The class must contain 'success-msg' and must NOT be the
  // pure-error 'error-msg' class. We assert by exact token, not
  // substring, so 'success-msg' (which contains the letters
  // "error-msg") doesn't trip the check.
  const tokens = dom.homeError.className.split(/\s+/);
  assert.ok(tokens.includes("success-msg"),
    "skipped-but-added message wears .success-msg");
  assert.ok(!tokens.includes("error-msg"),
    "should NOT wear the bare .error-msg class (that's the red error style)");
});

test("home-view: addChars with 'no new chars' still uses error class", async () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  dom.charsInput.value = "重复";
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => ({ added: 0, skipped: 5 }),
  });
  await home.addChars();
  assert.match(dom.homeError.textContent, /没有新增/);
  const tokens = dom.homeError.className.split(/\s+/);
  assert.ok(tokens.includes("error-msg"),
    "real 'no new' message still wears the error class");
  assert.ok(!tokens.includes("success-msg"),
    "should NOT wear success-msg — this is a real failure");
});

test("home-view: addChars stale 'no new' error from previous attempt is cleared when kid types in input", async () => {
  // Bug repro: kid adds '重复' → sees red '没有新增'. Types '上' but
  // hasn't clicked 加进去 yet. The red text is still on screen and
  // looks like the new attempt already failed.
  // Fix: typing in the input clears the stale error so the kid sees
  // a clean slate.
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({
    dom,
    api: "/api/write",
    createNode,
    fetch: async () => ({ added: 0, skipped: 5 }),
  });
  dom.charsInput.value = "重复";
  await home.addChars();
  assert.match(dom.homeError.textContent, /没有新增/, "precondition: error is shown");
  // Simulate the kid typing in the input (we expose _onInput via the
  // returned object so the production wiring can attach it to the
  // input's 'input' event).
  assert.equal(typeof home._onInput, "function", "module must expose _onInput for the input event");
  home._onInput();
  assert.equal(dom.homeError.textContent, "", "stale error cleared on input");
});

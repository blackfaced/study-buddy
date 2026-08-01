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

/** Build a fake DOM container with the bits home-view touches. */
function makeDom() {
  const wordList = { innerHTML: "", children: [], appendChild(c) { this.children.push(c); } };
  const startBtn = { disabled: true };
  const charsInput = { value: "" };
  const homeError = { textContent: "" };
  const addBtn = { onclick: null };
  return { wordList, startBtn, charsInput, homeError, addBtn };
}

test("home-view: renderLibrary enables the start button when library has chars", () => {
  const dom = makeDom();
  const calls = { fetchCount: 0, errorText: null };
  const home = attachHomeView({
    dom,
    api: "/api/write",
    fetch: async () => ({ words: [{ char: "一", attemptCount: 0 }] }),
    onLibraryLoaded: () => { calls.fetchCount++; },
  });
  home.renderLibrary([{ char: "一", attemptCount: 0 }]);
  assert.equal(dom.startBtn.disabled, false, "start should be enabled with 1 char");
  assert.equal(dom.wordList.children.length, 1, "should paint 1 cell");
});

test("home-view: renderLibrary disables the start button when library is empty", () => {
  const dom = makeDom();
  const home = attachHomeView({ dom, api: "/api/write" });
  home.renderLibrary([]);
  assert.equal(dom.startBtn.disabled, true);
  assert.equal(dom.wordList.children.length, 0);
});

test("home-view: renderLibrary shows attempt count when > 0", () => {
  const dom = makeDom();
  const home = attachHomeView({ dom, api: "/api/write" });
  home.renderLibrary([{ char: "天", attemptCount: 3 }]);
  const cell = dom.wordList.children[0];
  assert.equal(cell.children.length, 3, "char + attempts label + delete button");
  assert.equal(cell.children[1].className, "attempts");
  assert.equal(cell.children[1].textContent, "×3");
});

test("home-view: renderLibrary does not show attempt label when count is 0", () => {
  const dom = makeDom();
  const home = attachHomeView({ dom, api: "/api/write" });
  home.renderLibrary([{ char: "一", attemptCount: 0 }]);
  const cell = dom.wordList.children[0];
  assert.equal(cell.children.length, 2, "char + delete button (no attempts label)");
});

test("home-view: loadLibrary sets error message when fetch fails", async () => {
  const dom = makeDom();
  const home = attachHomeView({
    dom,
    api: "/api/write",
    fetch: async () => { throw new Error("network down"); },
  });
  await home.loadLibrary();
  assert.match(dom.homeError.textContent, /加载字库失败/);
  assert.equal(dom.startBtn.disabled, true, "start should stay disabled on error");
});

test("home-view: addChars shows 'enter chars' error when input is empty", async () => {
  const dom = makeDom();
  dom.charsInput.value = "   ";
  let posted = false;
  const home = attachHomeView({
    dom,
    api: "/api/write",
    fetch: async () => { posted = true; return { added: 0, skipped: 0 }; },
  });
  await home.addChars();
  assert.equal(posted, false, "should NOT have called the server");
  assert.match(dom.homeError.textContent, /请输入要练的字/);
});

test("home-view: addChars calls POST and re-renders on success", async () => {
  const dom = makeDom();
  dom.charsInput.value = "一二三";
  const calls = { postUrl: null, postBody: null, libraryAfterPost: null };
  const home = attachHomeView({
    dom,
    api: "/api/write",
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
  dom.charsInput.value = "重复";
  const home = attachHomeView({
    dom,
    api: "/api/write",
    fetch: async () => ({ added: 0, skipped: 5 }),
  });
  await home.addChars();
  assert.match(dom.homeError.textContent, /没有新增/);
});

test("home-view: addChars shows 'skipped' message when some are duplicates", async () => {
  const dom = makeDom();
  dom.charsInput.value = "新字";
  const home = attachHomeView({
    dom,
    api: "/api/write",
    fetch: async () => ({ added: 1, skipped: 1 }),
  });
  await home.addChars();
  assert.match(dom.homeError.textContent, /新增 1 个/);
  assert.match(dom.homeError.textContent, /跳过 1 个重复/);
});

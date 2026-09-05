// web/write/home-view-multiselect.test.js
//
// TDD for the multi-select UI on the home page (feature request 9/4:
// "kid 选几个字一起练"). Reuses the same Node-shaped fake DOM
// pattern as the existing home-view tests; multi-select is just a
// new behavior layered on top of renderLibrary + startBtn.
import { test } from "node:test";
import assert from "node:assert/strict";
import { attachHomeView } from "./home-view.js";

function makeFakeNode(tag = "div") {
  return { tagName: tag, nodeType: 1, children: [], textContent: "" };
}
function makeDom() {
  const wordList = {
    children: [],
    appendChild(c) {
      if (!c || typeof c.nodeType !== "number" || typeof c.appendChild !== "function") {
        throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
      }
      this.children.push(c);
    },
  };
  // Mirror the real DOM: assigning innerHTML replaces all children.
  // The existing home-view test file (the same pattern) defines
  // `innerHTML: ""` as a *field*, not a setter — so re-rendering
  // silently appends. Fix that here so re-render-on-addChars works.
  Object.defineProperty(wordList, "innerHTML", {
    get() { return this.children.map((c) => c.outerHTML || "").join(""); },
    set(v) {
      if (v === "") this.children.length = 0;
      else throw new TypeError("fake wordList only supports innerHTML = ''");
    },
  });
  const startBtn = { disabled: true, textContent: "开始练" };
  const charsInput = { value: "" };
  const homeError = { textContent: "" };
  const addBtn = { onclick: null };
  return { wordList, startBtn, charsInput, homeError, addBtn };
}
function makeFakeCreateNode() {
  function createNode(tag) {
    const node = makeFakeNode(tag);
    const orig = node.appendChild;
    node.appendChild = function (c) {
      if (!c || typeof c.nodeType !== "number" || typeof c.appendChild !== "function") {
        throw new TypeError("Failed to execute 'appendChild' on 'Node': parameter 1 is not of type 'Node'.");
      }
      this.children.push(c);
      return c;
    };
    return node;
  }
  return { createNode };
}

test("home-view: renderLibrary draws a checkbox on every cell, default unchecked", () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([
    { char: "房", attemptCount: 0 },
    { char: "椅", attemptCount: 0 },
  ]);
  // 2 cells: each = div + checkbox + char span + delete button = 4
  for (const cell of dom.wordList.children) {
    const cb = cell.children.find((c) => c.tagName === "input");
    assert.ok(cb, "every cell must have a checkbox input");
    assert.equal(cb.type, "checkbox");
    assert.equal(cb.checked, false, "default unchecked");
  }
});

test("home-view: clicking a cell checkbox toggles selection; startBtn label reflects count", () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([
    { char: "房", attemptCount: 0 },
    { char: "椅", attemptCount: 0 },
    { char: "饼", attemptCount: 0 },
  ]);
  // Initially nothing selected
  assert.equal(dom.startBtn.disabled, true, "no selection → disabled");
  assert.match(dom.startBtn.textContent, /开始练/);
  // Simulate the kid clicking 房's checkbox
  const roomCell = dom.wordList.children[0];
  const roomCb = roomCell.children.find((c) => c.tagName === "input");
  roomCb.checked = true;
  roomCb.onchange();
  assert.equal(dom.startBtn.disabled, false, "1 selected → enabled");
  assert.match(dom.startBtn.textContent, /1/);
  // Click 椅's too
  const chairCell = dom.wordList.children[1];
  chairCell.children.find((c) => c.tagName === "input").checked = true;
  chairCell.children.find((c) => c.tagName === "input").onchange();
  assert.match(dom.startBtn.textContent, /2/);
});

test("home-view: getSelected() returns the checked chars in the order they appear", () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([
    { char: "房", attemptCount: 0 },
    { char: "椅", attemptCount: 0 },
    { char: "饼", attemptCount: 0 },
  ]);
  // Select 椅 then 房 (not in order)
  const cells = dom.wordList.children;
  cells[1].children.find((c) => c.tagName === "input").checked = true;
  cells[1].children.find((c) => c.tagName === "input").onchange();
  cells[0].children.find((c) => c.tagName === "input").checked = true;
  cells[0].children.find((c) => c.tagName === "input").onchange();
  assert.deepEqual(home.getSelected(), ["房", "椅"], "order follows the library, not the click order");
});

test("home-view: getSelected() on empty library / no clicks returns []", () => {
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  // No renderLibrary called → no cells → empty selection
  assert.deepEqual(home.getSelected(), []);
  home.renderLibrary([{ char: "房", attemptCount: 0 }]);
  // Render but no click yet
  assert.deepEqual(home.getSelected(), []);
});

// The browser's HTMLCollection has length + indexing + iteration but
// NO .map/.find — unlike the array fakes above. This wrapper keeps the
// same nodes but strips the array methods, matching the real DOM.
function asHTMLCollection(nodes) {
  const hc = { length: nodes.length };
  nodes.forEach((n, i) => {
    hc[i] = n;
  });
  hc[Symbol.iterator] = function* () {
    yield* nodes;
  };
  return hc;
}

test("real scenario: getSelected works with a real HTMLCollection — 开始练 must not be a dead button", () => {
  // Regression (found in acceptance 9/5): kid selected two chars and
  // 开始练 did nothing — getSelected called wordList.children.map,
  // which throws "not a function" on a real HTMLCollection, aborting
  // the start handler silently.
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([
    { char: "房", attemptCount: 0 },
    { char: "椅", attemptCount: 0 },
    { char: "饼", attemptCount: 0 },
  ]);
  for (const cell of dom.wordList.children) {
    cell.children.find((c) => c.tagName === "input").checked = true;
    cell.children.find((c) => c.tagName === "input").onchange();
    // Cells' children are also HTMLCollections in the real DOM.
    cell.children = asHTMLCollection(cell.children);
  }
  dom.wordList.children = asHTMLCollection(dom.wordList.children);
  assert.deepEqual(home.getSelected(), ["房", "椅", "饼"]);
});

test("home-view: re-render preserves selection for chars still in the library", () => {
  // After kid selects 房/椅, parent deletes a different char and
  // the library re-renders. 房/椅 should stay selected (state is
  // keyed by char, survives re-render as long as the char is still
  // present).
  const dom = makeDom();
  const { createNode } = makeFakeCreateNode();
  const home = attachHomeView({ dom, api: "/api/write", createNode });
  home.renderLibrary([
    { char: "房", attemptCount: 0 },
    { char: "椅", attemptCount: 0 },
    { char: "饼", attemptCount: 0 },
  ]);
  // Select all three
  for (const cell of dom.wordList.children) {
    cell.children.find((c) => c.tagName === "input").checked = true;
    cell.children.find((c) => c.tagName === "input").onchange();
  }
  // Re-render with one char removed (addChars triggers loadLibrary
  // → renderLibrary). 房 and 椅 still selected, 饼 no longer in list.
  home.renderLibrary([
    { char: "房", attemptCount: 0 },
    { char: "椅", attemptCount: 0 },
  ]);
  assert.deepEqual(home.getSelected(), ["房", "椅"]);
  assert.equal(dom.startBtn.disabled, false, "still 2 selected");
  assert.match(dom.startBtn.textContent, /2/);
});

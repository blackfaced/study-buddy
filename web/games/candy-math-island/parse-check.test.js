// TDD test: inline script in candy-math-island/index.html must parse
// without SyntaxError. The v0.8 (#116) explanation-card change added
// `await loadExplanations()` inside submitAnswer() but did not promote
// submitAnswer to `async function`, which makes the entire inline
// <script> abort at parse time — the kid sees a dead start button.
//
// This test extracts the inline <script> body and feeds it to
// new Function(), which catches await-in-non-async-function errors
// (the same class of SyntaxError V8 throws in the browser). If the
// test fails, the kid's start button is dead.
//
// Run: node web/games/candy-math-island/parse-check.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const htmlPath = path.join(__dirname, "index.html");
const html = fs.readFileSync(htmlPath, "utf8");

// Find the *last* inline <script>...</script> block (the one that
// contains the bulk of the app logic). Earlier diagnostic <script>
// blocks from prior debugging sessions would have been removed by the
// dev, but defensively we still want to test the right one.
const scriptRe = /<script>\s*\n([\s\S]*?)\n<\/script>/g;
let match;
let inline = null;
while ((match = scriptRe.exec(html)) !== null) {
  inline = match[1];
}
if (!inline) {
  console.error("FAIL: no inline <script> block found in index.html");
  process.exit(1);
}

// Reject the "diagnostic short block" case: a real app inline script
// is hundreds of lines. Anything under 200 lines is probably a debug
// stub left behind, not the real script we care about.
if (inline.split("\n").length < 200) {
  console.error("FAIL: inline <script> is suspiciously short (" +
    inline.split("\n").length + " lines). Did the script get truncated " +
    "by a stray </script> during editing?");
  process.exit(1);
}

let parseError = null;
try {
  // new Function() runs in classic-script mode (same await-in-non-async
  // restrictions as a <script> without type="module"), which is exactly
  // the mode candy-math-island uses.
  new Function(inline);
} catch (e) {
  parseError = e;
}

if (parseError) {
  console.error("FAIL: inline <script> has SyntaxError:");
  console.error("  " + parseError.message);
  process.exit(1);
}

console.log("PASS: inline <script> parses cleanly (" +
  inline.split("\n").length + " lines)");

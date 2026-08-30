// Parse-check: the inline <script> in buddy/index.html is the app's
// main controller (PIN gate, start(), photo-only wiring). A SyntaxError
// there — e.g. `await` inside a non-async function, the v0.8 #116/#138
// class of bug — aborts the whole script silently and the kid's buttons
// go dead. Extract the inline block and feed it to new Function()
// (classic-script mode, same restrictions as a browser classic script).
//
// Run: node web/buddy/parse-check.test.js
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(__dirname, "index.html"), "utf8");

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
if (inline.split("\n").length < 200) {
  console.error("FAIL: inline <script> is suspiciously short (" +
    inline.split("\n").length + " lines). Did the script get truncated " +
    "by a stray </script> during editing?");
  process.exit(1);
}

let parseError = null;
try {
  new Function(inline);
} catch (e) {
  parseError = e;
}

if (parseError) {
  console.error("FAIL: inline <script> has SyntaxError:");
  console.error("  " + parseError.message);
  process.exit(1);
}

console.log("PASS: buddy inline <script> parses cleanly (" +
  inline.split("\n").length + " lines)");

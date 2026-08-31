#!/usr/bin/env node
// bin/feishu-reminder.js
// =====================================================================
// Standalone Feishu (Lark) custom-bot reminder sender.
//
// Usage:
//   FEISHU_WEBHOOK_URL=https://... FEISHU_WEBHOOK_SECRET=... node bin/feishu-reminder.js "提醒消息"
//
// Or with --text flag:
//   node bin/feishu-reminder.js --text "今天该做作业啦 ✏️"
//
// Exits 0 on success (HTTP 200 + StatusCode 0), 1 on any error.
// Sends a single plain-text message to the configured Feishu bot.
//
// This is the daily-reminder counterpart to the existing
// feishu-notify.ts outbox worker: where feishu-notify drains
// kid-triggered events (math mistakes, safety alerts), this
// script is for parent-scheduled nudges ("8 PM, time for
// homework").
// =====================================================================

const { createHmac } = require("node:crypto");

function parseArgs(argv) {
  const out = { text: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--text") {
      out.text = argv[i + 1];
      i += 1;
    } else if (!a.startsWith("--")) {
      // First positional = text (so `node bin/feishu-reminder.js "hi"` works)
      if (out.text === null) out.text = a;
    }
  }
  return out;
}

function signFeishu(timestamp, secret) {
  const hmac = createHmac("sha256", secret);
  hmac.update(`${timestamp}\n`);
  return hmac.digest("base64");
}

async function sendReminder({ text, url, secret }) {
  if (!url) {
    console.error("[feishu-reminder] FEISHU_WEBHOOK_URL is empty — nothing to send");
    return false;
  }
  if (!text || text.trim() === "") {
    console.error("[feishu-reminder] text is empty — nothing to send");
    return false;
  }
  const timestamp = Date.now().toString();
  const sign = signFeishu(timestamp, secret || "");
  const baseUrl = url.split("?")[0];
  const signedUrl = secret
    ? `${baseUrl}?timestamp=${encodeURIComponent(timestamp)}&sign=${encodeURIComponent(sign)}`
    : baseUrl;
  let resp;
  try {
    resp = await fetch(signedUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg_type: "text", content: { text } }),
    });
  } catch (e) {
    console.error(`[feishu-reminder] fetch failed: ${e.message}`);
    return false;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    console.error(`[feishu-reminder] HTTP ${resp.status}: ${body.slice(0, 200)}`);
    return false;
  }
  let parsed = {};
  try {
    parsed = await resp.json();
  } catch {
    return true;
  }
  const statusCode = parsed?.StatusCode ?? parsed?.code;
  if (typeof statusCode === "number" && statusCode !== 0) {
    console.error(`[feishu-reminder] StatusCode=${statusCode} ${parsed?.msg ?? ""}`);
    return false;
  }
  return true;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const text = args.text || "小宝，今天的作业做完了吗？来做几道题吧 ✏️";
  const url = process.env.FEISHU_WEBHOOK_URL || "";
  const secret = process.env.FEISHU_WEBHOOK_SECRET || "";
  const ok = await sendReminder({ text, url, secret });
  if (!ok) process.exit(1);
  console.log(`[feishu-reminder] sent: ${text.slice(0, 50)}${text.length > 50 ? "…" : ""}`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

// Exported for bin/friday-weekend-reminder.js (#195), which reuses the
// same signed-webhook sender instead of duplicating it.
module.exports = { sendReminder };

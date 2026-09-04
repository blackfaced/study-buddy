#!/usr/bin/env node
// bin/feishu-reminder.js
// =====================================================================
// Standalone Feishu (Lark) reminder sender. Two transports:
//
//   1. Custom-bot signed webhook (needs a team group bot):
//      FEISHU_WEBHOOK_URL=https://... FEISHU_WEBHOOK_SECRET=... node bin/feishu-reminder.js "提醒消息"
//   2. App bot via Open API (works with a personal-edition-created app,
//      e.g. the Mavis Feishu bot — personal accounts can't add custom bots):
//      FEISHU_APP_ID=cli_... FEISHU_APP_SECRET=... FEISHU_CHAT_ID=oc_... node bin/feishu-reminder.js "提醒消息"
//
// Webhook wins when both are configured. Or with --text flag:
//   node bin/feishu-reminder.js --text "今天该做作业啦 ✏️"
//
// Exits 0 on success (HTTP 200 + transport code/StatusCode 0), 1 on any error.
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

async function postJson(url, { headers = {}, body }) {
  let resp;
  try {
    resp = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    });
  } catch (e) {
    console.error(`[feishu-reminder] fetch failed: ${e.message}`);
    return null;
  }
  if (!resp.ok) {
    const text = await resp.text().catch(() => "");
    console.error(`[feishu-reminder] HTTP ${resp.status}: ${text.slice(0, 200)}`);
    return null;
  }
  return resp.json().catch(() => ({}));
}

// App-bot transport (reuses the Mavis Feishu app): personal-edition
// accounts cannot create custom bots, so the signed webhook is not
// always available. The app bot talks to the Open API directly —
// one tenant_access_token exchange, one im/v1/messages POST.
async function sendViaAppBot({ text, appId, appSecret, chatId }) {
  const tokenResp = await postJson(
    "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    { body: { app_id: appId, app_secret: appSecret } },
  );
  if (!tokenResp || tokenResp.code !== 0 || !tokenResp.tenant_access_token) {
    console.error(`[feishu-reminder] token failed: code=${tokenResp?.code} ${tokenResp?.msg ?? ""}`);
    return false;
  }
  const msgResp = await postJson(
    "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    {
      headers: { Authorization: `Bearer ${tokenResp.tenant_access_token}` },
      body: { receive_id: chatId, msg_type: "text", content: JSON.stringify({ text }) },
    },
  );
  if (!msgResp || msgResp.code !== 0) {
    console.error(`[feishu-reminder] send failed: code=${msgResp?.code} ${msgResp?.msg ?? ""}`);
    return false;
  }
  return true;
}

async function sendReminder({ text, url, secret, appId, appSecret, chatId }) {
  if (!text || text.trim() === "") {
    console.error("[feishu-reminder] text is empty — nothing to send");
    return false;
  }
  // Webhook wins when both are configured: it is the original transport
  // and needs no credential exchange.
  if (!url) {
    if (appId && appSecret && chatId) {
      return sendViaAppBot({ text, appId, appSecret, chatId });
    }
    console.error("[feishu-reminder] neither FEISHU_WEBHOOK_URL nor app credentials set — nothing to send");
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
  const ok = await sendReminder({
    text,
    url: process.env.FEISHU_WEBHOOK_URL || "",
    secret: process.env.FEISHU_WEBHOOK_SECRET || "",
    appId: process.env.FEISHU_APP_ID || "",
    appSecret: process.env.FEISHU_APP_SECRET || "",
    chatId: process.env.FEISHU_CHAT_ID || "",
  });
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
// same sender (webhook or app bot) instead of duplicating it.
module.exports = { sendReminder };

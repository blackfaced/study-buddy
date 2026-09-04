// bin/feishu-reminder.test.js
//
// Behavior tests for the Feishu reminder sender's two transports:
// the custom-bot signed webhook (original) and the app-bot Open API
// path (tenant_access_token + im/v1/messages) that reuses the existing
// Mavis Feishu app — personal-edition accounts cannot create custom
// bots, so the app bot is the only channel available there.
//
// Run: node --test bin/feishu-reminder.test.js

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { sendReminder } = require("./feishu-reminder.js");

const APP = {
  appId: "cli_test",
  appSecret: "secret_test",
  chatId: "oc_test_chat",
};

// Stub globalThis.fetch with a handler (url, options) → fake response,
// recording every call. Returns the calls array. Restores afterwards.
function withFetch(t, handler) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return handler(url, options);
  };
  t.after(() => {
    globalThis.fetch = original;
  });
  return calls;
}

function jsonResponse(payload, { ok = true, status = 200 } = {}) {
  return {
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

test("webhook transport unchanged: signed URL POST with text content", async (t) => {
  const calls = withFetch(t, async () => jsonResponse({ StatusCode: 0 }));
  const ok = await sendReminder({
    text: "周五提醒",
    url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
    secret: "s3cret",
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /bot\/v2\/hook\/abc\?timestamp=\d+&sign=/);
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.msg_type, "text");
  assert.equal(body.content.text, "周五提醒");
});

test("app-bot transport: fetches tenant_access_token, then posts to im/v1/messages", async (t) => {
  const calls = withFetch(t, async (url) => {
    if (url.includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "t-token", expire: 7200 });
    }
    return jsonResponse({ code: 0, msg: "success" });
  });
  const ok = await sendReminder({ text: "周五提醒", ...APP });
  assert.equal(ok, true);
  assert.equal(calls.length, 2);
  // 1. token request carries app credentials
  assert.match(calls[0].url, /auth\/v3\/tenant_access_token\/internal/);
  const tokenBody = JSON.parse(calls[0].options.body);
  assert.equal(tokenBody.app_id, APP.appId);
  assert.equal(tokenBody.app_secret, APP.appSecret);
  // 2. message goes to the chat with a Bearer token
  assert.match(calls[1].url, /im\/v1\/messages\?receive_id_type=chat_id/);
  assert.equal(calls[1].options.headers.Authorization, "Bearer t-token");
  const msgBody = JSON.parse(calls[1].options.body);
  assert.equal(msgBody.receive_id, APP.chatId);
  assert.equal(msgBody.msg_type, "text");
  assert.equal(JSON.parse(msgBody.content).text, "周五提醒");
});

test("real scenario: token rejected (bad credentials) → false, message never attempted", async (t) => {
  const calls = withFetch(t, async () =>
    jsonResponse({ code: 99991663, msg: "app access token invalid" }),
  );
  const ok = await sendReminder({ text: "hi", ...APP });
  assert.equal(ok, false);
  assert.equal(calls.length, 1, "must not try sending without a token");
});

test("app-bot message send returns non-zero code → false", async (t) => {
  withFetch(t, async (url) => {
    if (url.includes("tenant_access_token")) {
      return jsonResponse({ code: 0, tenant_access_token: "t-token" });
    }
    return jsonResponse({ code: 230002, msg: "bot is not in the chat" });
  });
  const ok = await sendReminder({ text: "hi", ...APP });
  assert.equal(ok, false);
});

test("neither webhook nor app credentials configured → false, no fetch", async (t) => {
  const calls = withFetch(t, async () => jsonResponse({ code: 0 }));
  const ok = await sendReminder({ text: "hi" });
  assert.equal(ok, false);
  assert.equal(calls.length, 0);
});

test("both transports configured → webhook wins, app credentials untouched", async (t) => {
  const calls = withFetch(t, async () => jsonResponse({ StatusCode: 0 }));
  const ok = await sendReminder({
    text: "hi",
    url: "https://open.feishu.cn/open-apis/bot/v2/hook/abc",
    secret: "",
    ...APP,
  });
  assert.equal(ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].url, /bot\/v2\/hook/);
});

test("empty text → false regardless of transport", async (t) => {
  const calls = withFetch(t, async () => jsonResponse({ code: 0 }));
  assert.equal(await sendReminder({ text: "  ", ...APP }), false);
  assert.equal(await sendReminder({ text: "", url: "https://x/hook/y" }), false);
  assert.equal(calls.length, 0);
});

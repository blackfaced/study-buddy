#!/usr/bin/env node
// bin/friday-weekend-reminder.js
// =====================================================================
// Friday 20:00 (Asia/Shanghai) weekend-review reminder (issue #195,
// part of the parent-operated loop #192).
//
// Reads the bounded parent summary (GET /api/capture/parent-summary),
// formats an aggregate-only Chinese text, and pushes it to Feishu via
// bin/feishu-reminder.js's sendReminder (custom-bot webhook or app
// bot). The message ends with exactly one question — 要不要安排周末复习？
// It only asks: it never processes materials, never generates handouts,
// and never writes any learning state (AC3 — this script performs one
// GET and one send, nothing else).
//
// Content boundary (AC2): aggregate counts + error-type labels only.
// No problem text, no images, no case ids, no child identity.
//
// Feishu unset (AC4): logs a skip line and exits 0 — cron stays quiet.
//
// Scheduling — configured on the Mac mini deploy host, NOT in this
// repo. Mavis cron example (Asia/Shanghai):
//   cron: 13 20 * * 5     # every Friday 20:13 (off the :00 herd)
//   env:  FEISHU_WEBHOOK_URL / FEISHU_WEBHOOK_SECRET  (custom bot), or
//         FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_CHAT_ID (app bot,
//         e.g. the Mavis Feishu app — personal edition has no custom bots),
//         STUDY_BUDDY_SUMMARY_URL (default http://localhost:3000/...)
// or a launchd StartCalendarInterval { Weekday=5, Hour=20, Minute=13 }.
// =====================================================================

const { sendReminder } = require("./feishu-reminder.js");

const ENDING_QUESTION = "要不要安排周末复习？";
const DEFAULT_SUMMARY_URL =
  "http://localhost:3000/api/capture/parent-summary?childId=default";

// summary = ParentSummary from server/src/parent-summary.ts.
//
// Approximations (deliberate, per #195 scope):
//   - "待周末复习" ≈ stats.pendingReplay (due, uncompleted review
//     schedules). Real weekend-review semantics belong to #198.
//   - "近 30 天新增" is the parent-summary 30-day window — the API
//     has no weekly scope yet, so the label says 30 天, not 本周.
function formatWeekendReminder(summary) {
  const s = summary.stats;
  const lines = [
    "📋 本周学习小结",
    `· 未订正：${s.pendingReview} 题`,
    `· 待周末复习：${s.pendingReplay} 题`,
    `· 近 30 天新增错题：${s.newMistakes} 题`,
  ];
  const observations = summary.recurringErrorObservations || [];
  if (observations.length > 0) {
    lines.push("高频错因：");
    for (const o of observations) {
      // Label + count only — recentCaseIds stay on the server (AC2).
      lines.push(`· ${o.errorType} ×${o.count}`);
    }
  }
  lines.push("", ENDING_QUESTION);
  return lines.join("\n");
}

async function defaultFetchJson(url) {
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`summary HTTP ${resp.status}`);
  return resp.json();
}

const consoleLogger = {
  info: (msg) => console.log(`[friday-weekend-reminder] ${msg}`),
  error: (msg) => console.error(`[friday-weekend-reminder] ${msg}`),
};

// Returns the process exit code: 0 = sent or quietly skipped, 1 = error.
async function run({
  env = process.env,
  logger = consoleLogger,
  send = sendReminder,
  fetchJson = defaultFetchJson,
} = {}) {
  const webhookUrl = env.FEISHU_WEBHOOK_URL || "";
  const appId = env.FEISHU_APP_ID || "";
  const appSecret = env.FEISHU_APP_SECRET || "";
  const chatId = env.FEISHU_CHAT_ID || "";
  // Two transports: custom-bot webhook, or app bot (the Mavis Feishu
  // app — personal-edition accounts can't create custom bots). Skip
  // only when neither is configured.
  const hasAppBot = appId && appSecret && chatId;
  if (!webhookUrl && !hasAppBot) {
    logger.info("飞书未配置（FEISHU_WEBHOOK_URL 或 FEISHU_APP_ID/SECRET/CHAT_ID），跳过本次提醒");
    return 0;
  }
  const summaryUrl = env.STUDY_BUDDY_SUMMARY_URL || DEFAULT_SUMMARY_URL;
  let summary;
  try {
    summary = await fetchJson(summaryUrl);
  } catch (e) {
    logger.error(`读取学习摘要失败：${e.message}`);
    return 1;
  }
  const text = formatWeekendReminder(summary);
  const ok = await send({
    text,
    url: webhookUrl,
    secret: env.FEISHU_WEBHOOK_SECRET || "",
    appId,
    appSecret,
    chatId,
  });
  if (!ok) {
    logger.error("飞书推送失败");
    return 1;
  }
  logger.info("周末提醒已推送");
  return 0;
}

async function main() {
  process.exitCode = await run();
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { formatWeekendReminder, run, ENDING_QUESTION };

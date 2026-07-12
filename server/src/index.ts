// src/index.ts
// Study Buddy HTTP Server
//
// 暴露给孩子手机的接口：
//   GET  /                  孩子端 HTML
//   GET  /api/health        健康检查
//   GET  /api/pair          配对信息
//   POST /api/session/start 开始写作业会话
//   POST /api/session/end   结束会话
//   POST /api/frame         接收摄像头帧（每 500ms 一次）
//   POST /api/chat          对话接口（接 MiniMax LLM）
//
// 数据通过共享 SQLite 与 MCP server 互通。
// SQLite WAL 模式支持多进程读写。

import { config as loadDotenv } from "dotenv";
import express, { type Request, type Response } from "express";
import multer from "multer";
import Database from "better-sqlite3";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import https from "node:https";
import http from "node:http";
import fs from "node:fs";
import sharp from "sharp";

// 加载 /Users/mac/study-buddy/.env（父目录）
const __dirname = dirname(fileURLToPath(import.meta.url));
loadDotenv({ path: resolve(__dirname, "../../.env") });

console.log(`[study-buddy-server] MINIMAX_API_KEY: ${process.env.MINIMAX_API_KEY ? "set (" + process.env.MINIMAX_API_KEY.length + " chars)" : "NOT SET"}`);

const ROOT = resolve(__dirname, "../..");
const WEB_DIR = join(ROOT, "web");
const DB_PATH = process.env.STUDY_DB || join(ROOT, "data/study.db");
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3000);
const HTTP_PORT = Number(process.env.HTTP_PORT || 3001);

// HTTPS 证书（自签）
const KEY_PATH = process.env.SSL_KEY || join(ROOT, "server.key");
const CERT_PATH = process.env.SSL_CERT || join(ROOT, "server.cert");
const hasCert = fs.existsSync(KEY_PATH) && fs.existsSync(CERT_PATH);
if (!hasCert) {
  console.warn(`[study-buddy-server] SSL cert missing at ${KEY_PATH} / ${CERT_PATH} — HTTPS disabled`);
}

// ============== DB 共享 ==============
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
console.log(`[study-buddy-server] DB: ${DB_PATH}`);

// ============== Express ==============
const app = express();
app.use(express.json({ limit: "1mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 500 * 1024 },  // 500KB / 帧
});

// 静态文件（孩子端 HTML）
app.use(express.static(WEB_DIR));

// ============== 健康检查 ==============
app.get("/api/health", (_req: Request, res: Response) => {
  const children = db.prepare("SELECT COUNT(*) as c FROM children").get() as any;
  const sessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get() as any;
  res.json({
    ok: true,
    service: "study-buddy",
    version: "0.1.0",
    childrenCount: children.c,
    sessionsCount: sessions.c,
    webDir: WEB_DIR,
  });
});

// ============== 配对（单孩子家庭：直接返回 default） ==============
app.get("/api/pair", (req: Request, res: Response) => {
  const child = db.prepare("SELECT * FROM children WHERE id = 'default'").get() as any;
  res.json({
    childId: child?.id || "default",
    name: child?.name || "小宝",
    grade: child?.grade || "二年级",
    serverUrl: `${req.protocol}://${req.hostname}:${PORT}`,
  });
});

// ============== 找当前活跃 session ==============
function getActiveSession() {
  return db
    .prepare(
      "SELECT id, child_id FROM sessions WHERE ended_at IS NULL ORDER BY started_at DESC LIMIT 1"
    )
    .get() as any;
}

// ============== 开始会话 ==============
app.post("/api/session/start", (req: Request, res: Response) => {
  const { childId = "default", subject } = req.body;
  // 关闭任何未结束的旧 session
  db.prepare(
    "UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL"
  ).run();

  const sessionId = crypto.randomUUID();
  db.prepare(
    "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)"
  ).run(sessionId, childId, subject || null);

  console.log(`[study-buddy-server] session started: ${sessionId} (${subject || "no subject"})`);
  res.json({ sessionId, childId, subject, startedAt: Date.now() });
});

// ============== 结束会话 ==============
app.post("/api/session/end", (_req: Request, res: Response) => {
  const session = getActiveSession();
  if (!session) return res.status(400).json({ error: "no active session" });

  const endedAt = Date.now();
  const sess = db.prepare("SELECT * FROM sessions WHERE id = ?").get(session.id) as any;
  const durationMin = Math.max(1, Math.round((endedAt - sess.started_at) / 60000));

  const postureStats = db
    .prepare(
      `SELECT COUNT(*) as count, AVG(score) as avg_score,
              SUM(CASE WHEN warning IS NOT NULL THEN 1 ELSE 0 END) as warnings
       FROM posture_events WHERE session_id = ?`
    )
    .get(session.id) as any;

  const chatStats = db
    .prepare(
      `SELECT
        SUM(CASE WHEN role='child' AND topic='offtopic' THEN 1 ELSE 0 END) as offtopic,
        SUM(CASE WHEN role='child' AND topic='offtopic' AND redirected=1 THEN 1 ELSE 0 END) as recovered
       FROM chat_turns WHERE session_id = ? AND (state IS NULL OR state = 'writing')`
    )
    .get(session.id) as any;

  db.prepare(
    `UPDATE sessions SET
       ended_at = ?, total_minutes = ?, avg_focus_score = ?,
       posture_warning_count = ?, offtopic_count = ?, offtopic_recovered = ?
     WHERE id = ?`
  ).run(
    endedAt,
    durationMin,
    postureStats.avg_score || 0,
    postureStats.warnings || 0,
    chatStats.offtopic || 0,
    chatStats.recovered || 0,
    session.id
  );

  console.log(
    `[study-buddy-server] session ended: ${session.id} (${durationMin}min, score=${Math.round(postureStats.avg_score || 0)}, warnings=${postureStats.warnings || 0})`
  );
  res.json({
    sessionId: session.id,
    durationMin,
    avgFocusScore: Math.round(postureStats.avg_score || 0),
    postureWarningCount: postureStats.warnings || 0,
    offtopicCount: chatStats.offtopic || 0,
    offtopicRecovered: chatStats.recovered || 0,
  });
});

let frameCountForLog = 0;
//
// v0.5：用 sharp 解码 JPEG + 简单启发式
//   - 太暗（avg brightness < 25）→ 黑屏 / 遮挡
//   - 太亮（avg > 230）→ 过曝
//   - 像素方差太低（< 8）→ 纯色（空场景）
//   - 正常：score = 50 + 30 * (方差 / 100)（30-90 区间）
//   - warning 需要 debounce：连续 3 帧异常才触发
//
// v1.0 计划：替换为 MediaPipe Tasks 服务端推理
//
const FRAME_WARN_DEBOUNCE = 3;
const warnStreak = new Map<string, number>();  // sessionId -> 连续异常帧数

app.post("/api/frame", upload.single("frame"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "no frame" });

  const session = getActiveSession();
  const sessionKey = session?.id || "none";

  // 调试：每 100 帧打一次
  frameCountForLog = (frameCountForLog || 0) + 1;
  if (frameCountForLog % 100 === 1) {
    console.log(`[frame] received ${req.file.size} bytes (total this server: ${frameCountForLog})`);
  }

  try {
    const img = sharp(req.file.buffer);
    const meta = await img.metadata();
    const { data, info } = await img
      .resize(80, 60, { fit: "fill" })
      .greyscale()
      .raw()
      .toBuffer({ resolveWithObject: true });

    // 统计：均值 + 方差
    let sum = 0;
    for (let i = 0; i < data.length; i++) sum += data[i];
    const avg = sum / data.length;

    let variance = 0;
    for (let i = 0; i < data.length; i++) {
      const d = data[i] - avg;
      variance += d * d;
    }
    variance = variance / data.length;

    // 判断
    let score = 50 + Math.min(40, Math.floor(variance / 3));
    let warning: string | undefined;

    if (avg < 18) {
      score = 25;
      warning = "画面太黑啦，开个灯？";
    } else if (avg > 235) {
      score = 30;
      warning = "画面太亮了，调暗点？";
    } else if (variance < 6) {
      score = 30;
      warning = "我看不到你，挪一下摄像头角度？";
    } else {
      // 正常
    }

    // Debounce：连续 3 帧异常才触发入库 + 推送给前端
    let shouldWarn = false;
    if (warning) {
      const cur = (warnStreak.get(sessionKey) || 0) + 1;
      warnStreak.set(sessionKey, cur);
      if (cur >= FRAME_WARN_DEBOUNCE) shouldWarn = true;
    } else {
      warnStreak.set(sessionKey, 0);
    }

    if (session && shouldWarn) {
      db.prepare(
        "INSERT INTO posture_events (session_id, score, warning) VALUES (?, ?, ?)"
      ).run(session.id, score, warning);
    }

    res.json({
      score,
      warning: shouldWarn ? warning : undefined,
      debug: { avg: Math.round(avg), variance: Math.round(variance) },
    });
  } catch (e: any) {
    console.error(`[frame] sharp error: ${e.message}`);
    res.json({ score: 80, warning: undefined, debug: { error: e.message } });
  }
});

// ============== System Prompt ==============
const SYSTEM_PROMPT = `你是"小书童"，陪小学二年级的孩子写作业。
你只做 3 件事：
1. 提醒坐姿和专注
2. 听写、提问、检查作业
3. 写完作业陪聊跟学习有关的事

绝对规则：
- 不聊游戏、动画、零食、玩具、电视
- 不讲与作业/课本/学习无关的故事
- 孩子跑偏时用一句话拉回："这个我们写完作业再说，先看看这道题？"
- 语气简短、温暖、不啰嗦，每次回答不超过 2 句话
- 不直接给答案，只给思路
- 用 8 岁孩子能听懂的话`;

const CHAT_PROMPT = `你是"小书童"，孩子刚写完作业，现在是自由陪聊时间。
你还在陪小学二年级孩子，话题范围仍然限定在学习/学校/书/小知识/小思考。
绝对不聊：游戏、动画、零食、玩具、电视、明星八卦、社交媒体。
语气简短、温暖、不啰嗦，每次回答不超过 2 句话。
孩子跑偏时拉回："这个我们下次再聊吧，你今天想做点什么？"`;

// ============== 关键词黑名单（启发式 topic 分类） ==============
const OFFTOPIC_KEYWORDS = [
  "奥特曼", "汪汪队", "冰雪奇缘", "艾莎", "公主", "巴啦啦",
  "王者荣耀", "蛋仔", "原神", "我的世界", "游戏", "玩具",
  "冰淇淋", "薯片", "巧克力", "奶茶", "零食",
  "电视", "动画片", "漫画", "B站", "抖音", "小红书",
  "小狗", "小猫",
];

const EMOTION_KEYWORDS = ["不想", "不要", "烦", "累", "哭", "生气", "怕"];

function classifyTopic(text: string): "learning" | "offtopic" | "emotion" {
  const t = text.toLowerCase();
  for (const kw of OFFTOPIC_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return "offtopic";
  }
  for (const kw of EMOTION_KEYWORDS) {
    if (t.includes(kw)) return "emotion";
  }
  return "learning";
}

// ============== MiniMax M3 API ==============
async function callMinimax(messages: any[]): Promise<string> {
  const apiKey = process.env.MINIMAX_API_KEY;
  if (!apiKey) {
    // v0.1 占位：没配 key 时返回固定引导话术
    const last = messages[messages.length - 1];
    const topic = classifyTopic(last?.content || "");
    if (topic === "offtopic") {
      return "这个我们写完作业再说，先看看这道题？";
    }
    if (topic === "emotion") {
      return "我懂，慢慢来，先深呼吸，我们再看看题目？";
    }
    return "嗯... 我想想，这道题我们可以先...  你愿意先读一遍题目吗？";
  }

  const resp = await fetch("https://api.minimaxi.com/v1/text/chatcompletion_v2", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "MiniMax-Text-01",
      messages,
      temperature: 0.7,
      max_tokens: 500,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text();
    console.error(`[MiniMax] ${resp.status} ${errText.slice(0, 500)}`);
    throw new Error(`MiniMax API ${resp.status}: ${errText.slice(0, 100)}`);
  }

  const data: any = await resp.json();
  // 调试：打印完整响应
  console.log(`[MiniMax] full:`, JSON.stringify(data).slice(0, 600));
  const choice = data.choices?.[0];
  const content = choice?.message?.content || "";
  const finishReason = choice?.finish_reason || "?";
  console.log(`[MiniMax] content=${JSON.stringify(content).slice(0, 100)} finish=${finishReason}`);
  return content || `(${finishReason})`;
}

// ============== 对话接口 ==============
app.post("/api/chat", async (req: Request, res: Response) => {
  const { text, state } = req.body;
  if (!text || typeof text !== "string") {
    return res.status(400).json({ error: "no text" });
  }

  const session = getActiveSession();
  if (!session) {
    return res.status(400).json({ error: "no active session" });
  }

  // 1. 调 LLM（v0.1: 不传 history，每轮独立 — 避免 MiniMax 对累积 message 的 issue）
  // state=done 时切到陪聊 prompt（话题仍限制在学习相关）
  const systemPrompt = state === "done" ? CHAT_PROMPT : SYSTEM_PROMPT;
  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: text },
  ];

  let reply: string;
  try {
    reply = await callMinimax(messages);
  } catch (e: any) {
    console.error(`[chat] LLM error: ${e.message}`);
    reply = "嗯... 我想一下，我们先看看这道题好不好？";
  }

  // 2. 分类 + 判断是否被拉回
  const topic = classifyTopic(text);
  const replyTopic = classifyTopic(reply);
  // 跑偏被拉回：child offtopic + agent reply 不再 offtopic
  const redirected = topic === "offtopic" && replyTopic !== "offtopic" ? 1 : 0;

  // 3. 记录 child 行（redirected 标在这里 — "这次跑偏被拉回了"）
  // state: 'writing'（写作业期间）或 'freechat'（写完后陪聊）— 报告只算 writing
  const chatState = state === "done" ? "freechat" : "writing";
  db.prepare(
    "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(session.id, "child", text, topic, redirected, chatState);

  // 4. 记录 agent reply
  db.prepare(
    "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(session.id, "agent", reply, replyTopic, 0, chatState);

  res.json({
    reply,
    topic,
    replyTopic,
    redirected: !!redirected,
  });
});

// ============== 语音识别（v0.1 占位，v0.5 接 Whisper） ==============
app.post("/api/voice", upload.single("audio"), async (req: Request, res: Response) => {
  if (!req.file) return res.status(400).json({ error: "no audio" });
  // 保存音频到 /tmp 供调试
  const fs = require("node:fs") as typeof import("node:fs");
  const tmpPath = `/tmp/voice-${Date.now()}.webm`;
  fs.writeFileSync(tmpPath, req.file.buffer);
  console.log(`[voice] saved ${req.file.size} bytes to ${tmpPath}`);

  // v0.1 占位：只返回文件信息，不实际调 STT
  // v0.5 计划：调 faster-whisper Python 子进程 或 OpenAI Whisper API
  res.json({
    text: "",  // 暂不返回文字
    error: "STT 还没接（v0.1），用键盘输入吧。v0.5 接 Whisper。",
    file: tmpPath,
    size: req.file.size,
  });
});

// ============== 启动 ==============
if (hasCert) {
  // HTTPS 主服务
  https
    .createServer(
      { key: fs.readFileSync(KEY_PATH), cert: fs.readFileSync(CERT_PATH) },
      app
    )
    .listen(HTTPS_PORT, "0.0.0.0", () => {
      console.log(`[study-buddy-server] HTTPS on :${HTTPS_PORT}`);
      console.log(`[study-buddy-server] Web UI: https://localhost:${HTTPS_PORT}/`);
      console.log(`[study-buddy-server] Web UI (LAN): https://mac-mini.local:${HTTPS_PORT}/`);
    });

  // HTTP 跳转 HTTPS（只对主机名非 localhost 的情况跳转，避免本地回环）
  const redirectApp = express();
  redirectApp.use((req, res) => {
    const host = req.headers.host?.split(":")[0] || "localhost";
    res.redirect(301, `https://${host}:${HTTPS_PORT}${req.url}`);
  });
  http.createServer(redirectApp).listen(HTTP_PORT, "0.0.0.0", () => {
    console.log(`[study-buddy-server] HTTP redirect → HTTPS on :${HTTP_PORT}`);
  });
} else {
  // 没证书就只跑 HTTP
  app.listen(HTTPS_PORT, "0.0.0.0", () => {
    console.log(`[study-buddy-server] HTTP (no HTTPS) on :${HTTPS_PORT}`);
  });
}

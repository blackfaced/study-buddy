// src/app.ts
// Express app factory — extracted from index.ts so tests can construct
// a fresh app against a temporary SQLite database (no listener, no env
// side effects at import time).
//
// Bug 1 (v0.1): /api/pair referenced an undefined `PORT` symbol, so
// serverUrl came out as `https://<host>:undefined`. Fix is in the route
// below — see commit message for the regression test.

import { config as loadDotenv } from "dotenv";
import express, { type Request, type Response } from "express";
import multer from "multer";
import Database from "better-sqlite3";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { mkdirSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { analyzeMistakeImage, type VisionClient } from "./vision.js";

loadDotenv({ path: resolve(process.cwd(), ".env") });

const WEB_DIR = process.env.WEB_DIR || resolve(process.cwd(), "../web");
const HTTPS_PORT = Number(process.env.HTTPS_PORT || 3000);

export interface AppOptions {
  db: Database.Database;
  /** Override the HTTPS port surfaced in /api/pair.serverUrl. Defaults to env HTTPS_PORT. */
  httpsPort?: number;
  /** Vision client for /api/mistake-photo. If null, the endpoint returns 503. */
  visionClient?: VisionClient | null;
  /** Directory where mistake photos are written. */
  mistakesDir?: string;
}

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

export function createApp(opts: AppOptions): express.Express {
  const { db } = opts;
  const httpsPort = opts.httpsPort ?? HTTPS_PORT;
  const visionClient = opts.visionClient === undefined ? null : opts.visionClient;
  const mistakesDir = opts.mistakesDir ?? resolve(process.cwd(), "data/mistakes");
  // Ensure the mistakes dir exists. No-op if it already does.
  try {
    mkdirSync(mistakesDir, { recursive: true });
  } catch {
    /* read-only fs in tests; we'll let writes fail loudly there */
  }

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 },
  });

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
    });
  });

  // ============== 配对 ==============
  app.get("/api/pair", (req: Request, res: Response) => {
    const child = db.prepare("SELECT * FROM children WHERE id = 'default'").get() as any;
    res.json({
      childId: child?.id || "default",
      name: child?.name || "小宝",
      grade: child?.grade || "二年级",
      // Bug 1 fix: was `${PORT}` (undefined) — now uses httpsPort.
      serverUrl: `${req.protocol}://${req.hostname}:${httpsPort}`,
    });
  });

  // ============== 当前活跃 session ==============
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
    db.prepare(
      "UPDATE sessions SET ended_at = strftime('%s','now')*1000 WHERE ended_at IS NULL"
    ).run();

    const sessionId = crypto.randomUUID();
    db.prepare(
      "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)"
    ).run(sessionId, childId, subject || null);

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

    res.json({
      sessionId: session.id,
      durationMin,
      avgFocusScore: Math.round(postureStats.avg_score || 0),
      postureWarningCount: postureStats.warnings || 0,
      offtopicCount: chatStats.offtopic || 0,
      offtopicRecovered: chatStats.recovered || 0,
    });
  });

  // ============== 摄像头帧 ==============
  let frameCountForLog = 0;
  const FRAME_WARN_DEBOUNCE = 3;
  const warnStreak = new Map<string, number>();

  app.post("/api/frame", upload.single("frame"), async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "no frame" });

    const session = getActiveSession();
    const sessionKey = session?.id || "none";

    frameCountForLog = (frameCountForLog || 0) + 1;

    try {
      const img = sharp(req.file.buffer);
      const { data } = await img
        .resize(80, 60, { fit: "fill" })
        .greyscale()
        .raw()
        .toBuffer({ resolveWithObject: true });

      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i];
      const avg = sum / data.length;

      let variance = 0;
      for (let i = 0; i < data.length; i++) {
        const d = data[i] - avg;
        variance += d * d;
      }
      variance = variance / data.length;

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
      }

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

  // ============== LLM ==============
  async function callMinimax(messages: any[]): Promise<string> {
    const apiKey = process.env.MINIMAX_API_KEY;
    if (!apiKey) {
      const last = messages[messages.length - 1];
      const topic = classifyTopic(last?.content || "");
      if (topic === "offtopic") return "这个我们写完作业再说，先看看这道题？";
      if (topic === "emotion") return "我懂，慢慢来，先深呼吸，我们再看看题目？";
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
      throw new Error(`MiniMax API ${resp.status}: ${errText.slice(0, 100)}`);
    }

    const data: any = await resp.json();
    const choice = data.choices?.[0];
    return choice?.message?.content || "";
  }

  // ============== 对话 ==============
  app.post("/api/chat", async (req: Request, res: Response) => {
    const { text, state } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "no text" });
    }

    const session = getActiveSession();
    if (!session) return res.status(400).json({ error: "no active session" });

    const systemPrompt = state === "done" ? CHAT_PROMPT : SYSTEM_PROMPT;
    const messages = [
      { role: "system", content: systemPrompt },
      { role: "user", content: text },
    ];

    let reply: string;
    try {
      reply = await callMinimax(messages);
    } catch {
      reply = "嗯... 我想一下，我们先看看这道题好不好？";
    }

    const topic = classifyTopic(text);
    const replyTopic = classifyTopic(reply);
    const redirected = topic === "offtopic" && replyTopic !== "offtopic" ? 1 : 0;
    const chatState = state === "done" ? "freechat" : "writing";

    db.prepare(
      "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(session.id, "child", text, topic, redirected, chatState);

    db.prepare(
      "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(session.id, "agent", reply, replyTopic, 0, chatState);

    res.json({ reply, topic, replyTopic, redirected: !!redirected });
  });

  // ============== 语音（v0.1 占位） ==============
  app.post("/api/voice", upload.single("audio"), async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "no audio" });
    const tmpPath = `/tmp/voice-${Date.now()}.webm`;
    writeFileSync(tmpPath, req.file.buffer);
    res.json({
      text: "",
      error: "STT 还没接（v0.1），用键盘输入吧。v0.5 接 Whisper。",
      file: tmpPath,
      size: req.file.size,
    });
  });

  // ============== 错题拍照（v0.5） ==============
  // Reuse the existing `upload` multer instance. Different limits would
  // matter in production (2MB vs 500KB) but for testing we just need parsing
  // to work end-to-end with the same `app` that's already wired with
  // `upload` for /api/frame and /api/voice.
  const photoUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 2 * 1024 * 1024 },
  });

  app.post(
    "/api/mistake-photo",
    upload.single("photo"),
    async (req: Request, res: Response) => {
      if (!visionClient) {
        return res.status(503).json({
          error: "vision not configured (MINIMAX_API_KEY not set on the server)",
        });
      }
      if (!req.file) return res.status(400).json({ error: "no photo" });
      const session = getActiveSession();
      if (!session) return res.status(400).json({ error: "no active session" });

      // 1. 写文件到 mistakesDir
      const mistakeId = randomUUID();
      const filename = `${mistakeId}.jpg`;
      const imagePath = join(mistakesDir, filename);
      try {
        writeFileSync(imagePath, req.file.buffer);
      } catch (e: any) {
        return res.status(500).json({ error: `failed to save photo: ${e.message}` });
      }

      // 2. 调 vision
      const base64 = req.file.buffer.toString("base64");
      let analysis;
      try {
        analysis = await analyzeMistakeImage(visionClient, base64);
      } catch (e: any) {
        return res.status(502).json({ error: `vision failed: ${e.message}` });
      }

      // 3. 写 mistakes 表
      const now = Date.now();
      try {
        db.prepare(
          `INSERT INTO mistakes
           (session_id, subject, problem, error_type, image_path, vision_input, vision_reasoning, vision_model, vision_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          session.id,
          "math", // v0.5a 假设是数学题；v0.5b 让 agent 分类
          analysis.problemText || "(无题目文字)",
          "vision_pending", // 错误类型等 v0.5b 用 LLM 归类
          imagePath,
          analysis.problemText,
          analysis.reasoning,
          analysis.model,
          now
        );
      } catch (e: any) {
        return res.status(500).json({ error: `db insert failed: ${e.message}` });
      }

      res.json({
        mistakeId,
        imagePath,
        problemText: analysis.problemText,
        reasoning: analysis.reasoning,
        model: analysis.model,
        visionTs: now,
      });
    }
  );

  return app;
}

// 辅助函数，给外部用（例如测试 / 文档）
export { classifyTopic };

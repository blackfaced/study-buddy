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
import { buildSystemPrompt, buildChatPrompt } from "./llm-prompt.js";
import { detectNameChange } from "./child-name.js";
import { parseEmotionTag, detectLoopFromTexts, NOTIFIABLE_EMOTIONS } from "./chat-signal.js";
import { requestLogger, type Logger, createLogger, stdoutSink } from "./logger.js";
import { recordGameMistake, getGameWeakTopics, recordGameSession, getGameDailyStats } from "./game-sync.js";
import { appendOutbox } from "./outbox.js";
import { BuddyLock } from "./buddy-lock.js";
import {
  addWritingWords,
  deleteWritingWord,
  listWritingAttempts,
  listWritingWords,
  recordWritingAttempt,
} from "./write-sync.js";
import { extractCharsImage } from "./vision.js";
import { registerPortalRoutes } from "./routes/portal.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerBuddyRoutes } from "./routes/buddy.js";
import { registerSessionRoutes, getOrCreateActiveSession } from "./routes/session.js";


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
  /** Path to the Memory Nexus outbox JSONL. */
  outboxPath?: string;
  /** Logger used for request access logs and event logs. Defaults to a stdout logger. */
  logger?: Logger;
  /** Override the 4-digit PIN for /api/buddy/unlock. Defaults to env BUDDY_PIN. Empty/null = unlocked. */
  buddyPin?: string | null;
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
  const logger: Logger = opts.logger ?? createLogger({ level: "info", sinks: [stdoutSink] });
  const outboxPath =
    opts.outboxPath ?? resolve(process.cwd(), "data/nexus-outbox.jsonl");

  // 4-digit PIN gate for /buddy/ chat (issue #55). When BUDDY_PIN is
  // unset, the lock is open (dev mode); log a single warning so the
  // deploy is loud, not silent.
  const buddyPinEnv = process.env.BUDDY_PIN ?? "";
  const buddyPin = opts.buddyPin !== undefined ? opts.buddyPin : buddyPinEnv;
  // Normalize: empty string is the "unset" signal, same as null.
  const effectivePin = (buddyPin === null || buddyPin === "") ? null : buddyPin;
  if (effectivePin === null) {
    logger.warn("BUDDY_PIN not set, /buddy/ chat is unlocked (development mode)");
  }
  const buddyLock = new BuddyLock({ pin: effectivePin });

  const app = express();
  app.use(express.json({ limit: "1mb" }));

  // Access log: one entry per request, with method, path, status, durationMs.
  app.use(requestLogger(logger));

  const upload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 500 * 1024 },
  });

  // Portal + system + buddy + session routes (refactor PR 1 + 2 + 3).
  // The rest of app.ts can stay focused on chat / game / write /
  // frame / mistake / extract logic. getOrCreateActiveSession is
  // re-exported from session.ts and re-used by the chat / frame /
  // mistake handlers below.
  registerPortalRoutes(app, WEB_DIR);
  registerSystemRoutes(app, db);
  registerBuddyRoutes(app, { db, httpsPort, lock: buddyLock, logger });
  registerSessionRoutes(app, { db, logger });

  // ============== 摄像头帧 ==============
  let frameCountForLog = 0;
  const FRAME_WARN_DEBOUNCE = 3;
  const warnStreak = new Map<string, number>();
  // 视频模式开关（iPad 端控制）—— 关掉就只返 ok，不算 warning
  let videoModeEnabled = true;

  app.post("/api/video-mode", (req: Request, res: Response) => {
    const { enabled } = req.body || {};
    videoModeEnabled = !!enabled;
    logger.info("video mode", { enabled: videoModeEnabled });
    res.json({ ok: true, videoEnabled: videoModeEnabled });
  });

  app.post("/api/frame", upload.single("frame"), async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "no frame" });

    // Auto-create a session if needed; the camera might fire after "写完啦"
    // ended the previous session.
    const session = getOrCreateActiveSession(db);
    const sessionKey = session.id;

    frameCountForLog = (frameCountForLog || 0) + 1;
    if (frameCountForLog % 100 === 1) {
      logger.debug("frame batch milestone", { received: frameCountForLog });
    }

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

      // 视频模式关了：不算 warning（也不写 posture_events，但返 ok 保持 iPad 帧流不报错）
      if (!videoModeEnabled) {
        shouldWarn = false;
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
      logger.error("frame sharp error", { error: e.message });
      res.json({ score: 80, warning: undefined, debug: { error: e.message } });
    }
  });

  // System prompts moved to ./llm-prompt.ts (issue #29: 称谓规则)
  //  - 可测（vitest require）
  //  - 接 child.name 注入（默认"小宝"）
  //  - 加"禁止小朋友/小同学/宝贝/乖乖"规则

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

    // Auto-create a session if none is active (e.g. after "写完啦" was
    // pressed, or on first message ever). Don't 400 — the kid should be
    // able to chat right after ending a session.
    const session = getOrCreateActiveSession(db);

    // Load child for the active session (v0.7: 称谓规则用 child.name 注入 prompt)
    const child = db.prepare("SELECT * FROM children WHERE id = ?").get(session.child_id) as any;
    let childName = child?.name || "小宝";

    // W1 hotfix #2（issue #46）：孩子说"我叫X" / "叫我X" → 自动改名字
    // 7/28 糖糖说"我叫糖糖" 30 次都记不住，这个 fix 让 LLM 之外也兜底
    const nameChange = detectNameChange(text);
    if (nameChange && nameChange !== childName) {
      db.prepare("UPDATE children SET name = ? WHERE id = ?").run(nameChange, session.child_id);
      childName = nameChange;
      logger.info("child name changed", { childId: session.child_id, newName: nameChange });
    }

    const systemPrompt = state === "done" ? buildChatPrompt(childName) : buildSystemPrompt(childName);

    // W1 hotfix #28 + #46 #4：循环检测 → 让 LLM 知道该收手了
    // 拉最近 5 轮 child 消息（按时间正序），检测是否僵持同一话题
    const recentChildRows = db.prepare(
      "SELECT content FROM chat_turns WHERE session_id = ? AND role = 'child' ORDER BY id DESC LIMIT 5"
    ).all(session.id) as Array<{ content: string }>;
    const recentChildTexts = recentChildRows.map(r => r.content).reverse();  // 反转成正序（早→晚）
    const isLoop = detectLoopFromTexts(recentChildTexts);

    const messages: any[] = [
      { role: "system", content: systemPrompt },
    ];
    if (isLoop) {
      // 注入僵持升级提示 — LLM 看到后应该说"让爸爸妈妈看看"
      messages.push({
        role: "system",
        content: `[SYSTEM 提示] ${childName} 已经连续 ${recentChildTexts.length} 轮在同一个话题上反复。**不要再尝试回答这个问题**，直接说"让爸爸妈妈看看好不好？"。`,
      });
    }
    messages.push({ role: "user", content: text });

    let reply: string;
    try {
      reply = await callMinimax(messages);
    } catch {
      reply = "嗯... 我想一下，我们先看看这道题好不好？";
    }

    // W1 hotfix #28：解析 LLM 回复末尾的情绪标签
    const { cleanReply, emotion } = parseEmotionTag(reply);
    const displayReply = cleanReply || reply;  // 兜底用原 reply

    const topic = classifyTopic(text);
    const replyTopic = classifyTopic(displayReply);
    const redirected = topic === "offtopic" && replyTopic !== "offtopic" ? 1 : 0;
    const chatState = state === "done" ? "freechat" : "writing";

    db.prepare(
      "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(session.id, "child", text, topic, redirected, chatState);

    db.prepare(
      "INSERT INTO chat_turns (session_id, role, content, topic, redirected, state) VALUES (?, ?, ?, ?, ?, ?)"
    ).run(session.id, "agent", displayReply, replyTopic, 0, chatState);

    // W1 hotfix #28 + #46 #5：写 outbox 通知家长
    // 触发条件：情绪重要（sad/angry/fearful/anxious）或僵持升级
    const notifyReasons: Array<{ reason: string; summary: string }> = [];
    if (NOTIFIABLE_EMOTIONS.has(emotion)) {
      notifyReasons.push({
        reason: 'emotion',
        summary: `${childName} 情绪是"${emotion}"，刚说："${text.slice(0, 80)}"，小书童回复："${displayReply.slice(0, 80)}"`,
      });
    }
    if (isLoop) {
      notifyReasons.push({
        reason: 'loop',
        summary: `${childName} 在同一话题僵持了 ${recentChildTexts.length} 轮，建议家长介入`,
      });
    }
    if (notifyReasons.length > 0) {
      try {
        const ts = Date.now();
        const id = `e_${crypto.randomUUID()}`;
        await appendOutbox(outboxPath, [{
          id,
          ts,
          kind: 'parent_notify',
          entityId: `child:${session.child_id}`,
          content: notifyReasons.map(r => `[${r.reason}] ${r.summary}`).join('\n'),
          payload: {
            sessionId: session.id,
            childId: session.child_id,
            childName,
            reasons: notifyReasons,
            lastChildText: text,
            lastAgentText: displayReply,
            ts,
          },
        }]);
        logger.info("parent notify queued", { id, childId: session.child_id, reasons: notifyReasons.map(r => r.reason) });
      } catch (e: any) {
        logger.error("failed to queue parent notify", { error: e?.message });
      }
    }

    res.json({
      reply: displayReply,
      topic,
      replyTopic,
      redirected: !!redirected,
      emotion,
      isLoop,
    });
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
      // Auto-create a session if needed; same reasoning as /api/chat.
      const session = getOrCreateActiveSession(db);

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

  // ============== Game sync (v0.5b) ==============
  // Apps like candy-math-island POST their mistakes here. We persist to
  // the shared mistakes table (source='game') and append the same event
  // to the outbox so the Memory Nexus worker can index it asynchronously.
  app.post("/api/game/mistake", async (req: Request, res: Response) => {
    const { childId, subject, problem, errorType, userAnswer, correctAnswer, level } = req.body ?? {};
    if (
      typeof childId !== "string" ||
      typeof subject !== "string" ||
      typeof problem !== "string" ||
      typeof errorType !== "string" ||
      typeof userAnswer !== "number" ||
      typeof correctAnswer !== "number" ||
      typeof level !== "number"
    ) {
      return res.status(400).json({ error: "missing or invalid fields" });
    }
    try {
      const id = await recordGameMistake(db, outboxPath, {
        childId,
        subject,
        problem,
        errorType,
        userAnswer,
        correctAnswer,
        level,
      });
      logger.info("game mistake recorded", { mistakeId: id, errorType, level });
      res.json({ mistakeId: id });
    } catch (e: any) {
      logger.error("game mistake record failed", { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/game/weak-topics", async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? 7);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: "days must be a positive number" });
    }
    const topics = await getGameWeakTopics(db, days);
    res.json({ days, weakTopics: topics });
  });

  // ============== Game session (v0.6 time-mode) ==============
  // Apps POST a finished time-mode run here for daily aggregation.
  app.post("/api/game/session", async (req: Request, res: Response) => {
    const {
      childId, appId, durationSec,
      totalQuestions, correctCount,
      startedAt, endedAt,
    } = req.body ?? {};
    if (
      typeof childId !== "string" ||
      typeof appId !== "string" ||
      typeof durationSec !== "number" ||
      typeof totalQuestions !== "number" ||
      typeof correctCount !== "number" ||
      typeof startedAt !== "number" ||
      typeof endedAt !== "number"
    ) {
      return res.status(400).json({ error: "missing or invalid fields" });
    }
    try {
      const id = await recordGameSession(db, outboxPath, {
        childId, appId, durationSec,
        totalQuestions, correctCount,
        startedAt, endedAt,
      });
      const correctRate = Math.round((correctCount / totalQuestions) * 100);
      logger.info("game session recorded", {
        sessionId: id, appId, totalQuestions, correctCount, correctRate,
      });
      res.json({ sessionId: id, correctRate });
    } catch (e: any) {
      // 400 for validation errors thrown by recordGameSession (e.g. totalQuestions <= 0);
      // 500 for anything else.
      if (/must be/.test(e.message) || /not found/.test(e.message)) {
        return res.status(400).json({ error: e.message });
      }
      logger.error("game session record failed", { error: e.message });
      res.status(500).json({ error: e.message });
    }
  });

  app.get("/api/game/daily", async (req: Request, res: Response) => {
    const days = Number(req.query.days ?? 7);
    if (!Number.isFinite(days) || days <= 0) {
      return res.status(400).json({ error: "days must be a positive number" });
    }
    const appId = typeof req.query.appId === "string" ? req.query.appId : undefined;
    const daily = await getGameDailyStats(db, days, appId);
    res.json({ days, appId: appId ?? null, daily });
  });

  // ============== Write app (issue #57) ==============
  // Per-character word library + attempt history. No PIN gate — writing
  // is a parent-supervised activity, not the kind of distraction the
  // buddy PIN is meant to block.
  app.get("/api/write/words", (_req: Request, res: Response) => {
    const words = listWritingWords(db);
    res.json({ words });
  });

  app.post("/api/write/words", (req: Request, res: Response) => {
    const { chars, addedBy } = req.body ?? {};
    if (typeof chars !== "string") {
      return res.status(400).json({ error: "chars must be a string" });
    }
    // Split the string into individual CJK characters; write-sync
    // does the per-char CJK validation + dedup.
    const arr = Array.from(chars);
    const result = addWritingWords(db, arr, typeof addedBy === "string" ? addedBy : "parent");
    res.json(result);
  });

  app.delete("/api/write/words/:char", (req: Request, res: Response) => {
    const char = String(req.params.char);
    // Defensive: only allow single CJK characters in the URL.
    if (!/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    const removed = deleteWritingWord(db, char);
    if (!removed) return res.status(404).json({ error: "not found" });
    res.json({ ok: true });
  });

  app.get("/api/write/words/:char/attempts", (req: Request, res: Response) => {
    const char = String(req.params.char);
    if (!/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    const rawLimit = Array.isArray(req.query.limit) ? req.query.limit[0] : req.query.limit;
    const limit = Math.min(Number(rawLimit ?? 50) || 50, 200);
    const attempts = listWritingAttempts(db, char, limit);
    res.json({ char, attempts });
  });

  app.post("/api/write/attempts", (req: Request, res: Response) => {
    const { char, level, strokePath } = req.body ?? {};
    if (typeof char !== "string" || !/^[\u4E00-\u9FFF]$/.test(char)) {
      return res.status(400).json({ error: "char must be a single CJK character" });
    }
    if (typeof level !== "number" || !Number.isFinite(level) || level < 0 || level > 1) {
      return res.status(400).json({ error: "level must be a number in [0, 1]" });
    }
    if (strokePath !== null && strokePath !== undefined && typeof strokePath !== "string") {
      return res.status(400).json({ error: "strokePath must be a string or null" });
    }
    // FK enforcement: if the char is not in the library, the INSERT
    // will fail. The client should always add to the library first.
    try {
      const id = recordWritingAttempt(db, { char, level, strokePath: strokePath ?? null });
      res.json({ attemptId: id });
    } catch (e: any) {
      res.status(400).json({ error: e.message });
    }
  });

  // v0.7 (issue #57 v0.2): extract CJK characters from a photo.
  // Powers the Mavis agent's "look at this textbook" workflow.
  app.post(
    "/api/write/extract-words",
    upload.single("image"),
    async (req: Request, res: Response) => {
      if (!visionClient) {
        return res.status(503).json({
          error: "vision not configured (MINIMAX_API_KEY not set on the server)",
        });
      }
      if (!req.file) return res.status(400).json({ error: "no image" });
      const base64 = req.file.buffer.toString("base64");
      try {
        const result = await extractCharsImage(visionClient, base64);
        res.json({ words: result.words, model: "MiniMax-M3" });
      } catch (e: any) {
        res.status(502).json({ error: `vision failed: ${e.message}` });
      }
    },
  );

  return app;
}

// ============== Apps registry re-export (study-buddy = platform) ==============
// Refactor PR 1: AppDescriptor and APPS now live in
// ./routes/portal.ts. Re-export here so existing imports of
// `import { APPS, AppDescriptor } from "./app.js"` keep working.
export type { AppDescriptor } from "./routes/portal.js";
export { APPS } from "./routes/portal.js";

// 辅助函数，给外部用（例如测试 / 文档）
export { classifyTopic };

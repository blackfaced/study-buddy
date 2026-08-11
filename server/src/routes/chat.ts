// server/src/routes/chat.ts
// =====================================================================
// Chat route module — extracted from app.ts (refactor PR 4).
// =====================================================================
//
// Owns the buddy chat surface + supporting endpoints:
//   - POST /api/video-mode     — toggle posture-event recording
//   - POST /api/frame          — iPad camera frame analyser
//   - POST /api/chat           — main LLM-backed chat
//   - POST /api/voice          — placeholder for STT
//   - POST /api/mistake-photo  — VLM-backed mistake capture
//
// The chat endpoint is the most complex single route in the
// codebase — it integrates the LLM (callMinimax), session
// lifecycle, emotion classification, name-change detection, the
// outbox (parent notify), and the system prompt builder. Heavy
// deps (db, multer, vision, LLM) are passed in via ChatRouteDeps
// so the module is testable in isolation without hitting the
// network or the production schema.
//
// Public API:
//   - classifyTopic(text)             re-exported (used to live in app.ts)
//   - registerChatRoutes(app, deps)
// =====================================================================
import sharp from "sharp";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type Database from "better-sqlite3";
import type { Logger } from "../logger.js";
import type { VisionClient } from "../vision.js";
import { buildSystemPrompt, buildChatPrompt } from "../llm-prompt.js";
import { detectNameChange } from "../child-name.js";
import { parseEmotionTag, detectLoopFromTexts } from "../chat-signal.js";
import { analyzeMistakeImage } from "../vision.js";
import { appendChatTurnSourceEvent } from "../source-events.js";
import { getOrCreateActiveSession } from "./session.js";

const OFFTOPIC_KEYWORDS = [
  "奥特曼", "汪汪队", "冰雪奇缘", "艾莎", "公主", "巴啦啦",
  "王者荣耀", "蛋仔", "原神", "我的世界", "游戏", "玩具",
  "冰淇淋", "薯片", "巧克力", "奶茶", "零食",
  "电视", "动画片", "漫画", "B站", "抖音", "小红书",
  "小狗", "小猫",
];

const EMOTION_KEYWORDS = ["不想", "不要", "烦", "累", "哭", "生气", "怕"];

export function classifyTopic(text: string): "learning" | "offtopic" | "emotion" {
  const t = text.toLowerCase();
  for (const kw of OFFTOPIC_KEYWORDS) {
    if (t.includes(kw.toLowerCase())) return "offtopic";
  }
  for (const kw of EMOTION_KEYWORDS) {
    if (t.includes(kw)) return "emotion";
  }
  return "learning";
}

export type CallMinimax = (messages: any[]) => Promise<string>;

export interface ChatRouteDeps {
  db: Database.Database;
  logger: Logger;
  visionClient: VisionClient | null;
  mistakesDir: string;
  /** Multer instance. Same one shared with chat/voice/frame. */
  upload: any;
  /** LLM call. Injected so tests can stub it without hitting the network. */
  callMinimax: CallMinimax;
}

const FRAME_WARN_DEBOUNCE = 3;
let videoModeEnabled = true;
let frameCountForLog = 0;
const warnStreak = new Map<string, number>();

/** Default LLM call: hits MiniMax (or a graceful fallback when no key). */
export async function defaultCallMinimax(messages: any[]): Promise<string> {
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

export function registerChatRoutes(app: Express, deps: ChatRouteDeps): void {
  const { db, logger, visionClient, mistakesDir, upload, callMinimax } = deps;

  // ============== 摄像头帧 ==============
  app.post("/api/video-mode", (req: Request, res: Response) => {
    const { enabled } = req.body || {};
    videoModeEnabled = !!enabled;
    logger.info("video mode", { enabled: videoModeEnabled });
    res.json({ ok: true, videoEnabled: videoModeEnabled });
  });

  app.post("/api/frame", upload.single("frame"), async (req: Request, res: Response) => {
    if (!req.file) return res.status(400).json({ error: "no frame" });

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

  // ============== 对话 ==============
  app.post("/api/chat", async (req: Request, res: Response) => {
    const { text, state } = req.body;
    if (!text || typeof text !== "string" || text.length > 4000) {
      return res.status(400).json({ error: "no text" });
    }

    const session = getOrCreateActiveSession(db);
    const child = db.prepare("SELECT * FROM children WHERE id = ?").get(session.child_id) as
      | { name: string }
      | undefined;
    let childName = child?.name || "小宝";

    const nameChange = detectNameChange(text);
    if (nameChange && nameChange !== childName) {
      db.prepare("UPDATE children SET name = ? WHERE id = ?").run(nameChange, session.child_id);
      childName = nameChange;
      logger.info("child name changed", { childId: session.child_id, newName: nameChange });
    }

    const systemPrompt = state === "done" ? buildChatPrompt(childName) : buildSystemPrompt(childName);

    const recentChildRows = db.prepare(
      "SELECT content FROM chat_turns WHERE session_id = ? AND role = 'child' ORDER BY id DESC LIMIT 5"
    ).all(session.id) as Array<{ content: string }>;
    const recentChildTexts = recentChildRows.map((r) => r.content).reverse();
    const isLoop = detectLoopFromTexts(recentChildTexts);

    const messages: any[] = [
      { role: "system", content: systemPrompt },
    ];
    if (isLoop) {
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

    const { cleanReply, emotion } = parseEmotionTag(reply);
    const displayReply = cleanReply || reply;

    const topic = classifyTopic(text);
    const replyTopic = classifyTopic(displayReply);
    const redirected = topic === "offtopic" && replyTopic !== "offtopic" ? 1 : 0;
    const chatState = state === "done" ? "freechat" : "writing";

    try {
      db.transaction(() => {
        const occurredAt = Date.now();
        const childTurn = db.prepare(
          `INSERT INTO chat_turns
             (session_id, ts, role, content, topic, redirected, state)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(session.id, occurredAt, "child", text, topic, redirected, chatState);
        appendChatTurnSourceEvent(db, {
          turnId: Number(childTurn.lastInsertRowid),
          sessionId: session.id,
          childId: session.child_id,
          occurredAt,
          role: "child",
        });

        const agentTurn = db.prepare(
          `INSERT INTO chat_turns
             (session_id, ts, role, content, topic, redirected, state)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        ).run(session.id, occurredAt, "agent", displayReply, replyTopic, 0, chatState);
        appendChatTurnSourceEvent(db, {
          turnId: Number(agentTurn.lastInsertRowid),
          sessionId: session.id,
          childId: session.child_id,
          occurredAt,
          role: "agent",
        });
      })();
    } catch {
      return res.status(500).json({ error: "chat turns could not be recorded" });
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
      const session = getOrCreateActiveSession(db);

      const mistakeId = randomUUID();
      const filename = `${mistakeId}.jpg`;
      const imagePath = join(mistakesDir, filename);
      try {
        writeFileSync(imagePath, req.file.buffer);
      } catch (e: any) {
        return res.status(500).json({ error: `failed to save photo: ${e.message}` });
      }

      const base64 = req.file.buffer.toString("base64");
      let analysis;
      try {
        analysis = await analyzeMistakeImage(visionClient, base64);
      } catch (e: any) {
        return res.status(502).json({ error: `vision failed: ${e.message}` });
      }

      const now = Date.now();
      try {
        db.prepare(
          `INSERT INTO mistakes
           (session_id, subject, problem, error_type, image_path, vision_input, vision_reasoning, vision_model, vision_ts)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          session.id,
          "math",
          analysis.problemText || "(无题目文字)",
          "vision_pending",
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
    },
  );
}

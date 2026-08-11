// src/tools.ts
// MCP tool implementations extracted from index.ts so tests can import
// handleTool without triggering the stdio transport (which would hang
// waiting for stdin).
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import {
  computeChatStats,
  computeOfftopicRate,
  computeRecoveryRate,
  type ChatTurn,
} from "./chat-stats.js";
import {
  appendMcpChatTurnSourceEvent,
  appendMcpMistakeSourceEvent,
  appendMcpSessionSourceEvent,
} from "./source-events.js";

/** HTTP base for the study-buddy server. Used by get_apps to fetch the
 *  live apps registry; the mcp-server doesn't maintain its own copy so
 *  the two processes can't drift. */
export const STUDY_BUDDY_BASE = process.env.STUDY_BUDDY_BASE || "http://127.0.0.1:3000";

function requireSession(sessionId: string): { id: string; child_id: string } {
  const session = db.prepare(
    "SELECT id, child_id FROM sessions WHERE id = ?",
  ).get(sessionId) as { id: string; child_id: string } | undefined;
  if (!session) throw new Error("Session not found");
  return session;
}

function mcpSessionResponse(session: any) {
  return {
    sessionId: session.id,
    durationMin: session.total_minutes,
    avgFocusScore: Math.round(session.avg_focus_score || 0),
    postureWarningCount: session.posture_warning_count || 0,
    offtopicCount: session.offtopic_count || 0,
    offtopicRecovered: session.offtopic_recovered || 0,
    revision: session.source_revision,
  };
}

/** MCP 工具定义（schema + description）。 */
export const TOOLS = [
  // ---- 会话管理 ----
  {
    name: "start_session",
    description:
      "开始一次写作业会话。返回 sessionId，后续所有 log_* 调用都需要它。",
    inputSchema: {
      type: "object",
      properties: {
        childId: {
          type: "string",
          description: "孩子 ID，默认 'default'",
        },
        subject: {
          type: "string",
          description: "学科（数学/语文/英语），可省略",
        },
      },
    },
  },
  {
    name: "end_session",
    description: "结束会话。会自动聚合坐姿/对话/错题统计写入 sessions 表。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
      },
      required: ["sessionId"],
    },
  },

  // ---- 事件记录 ----
  {
    name: "log_posture",
    description: "记录坐姿检测事件。建议每 5-10 秒调用一次。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        score: { type: "number", description: "0-100，越高越专注" },
        warning: {
          type: "string",
          description: "如有警告写具体内容：驼背/歪头/离开座位/看不到人等",
        },
      },
      required: ["sessionId", "score"],
    },
  },
  {
    name: "log_chat",
    description:
      "记录一轮对话。role=child 是孩子说，role=agent 是 agent 回应。topic 用来判断是否跑偏。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        role: { type: "enum", enum: ["child", "agent"] },
        content: { type: "string" },
        topic: {
          type: "enum",
          enum: ["learning", "offtopic", "emotion", "redirect", "small_talk"],
        },
        redirected: { type: "boolean", description: "这一轮是否被 agent 拉回作业" },
      },
      required: ["sessionId", "role", "content", "topic"],
    },
  },
  {
    name: "log_mistake",
    description: "记录错题。错题会自动进入薄弱知识点统计。",
    inputSchema: {
      type: "object",
      properties: {
        sessionId: { type: "string" },
        subject: { type: "string", description: "math/chinese/english 等" },
        problem: { type: "string", description: "题目或简短描述" },
        errorType: { type: "string", description: "错误类型，如 钟表/加减法/拼音/生字" },
        hint: { type: "string", description: "agent 给的思路提示" },
      },
      required: ["sessionId", "subject", "problem", "errorType"],
    },
  },

  // ---- 家长查询 ----
  {
    name: "get_today_report",
    description:
      "获取孩子今日学习报告。家长查这个看孩子今天学得怎么样。返回 JSON，包含推荐决策。",
    inputSchema: {
      type: "object",
      properties: {
        childId: { type: "string" },
      },
    },
  },
  {
    name: "get_weak_topics",
    description: "获取薄弱知识点（按错题次数排序）。",
    inputSchema: {
      type: "object",
      properties: {
        childId: { type: "string" },
        days: { type: "number", description: "看最近 N 天，默认 7" },
      },
    },
  },
  {
    name: "limit_use",
    description:
      "家长决策：限制使用方式。continue=继续，limit_1h=限制每次 1 小时，pause_3d=暂停 3 天。",
    inputSchema: {
      type: "object",
      properties: {
        childId: { type: "string" },
        mode: { type: "enum", enum: ["continue", "limit_1h", "pause_3d"] },
        note: { type: "string", description: "家长的理由" },
      },
      required: ["childId", "mode"],
    },
  },
  {
    name: "get_apps",
    description:
      "列出 study-buddy 平台挂载的所有 app。返回 apps 数组，含 id/name/url/emoji/description/status。",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "get_game_weak_topics",
    description:
      "孩子在游戏里最近 N 天的错题分布（按 errorType 如 carry/borrow/sign/compute 聚合）。Mavis agent 用来给家长做针对性提醒。",
    inputSchema: {
      type: "object",
      properties: {
        childId: { type: "string" },
        days: { type: "number", description: "看最近 N 天，默认 7" },
      },
    },
  },
  {
    name: "get_game_daily_stats",
    description:
      "孩子最近 N 天的每日口算战报：每天 session 数 / 总题数 / 正确数 / 正确率。Mavis agent 用来给家长展示每日做题量和正确率。",
    inputSchema: {
      type: "object",
      properties: {
        childId: { type: "string" },
        days: { type: "number", description: "看最近 N 天，默认 7" },
        appId: { type: "string", description: "可选，按 app 过滤（默认所有）" },
      },
    },
  },

  // ---- v0.7 (issue #57 v0.2): write-app photo-to-library ----
  {
    name: "extract_words_from_image",
    description:
      "从照片（课本/默写纸/字帖）里提取所有单个汉字，返 dedupe 的 CJK 列表。调用 MiniMax M3 vision，server 端会过滤非汉字、拼音、标点。返回后必须跟用户确认再 add_words。",
    inputSchema: {
      type: "object",
      properties: {
        imagePath: {
          type: "string",
          description: "本地图片文件绝对路径（agent 通过 user 上传获取）",
        },
      },
      required: ["imagePath"],
    },
  },
  {
    name: "add_words",
    description:
      "把一组汉字加进写字 app 字库。重复字 server 端 PRIMARY KEY 自动去重，返 {added, skipped}。添加前必须先经用户确认。",
    inputSchema: {
      type: "object",
      properties: {
        chars: {
          type: "string",
          description: "要加的字，可以是字符串（含连续多个字）",
        },
        addedBy: {
          type: "string",
          description: "可选，标记来源（默认 'parent'，agent 调用传 'agent-vision'）",
        },
      },
      required: ["chars"],
    },
  },
];

export async function handleTool(name: string, args: any) {
  switch (name) {
    case "start_session": {
      const childId = args.childId || "default";
      const sessionId = randomUUID();
      db.prepare(
        "INSERT INTO sessions (id, child_id, subject) VALUES (?, ?, ?)"
      ).run(sessionId, childId, args.subject || null);
      return { sessionId, childId, startedAt: Date.now() };
    }

    case "end_session": {
      const sessionId = args.sessionId;
      return db.transaction(() => {
        const session = db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId) as any;
        if (!session) throw new Error("Session not found");
        if (session.source_withdrawn_at != null) throw new Error("Session withdrawn");
        if (session.ended_at != null && session.source_revision > 0) {
          return mcpSessionResponse(session);
        }

        const endedAt = session.ended_at ?? Date.now();
        const durationMin = session.ended_at == null
          ? Math.max(1, Math.round((endedAt - session.started_at) / 60000))
          : session.total_minutes;
        const postureStats = db.prepare(
          `SELECT AVG(score) AS avg_score,
                  SUM(CASE WHEN warning IS NOT NULL THEN 1 ELSE 0 END) AS warnings
           FROM posture_events WHERE session_id = ?`,
        ).get(sessionId) as any;
        const chatRows = db.prepare(
          "SELECT role, topic, redirected, state FROM chat_turns WHERE session_id = ?",
        ).all(sessionId) as ChatTurn[];
        const chatStats = computeChatStats(chatRows);
        const averageFocusScore = session.ended_at == null
          ? (postureStats.avg_score ?? 0)
          : session.avg_focus_score;
        const postureWarningCount = session.ended_at == null
          ? (postureStats.warnings ?? 0)
          : session.posture_warning_count;
        const offTopicCount = session.ended_at == null
          ? chatStats.offtopic
          : session.offtopic_count;
        const offTopicRecovered = session.ended_at == null
          ? chatStats.recovered
          : session.offtopic_recovered;
        const writingTurns = session.ended_at == null
          ? chatStats.writingTurns
          : session.writing_turns;

        db.prepare(
          `UPDATE sessions SET ended_at = ?, total_minutes = ?, avg_focus_score = ?,
             posture_warning_count = ?, offtopic_count = ?, offtopic_recovered = ?,
             writing_turns = ?, source_revision = 1 WHERE id = ?`,
        ).run(
          endedAt, durationMin, averageFocusScore, postureWarningCount,
          offTopicCount, offTopicRecovered, writingTurns, sessionId,
        );
        appendMcpSessionSourceEvent(db, {
          sessionId,
          childId: session.child_id,
          occurredAt: endedAt,
          subject: session.subject,
          startedAt: session.started_at,
          endedAt,
          durationMinutes: durationMin,
          averageFocusScore: Math.round(averageFocusScore),
          postureWarningCount,
          offTopicCount,
          offTopicRecovered,
        });
        return mcpSessionResponse(db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId));
      })();
    }

    case "log_posture": {
      const id = db
        .prepare(
          "INSERT INTO posture_events (session_id, score, warning) VALUES (?, ?, ?)"
        )
        .run(args.sessionId, args.score, args.warning || null).lastInsertRowid;
      return { id, ts: Date.now() };
    }

    case "log_chat": {
      if (args.role !== "child" && args.role !== "agent") {
        throw new Error("log_chat: role must be child or agent");
      }
      return db.transaction(() => {
        const session = requireSession(args.sessionId);
        const occurredAt = Date.now();
        const id = Number(db.prepare(
          `INSERT INTO chat_turns
             (session_id, ts, role, content, topic, redirected)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          args.sessionId, occurredAt, args.role, args.content,
          args.topic, args.redirected ? 1 : 0,
        ).lastInsertRowid);
        appendMcpChatTurnSourceEvent(db, {
          turnId: id,
          sessionId: args.sessionId,
          childId: session.child_id,
          occurredAt,
          role: args.role,
        });
        return { id, ts: occurredAt };
      })();
    }

    case "log_mistake": {
      return db.transaction(() => {
        const session = requireSession(args.sessionId);
        const occurredAt = Date.now();
        const id = Number(db.prepare(
          `INSERT INTO mistakes
             (session_id, child_id, ts, subject, problem, error_type, hint, source)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'study-buddy')`,
        ).run(
          args.sessionId, session.child_id, occurredAt, args.subject,
          args.problem, args.errorType, args.hint || null,
        ).lastInsertRowid);
        appendMcpMistakeSourceEvent(db, {
          mistakeId: id,
          childId: session.child_id,
          occurredAt,
          subject: args.subject,
          problem: args.problem,
          mistakeType: args.errorType,
        });
        return { id, ts: occurredAt };
      })();
    }

    case "get_today_report": {
      const childId = args.childId || "default";
      const dayStart = new Date();
      dayStart.setHours(0, 0, 0, 0);
      const dayStartTs = dayStart.getTime();

      const sessions = db
        .prepare(
          `
        SELECT * FROM sessions
        WHERE child_id = ? AND started_at >= ? AND ended_at IS NOT NULL
        ORDER BY started_at DESC
      `
        )
        .all(childId, dayStartTs) as any[];

      const totals = sessions.reduce(
        (acc, s) => ({
          totalMinutes: acc.totalMinutes + (s.total_minutes || 0),
          scoreWeight: acc.scoreWeight + (s.avg_focus_score || 0) * (s.total_minutes || 0),
          weight: acc.weight + (s.total_minutes || 0),
          postureWarnings: acc.postureWarnings + (s.posture_warning_count || 0),
          offtopic: acc.offtopic + (s.offtopic_count || 0),
          recovered: acc.recovered + (s.offtopic_recovered || 0),
          writingTurns: acc.writingTurns + (s.writing_turns || 0),
        }),
        {
          totalMinutes: 0,
          scoreWeight: 0,
          weight: 0,
          postureWarnings: 0,
          offtopic: 0,
          recovered: 0,
          writingTurns: 0,
        }
      );

      const focusScore =
        totals.weight > 0 ? Math.round(totals.scoreWeight / totals.weight) : 0;
      // 跑偏率 = offtopic / writingTurns（不再把 recovered 加进分母——那是 offtopic 的子集）
      const offtopicRate = computeOfftopicRate(totals);
      const recoveryRate = computeRecoveryRate(totals);

      // 今日错题
      const mistakes = db
        .prepare(
          `
        SELECT m.* FROM mistakes m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.child_id = ? AND m.ts >= ?
        ORDER BY m.ts DESC LIMIT 10
      `
        )
        .all(childId, dayStartTs) as any[];

      // 推荐决策
      let recommendation: "continue" | "limit_1h" | "pause_3d" = "continue";
      let recommendationReason = "一切正常，继续使用";
      if (totals.totalMinutes > 0 && totals.writingTurns > 0) {
        if (offtopicRate > 50) {
          recommendation = "pause_3d";
          recommendationReason = `跑偏率 ${offtopicRate}% 很高，建议暂停 3 天跟孩子聊聊`;
        } else if (offtopicRate > 30) {
          recommendation = "limit_1h";
          recommendationReason = `跑偏率 ${offtopicRate}% 偏高，建议限制每次 1 小时`;
        }
      }

      // 当前限制状态
      const lastDecision = db
        .prepare(
          "SELECT * FROM limit_decisions WHERE child_id = ? ORDER BY decided_at DESC LIMIT 1"
        )
        .get(childId) as any;

      return {
        childId,
        date: dayStart.toISOString().slice(0, 10),
        sessionCount: sessions.length,
        totalMinutes: totals.totalMinutes,
        avgFocusScore: focusScore,
        postureWarningCount: totals.postureWarnings,
        offtopicRate,
        recoveryRate,
        mistakes: mistakes.map((m) => ({
          subject: m.subject,
          problem: m.problem,
          errorType: m.error_type,
        })),
        recommendation,
        recommendationReason,
        currentLimit: lastDecision
          ? { mode: lastDecision.mode, until: lastDecision.until_ts }
          : null,
      };
    }

    case "get_weak_topics": {
      const childId = args.childId || "default";
      const days = args.days || 7;
      const since = Date.now() - days * 24 * 60 * 60 * 1000;

      const topics = db
        .prepare(
          `
        SELECT m.subject, m.error_type, COUNT(*) as count, MAX(m.ts) as last_ts
        FROM mistakes m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.child_id = ? AND m.ts >= ?
        GROUP BY m.subject, m.error_type
        ORDER BY count DESC
        LIMIT 10
      `
        )
        .all(childId, since) as any[];

      return {
        childId,
        days,
        weakTopics: topics.map((t) => ({
          subject: t.subject,
          errorType: t.error_type,
          count: t.count,
          lastAt: t.last_ts,
        })),
      };
    }

    case "limit_use": {
      const childId = args.childId || "default";
      let untilTs: number | null = null;
      if (args.mode === "limit_1h") {
        untilTs = Date.now() + 60 * 60 * 1000;
      } else if (args.mode === "pause_3d") {
        untilTs = Date.now() + 3 * 24 * 60 * 60 * 1000;
      }

      db.prepare(
        "INSERT INTO limit_decisions (child_id, mode, until_ts, note) VALUES (?, ?, ?, ?)"
      ).run(childId, args.mode, untilTs, args.note || null);

      // 同步到 settings
      const limitMin = args.mode === "limit_1h" ? 60 : null;
      db.prepare(
        `
        INSERT INTO settings (child_id, session_limit_minutes, updated_at)
        VALUES (?, ?, ?)
        ON CONFLICT(child_id) DO UPDATE SET
          session_limit_minutes = excluded.session_limit_minutes,
          updated_at = excluded.updated_at
      `
      ).run(childId, limitMin, Date.now());

      return {
        childId,
        mode: args.mode,
        untilTs,
        untilReadable: untilTs ? new Date(untilTs).toISOString() : null,
      };
    }

    case "get_apps": {
      // Apps registry lives in the HTTP server; mcp-server fetches it so
      // the two processes never drift. If the HTTP server is down, fall
      // back to a static list so the agent still has something to show.
      try {
        const resp = await fetch(`${STUDY_BUDDY_BASE}/api/apps`, {
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          const data = (await resp.json()) as { apps: any[] };
          return { apps: data.apps, source: "server" };
        }
      } catch {
        /* fall through to static list */
      }
      return {
        apps: [
          {
            id: "candy-math-island",
            name: "糖果口算岛",
            url: "/games/candy-math-island/",
            emoji: "🍭",
            description: "10 分钟口算闯关",
            status: "ready",
          },
        ],
        source: "static-fallback",
        note: "study-buddy HTTP server not reachable; using fallback list",
      };
    }

    case "get_game_weak_topics": {
      const childId = args.childId || "default";
      const days = args.days || 7;
      const since = Date.now() - days * 24 * 60 * 60 * 1000;

      const topics = db
        .prepare(
          `
        SELECT m.subject, m.error_type, COUNT(*) as count, MAX(m.ts) as last_ts
        FROM mistakes m
        JOIN sessions s ON m.session_id = s.id
        WHERE s.child_id = ? AND m.source = 'game' AND m.ts >= ?
        GROUP BY m.subject, m.error_type
        ORDER BY count DESC
        LIMIT 10
      `
        )
        .all(childId, since) as any[];

      return {
        childId,
        days,
        scope: "game",
        weakTopics: topics.map((t) => ({
          subject: t.subject,
          errorType: t.error_type,
          count: t.count,
          lastAt: t.last_ts,
        })),
      };
    }

    case "get_game_daily_stats": {
      const childId = args.childId || "default";
      const days = args.days || 7;
      const since = Date.now() - days * 24 * 60 * 60 * 1000;
      const appId = typeof args.appId === "string" ? args.appId : null;

      // Mirror server/src/game-sync.ts getGameDailyStats. Use the
      // server's local date (same SQLite date() semantics).
      const rows = appId
        ? (db
            .prepare(
              `SELECT
                  date(started_at/1000, 'unixepoch', 'localtime') AS day,
                  COUNT(*) AS sessionCount,
                  SUM(total_questions) AS totalQuestions,
                  SUM(correct_count) AS correctCount
                FROM game_sessions
                WHERE child_id = ? AND started_at >= ? AND app_id = ?
                GROUP BY day
                ORDER BY day DESC`
            )
            .all(childId, since, appId) as any[])
        : (db
            .prepare(
              `SELECT
                  date(started_at/1000, 'unixepoch', 'localtime') AS day,
                  COUNT(*) AS sessionCount,
                  SUM(total_questions) AS totalQuestions,
                  SUM(correct_count) AS correctCount
                FROM game_sessions
                WHERE child_id = ? AND started_at >= ?
                GROUP BY day
                ORDER BY day DESC`
            )
            .all(childId, since) as any[]);

      const daily = rows.map((r) => ({
        date: r.day,
        sessionCount: r.sessionCount,
        totalQuestions: r.totalQuestions,
        correctCount: r.correctCount,
        correctRate:
          r.totalQuestions > 0
            ? Math.round((r.correctCount / r.totalQuestions) * 100)
            : 0,
      }));

      return {
        childId,
        days,
        appId,
        scope: "game-session",
        daily,
      };
    }

    // ---- v0.7 (issue #57 v0.2): write app — photo-to-library workflow ----
    case "extract_words_from_image": {
      // Reads a local image file (imagePath) and POSTs it as multipart
      // to study-buddy server's /api/write/extract-words. Server runs
      // vision + returns a deduplicated CJK list.
      const { readFile } = await import("node:fs/promises");
      const { basename } = await import("node:path");
      const imagePath = String(args.imagePath ?? "");
      if (!imagePath) throw new Error("extract_words_from_image: imagePath is required");
      let buf: Buffer;
      try {
        buf = await readFile(imagePath);
      } catch (e: any) {
        throw new Error(`extract_words_from_image: cannot read ${imagePath}: ${e.message}`);
      }
      const filename = basename(imagePath);
      const form = new FormData();
      form.append("image", new Blob([new Uint8Array(buf)]), filename);
      const resp = await fetch(`${STUDY_BUDDY_BASE}/api/write/extract-words`, {
        method: "POST",
        body: form,
        signal: AbortSignal.timeout(20_000),  // vision call can take a few seconds
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`extract_words_from_image: server returned ${resp.status}: ${text}`);
      }
      return await resp.json() as { words: string[]; model: string };
    }

    case "add_words": {
      // Adds a list of CJK characters to the write app's word library.
      // Server silently dedupes via the PRIMARY KEY char.
      const chars = typeof args.chars === "string" ? args.chars : "";
      if (!chars) throw new Error("add_words: chars is required (string)");
      const body: Record<string, unknown> = { chars };
      if (typeof args.addedBy === "string") body.addedBy = args.addedBy;
      const resp = await fetch(`${STUDY_BUDDY_BASE}/api/write/words`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5_000),
      });
      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`add_words: server returned ${resp.status}: ${text}`);
      }
      return await resp.json() as { added: number; skipped: number };
    }

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

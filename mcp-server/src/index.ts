#!/usr/bin/env node
// src/index.ts
// Study Buddy MCP Server - 陪孩子写作业
//
// 工具清单（v0.1）：
//   会话管理：start_session, end_session
//   事件记录：log_posture, log_chat, log_mistake
//   家长查询：get_today_report, get_weak_topics, limit_use

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { randomUUID } from "node:crypto";
import { db } from "./db.js";

// ============ MCP Server 初始化 ============

const server = new Server(
  { name: "study-buddy", version: "0.1.0" },
  { capabilities: { tools: {} } }
);

// ============ 工具定义 ============

const TOOLS = [
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
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

// ============ 工具实现 ============

server.setRequestHandler(CallToolRequestSchema, async ({ params }) => {
  try {
    const result = await handleTool(params.name, params.arguments || {});
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    };
  } catch (e: any) {
    return {
      content: [{ type: "text", text: `Error: ${e.message}` }],
      isError: true,
    };
  }
});

async function handleTool(name: string, args: any) {
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
      const session = db
        .prepare("SELECT * FROM sessions WHERE id = ?")
        .get(sessionId) as any;
      if (!session) throw new Error("Session not found");

      const endedAt = Date.now();
      const durationMin = Math.max(
        1,
        Math.round((endedAt - session.started_at) / 60000)
      );

      // 聚合坐姿
      const postureStats = db
        .prepare(
          `
        SELECT
          COUNT(*) as count,
          AVG(score) as avg_score,
          SUM(CASE WHEN warning IS NOT NULL THEN 1 ELSE 0 END) as warnings
        FROM posture_events WHERE session_id = ?
      `
        )
        .get(sessionId) as any;

      // 聚合对话
      // 跑偏 = child 的 offtopic；拉回 = child offtopic 且 redirected=1（被 agent 拉回）
      const chatStats = db
        .prepare(
          `
        SELECT
          SUM(CASE WHEN role = 'child' AND topic = 'offtopic' THEN 1 ELSE 0 END) as offtopic,
          SUM(CASE WHEN role = 'child' AND topic = 'offtopic' AND redirected = 1 THEN 1 ELSE 0 END) as recovered
        FROM chat_turns WHERE session_id = ?
      `
        )
        .get(sessionId) as any;

      db.prepare(
        `
        UPDATE sessions SET
          ended_at = ?, total_minutes = ?, avg_focus_score = ?,
          posture_warning_count = ?, offtopic_count = ?, offtopic_recovered = ?
        WHERE id = ?
      `
      ).run(
        endedAt,
        durationMin,
        postureStats.avg_score || 0,
        postureStats.warnings || 0,
        chatStats.offtopic || 0,
        chatStats.recovered || 0,
        sessionId
      );

      return {
        sessionId,
        durationMin,
        avgFocusScore: Math.round(postureStats.avg_score || 0),
        postureWarningCount: postureStats.warnings || 0,
        offtopicCount: chatStats.offtopic || 0,
        offtopicRecovered: chatStats.recovered || 0,
      };
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
      const id = db
        .prepare(
          "INSERT INTO chat_turns (session_id, role, content, topic, redirected) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          args.sessionId,
          args.role,
          args.content,
          args.topic,
          args.redirected ? 1 : 0
        ).lastInsertRowid;
      return { id, ts: Date.now() };
    }

    case "log_mistake": {
      const id = db
        .prepare(
          "INSERT INTO mistakes (session_id, subject, problem, error_type, hint) VALUES (?, ?, ?, ?, ?)"
        )
        .run(
          args.sessionId,
          args.subject,
          args.problem,
          args.errorType,
          args.hint || null
        ).lastInsertRowid;
      return { id, ts: Date.now() };
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
        }),
        {
          totalMinutes: 0,
          scoreWeight: 0,
          weight: 0,
          postureWarnings: 0,
          offtopic: 0,
          recovered: 0,
        }
      );

      const focusScore =
        totals.weight > 0 ? Math.round(totals.scoreWeight / totals.weight) : 0;
      const totalOfftopicTurns = totals.offtopic + totals.recovered;
      const offtopicRate =
        totalOfftopicTurns > 0
          ? Math.round((totals.offtopic / totalOfftopicTurns) * 100)
          : 0;
      const recoveryRate =
        totals.offtopic > 0
          ? Math.round((totals.recovered / totals.offtopic) * 100)
          : 100;

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
      if (totals.totalMinutes > 0 && totalOfftopicTurns > 0) {
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

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ============ 启动 ============

const transport = new StdioServerTransport();
await server.connect(transport);
console.error("[study-buddy] MCP server running on stdio");

/**
 * Pure functions for aggregating chat-turn statistics.
 *
 * Bug fixes (v0.1):
 *  - Run 2 (mcp-server get_today_report): original offtopicRate = offtopic / (offtopic + recovered)
 *    double-counted recovered (since recovered is a subset of offtopic). Correct: offtopic / writingTurns.
 *  - Run 3 (mcp-server end_session): original SQL had no `state` filter, so freechat turns
 *    inflated the homework-time offtopic count. Correct: filter to writing (or legacy null) only.
 */

export type ChatTopic = "learning" | "offtopic" | "emotion" | "redirect" | "small_talk";
export type ChatState = "writing" | "freechat" | null;
export type ChatRole = "child" | "agent";

export interface ChatTurn {
  role: ChatRole;
  topic: ChatTopic;
  /** 0 or 1; only meaningful on child-offtopic rows where agent pulled the kid back. */
  redirected: number;
  /** 'writing' = homework period (counted). 'freechat' = post-homework chitchat (excluded).
   *  null = legacy rows from before the state column was added (counted as writing). */
  state: ChatState;
}

export interface ChatStats {
  /** child offtopic messages during writing. */
  offtopic: number;
  /** child offtopic messages during writing where the agent pulled the kid back. */
  recovered: number;
  /** total child messages during writing (any topic). Used as denominator for offtopic rate. */
  writingTurns: number;
}

/** True if a row is a homework-period child turn (counted toward homework stats). */
function isWritingChildTurn(row: ChatTurn): boolean {
  return row.role === "child" && (row.state === "writing" || row.state === null);
}

export function computeChatStats(rows: ChatTurn[]): ChatStats {
  const writingChildTurns = rows.filter(isWritingChildTurn);
  const offtopic = writingChildTurns.filter((r) => r.topic === "offtopic").length;
  const recovered = writingChildTurns.filter(
    (r) => r.topic === "offtopic" && r.redirected === 1
  ).length;
  return { offtopic, recovered, writingTurns: writingChildTurns.length };
}

/** offtopic rate = offtopic / writingTurns. Returns 0 when there are no writing turns. */
export function computeOfftopicRate(stats: ChatStats): number {
  if (stats.writingTurns === 0) return 0;
  return Math.round((stats.offtopic / stats.writingTurns) * 100);
}

/** recovery rate = recovered / offtopic. Returns 100 (vacuous truth) when there are no offtopic turns. */
export function computeRecoveryRate(stats: ChatStats): number {
  if (stats.offtopic === 0) return 100;
  return Math.round((stats.recovered / stats.offtopic) * 100);
}

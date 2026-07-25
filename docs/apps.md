# study-buddy 平台架构 (v0.5b+)

study-buddy 不再是单个 agent 助手，而是一个**应用平台 (hub)**：一个共享后端 + 多个挂在门户页上的子 app。

## 目标

- **共享数据**：错题本 (mistakes)、会话 (sessions)、孩子画像 (children) 在所有 app 间互通
- **可插拔 app**：每个 app 是 `web/<app-dir>/` 下的独立子项目，可以是 HTML5 小游戏、JS 工具、静态练习题等
- **门户页**：`web/index.html` 位于 `/`，列出核心陪伴入口和所有 `status: "ready"` 的 app；陪伴页本身位于 `/buddy/`
- **Mavis agent 可见**：`get_apps` MCP 工具返回同样的列表，agent 知道有哪些 app 可调

## 当前入口

| 路径 | 名称 | 用途 |
|---|---|---|
| `/` | 小书童学习空间 | 门户页，列出所有可用入口 |
| `/buddy/` | 小书童陪伴 | 聊天、拍题和陪写作业 |
| `/games/candy-math-island/` | 糖果口算岛 | 口算小游戏 |

## 当前挂载的 app

| id | 名称 | 路径 | 类型 | 状态 |
|---|---|---|---|---|
| `candy-math-island` | 糖果口算岛 | `web/games/candy-math-island/` | HTML5 小游戏 | `ready` |

## 关键设计：松耦合

### 1. Apps registry 是 server 端代码定义

`server/src/app.ts` 里有个 `APPS` 常量数组，是**单一事实源 (single source of truth)**。MCP server 通过 `GET /api/apps` HTTP 拉取，不维护自己副本 → 永远不会漂移。

```ts
// server/src/app.ts
export const APPS: AppDescriptor[] = [
  {
    id: "candy-math-island",
    name: "糖果口算岛",
    url: "/games/candy-math-island/",
    emoji: "🍭",
    description: "10 分钟口算闯关",
    status: "ready",
  },
  // ... 未来加新 app 在这里登记
];

app.get("/api/apps", (req, res) => res.json({ apps: APPS }));
```

如果 HTTP server 不可达，mcp-server `get_apps` 退到静态 fallback 列表，至少能展示当前已知的 app。

### 2. 错题本 (mistakes) 是跨 app 共享的

`mistakes` 表加了一个 `source` 列，标识错题来源：

| source | 来自 | 例子 |
|---|---|---|
| `study-buddy` | 聊天 agent 报题 (v0.1) | agent 在对话中指出错题 |
| `vision` | 拍照识别 (v0.5) | iPad 拍作业→MiniMax-M3 读题 |
| `game` | 小游戏 (v0.5b) | 糖果口算岛关卡打错 |

`server/src/game-sync.ts` 把游戏错题写进同一张表（`source='game'`），`get_weak_topics` MCP 工具 + `get_game_weak_topics` MCP 工具都能直接 query。

### 3. Game sync 流程（双向）

**game → study-buddy**：
1. 糖果口算岛打错题 → push 到 `wrongList`，每条标 `syncedToServer: false`
2. `syncToStudyBuddy()` 遍历未同步的，POST 到 `/api/game/mistake`
3. 触发时机：`onload` + `pagehide` + `visibilitychange === 'hidden'`
4. 服务端 `recordGameMistake()` 自动找/建 session，插 mistakes(source='game')，并把错题摘要 append 到 outbox
5. 4xx/5xx 也标 `syncedToServer: true`（避免无限重试），仅网络错误才重试

**study-buddy → game**：
- `GET /api/game/weak-topics?days=7` 按 (subject, errorType) 聚合，game 端可以据此调整下一关难度
- 当前糖果口算岛还是固定难度，预留接口

### 4. Memory Nexus 接入：本地 outbox 文件

study-buddy 跟 Memory Nexus 是**松耦合**：

- study-buddy 只 append 到 `data/nexus-outbox.jsonl` (JSONL，每行一个 OutboxEntry)
- 独立的 `nexus-worker` 进程（或未来 mavis cron）从 outbox 读条目，调 Nexus API
- study-buddy 永远不阻塞在 Nexus 上 — Nexus 挂掉不影响主流程
- worker 处理完的条目 atomic rename 到 `data/nexus-outbox.processed.jsonl`（tmp + rename 模式，进程崩了也不丢）

**Outbox 格式**（`server/src/outbox.ts`）：
```ts
interface OutboxEntry {
  id: string;         // uuid
  ts: number;         // unix ms
  kind: string;       // e.g. "game-mistake"
  entityId: string;   // e.g. "default"
  content?: string;   // 预渲染的文本（可选）
  payload: Record<string, unknown>;
}
```

**Worker 启动**：
```bash
bin/nexus-worker.sh start   # 后台循环（默认 30s 轮询）
bin/nexus-worker.sh once    # 单次 drain（适合 mavis cron）
bin/nexus-worker.sh logs    # tail -f data/logs/nexus-worker.log
```

**Worker tag**：用 `kind:entityId` 拼成 tag 字符串，Nexus `failOn` 可以用同样的 pattern 跳过重复。

### 5. mcp-server db.ts 现在支持测试 initDb

之前 mcp-server 的 schema 迁移在 module top-level 一加载就跑（打开真实 db 文件），测试没法用 in-memory db。`v0.5b` refactor 后：

- `initDb(path)` 显式初始化，可重复调用（会 close 旧 instance）
- `getDb()` lazy 拿当前 instance
- `db` 通过 Proxy 转发，**老调用点 `import { db } from "./db.js"` 不用改**
- `handleTool` 抽到 `tools.ts`，测试 import 它**不会触发 stdio transport**（否则会卡在 stdin 上）

测试用法：
```ts
import { initDb, getDb } from "./db.js";
import { handleTool } from "./tools.js";

beforeAll(() => {
  initDb(":memory:");
  const db = getDb();  // 拿到同一 instance（不是新连接！）
});
```

## 加新 app 的流程

1. 在 `web/<app-dir>/` 下创建 app（HTML5/JS/TS 都行）
2. 在 `server/src/app.ts` 的 `APPS` 数组里登记：
   ```ts
   { id: "my-app", name: "...", url: "/<app-dir>/", emoji: "...", description: "...", status: "ready" }
   ```
3. 如果要写错题：
   - 调用 `POST /api/game/mistake`（参数跟 candy-math-island 一样，复用同 schema）
   - 或自己直接 `INSERT INTO mistakes ... source='<your-source>'`
4. 如果要读错题：
   - `GET /api/game/weak-topics?days=7`（聚合所有 source=game 的）
   - 或 MCP 工具 `get_weak_topics` / `get_game_weak_topics`
5. **不要**自己开 SQLite 连接 — 走 server 或 MCP 走共享 db

## 不做的事

- ❌ 不在 `web/apps/` 单独放一个空目录占位（app 跟 server 一起演进）
- ❌ 不把每个 app 拆成独立 npm package / monorepo workspace（YAGNI）
- ❌ 不搞复杂的 app 间消息总线（HTTP 端点 + outbox 文件就够）
- ❌ 不在 kid 端加任何"app 切换器"的视觉装饰（保持 v0.1 极简）

## 演进路径

- **v0.5b (现在)**：apps registry + 1 个游戏 + Nexus outbox 雏形
- **v0.6**：游戏进度持久化（关卡/分数/成就）+ 错题回看 UI + agent 主动"拍给我看"
- **v0.7+**：第二个 app（生字卡 / 单词卡），验证架构可扩展
- **v1.0**：Mavis cloud 接管部分功能（家长端 dashboard 走 mavis IM，agent 推理走云端 LLM）

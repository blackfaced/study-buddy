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
| `/buddy/` | 小书童陪伴 | 聊天、拍题和陪写作业（`BUDDY_CHAT_ENABLED=false` 时隐藏聊天 UI，只留拍错题） |
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

### 2. 错题本是跨 app 共享的（closure loop）

所有 app 的错题都写入同一份 closure loop（`mistake_cases` + `correction_obligations` + `learning_attempts`，术语见根目录 `CONTEXT.md`），统一入口是 `server/src/capture-service.ts` 的 `insertMistake()`。`source` 列标识来源：

| source | 来自 | 例子 |
|---|---|---|
| `study-buddy` | 聊天 agent 报题 (v0.1) | agent 在对话中指出错题 |
| `vision` | 单张拍照识别 (v0.5) | iPad 拍作业→MiniMax-M3 读题 |
| `vision_page` | 整页拍照 (T04) | 一页作业拆多个候选题 |
| `game` | 小游戏 (v0.5b) | 糖果口算岛关卡打错 |
| `manual` | 手动录入 (T03) | 家长/孩子手打错题 |

游戏错题经 compat adapter `POST /api/game/mistake` 进入同一写路径；`get_weak_topics` MCP 工具 + `get_game_weak_topics` MCP 工具都能直接 query。旧 `mistakes` 表是 thin mirror，PR-D (#159–#165) 会整表删除——新代码不要直接读写它。

### 3. Game sync 流程（双向）

**game → study-buddy**：
1. 糖果口算岛打错题 → push 到 `wrongList`，每条标 `syncedToServer: false`
2. `syncToStudyBuddy()` 遍历未同步的，POST 到 `/api/game/mistake`
3. 触发时机：`onload` + `pagehide` + `visibilitychange === 'hidden'`
4. 服务端经 `insertMistake()` 写入 `mistake_cases(source='game')` + 开启订正义务，并在同一 SQLite 事务里追加不可变 Source Event
5. 4xx/5xx 也标 `syncedToServer: true`（避免无限重试），仅网络错误才重试

**study-buddy → game**：
- `GET /api/game/weak-topics?days=7` 按 (subject, errorType) 聚合，game 端可以据此调整下一关难度
- 当前糖果口算岛还是固定难度，预留接口

### 4. 外部适配器接入：事务型 Source Event feed

study-buddy 跟 MemoryNexus 等外部消费者保持**产品边界上的松耦合**：

- eligible domain row 和 `source_events` 在同一 SQLite 事务提交；消费者停机不影响孩子继续使用
- 每个 Source Event envelope 都携带 provider-owned opaque `subjectRef`；即使 tombstone 的 payload 为空，消费者也能先验证孩子边界再处理撤回
- `GET /api/integration/source-events` 是带独立 Bearer token、仅 loopback 可访问的单调游标 feed
- Learning Attempt、Learning Session 和 Chat Turn 使用 Study Buddy 自己的稳定身份、revision 和 withdrawal 语义
- Chat Source Event 只带 `sessionRef` / `turnRef`；正文只能通过 `POST /api/integration/chat-turns` 在 14 天以内、最多 50 个明确引用的窗口中读取
- feed 不保存消费者 cursor/ack，也不包含 MemoryNexus Space、Namespace、token 或标准化结果字段

旧 `nexus-outbox*.jsonl` 仅作为迁移输入保留，应用不再向其写入。先做只读盘点，再与外部 Adapter 协调切换：

```bash
bin/source-feed-cutover.sh inventory
bin/source-feed-cutover.sh enable
```

`enable` 会在旧 worker 仍存活或旧 producer 仍启用时拒绝执行；成功后旧 `nexus-worker` 的 daemon/one-shot 路径都会硬失败。JSONL 文件不会自动上传、改写或删除。

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
   - 游戏类 app 调用 `POST /api/game/mistake`（参数跟 candy-math-island 一样；它是 `insertMistake()` 之上的 compat adapter，source 固定为 `game`）
   - 非游戏来源用对应的 capture 入口（手动 `/api/capture/manual`），不要直接写表
4. 如果要读错题：
   - `GET /api/game/weak-topics?days=7`（聚合所有 source=game 的）
   - 或 MCP 工具 `get_weak_topics` / `get_game_weak_topics`
5. **不要**自己开 SQLite 连接 — 走 server 或 MCP 走共享 db

## 不做的事

- ❌ 不在 `web/apps/` 单独放一个空目录占位（app 跟 server 一起演进）
- ❌ 不把每个 app 拆成独立 npm package / monorepo workspace（YAGNI）
- ❌ 不搞复杂的 app 间消息总线（HTTP + SQLite Source Event feed 足够）
- ❌ 不在 kid 端加任何"app 切换器"的视觉装饰（保持 v0.1 极简）

## 演进路径

- **v0.5b**：apps registry + 1 个游戏 + legacy Nexus outbox
- **v0.10 (现在)**：事务型 provider Source Event feed + 有界 chat retrieval
- **v0.6**：游戏进度持久化（关卡/分数/成就）+ 错题回看 UI + agent 主动"拍给我看"
- **v0.7+**：第二个 app（生字卡 / 单词卡），验证架构可扩展
- **v1.0**：Mavis cloud 接管部分功能（家长端 dashboard 走 mavis IM，agent 推理走云端 LLM）

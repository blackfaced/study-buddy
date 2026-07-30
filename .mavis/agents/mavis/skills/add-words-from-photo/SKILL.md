# 拍照入字库（写字 app v0.2）

## 场景识别

家长在 IM 发起以下任一请求时启用本 skill：

- "我拍了张课本/默写纸/字帖照片" + 附件
- "把今天要练的字加进去"
- "提取这张图里的字"
- "用照片入字库"

> 关联：写字 app `/web/write/` 的 v0.2 升级（issue #59 / #57 v0.2）。

## MCP 工具

本 skill 依赖 `study-buddy` MCP server 的 2 个写库工具（PR #60）：

- `extract_words_from_image` — 拿照片走 MiniMax M3 vision，返 dedupe 的汉字列表
- `add_words` — 把字加进写字 app 字库，server 端 PRIMARY KEY 去重

> 视觉模型跑在 **study-buddy server 端**（`/api/write/extract-words`），不是 mcp-server。
> 复用 `vision-client.ts`，不绑 vendor。

## 工作流（必走 5 步，**不能跳确认**）

### 1. 接收照片

- 家长在 IM 发图片附件
- agent 用对话平台原生的"保存到本地"机制（WeCom / Feishu 都会临时落盘），
  或者把 `image_url` 抓下来写到 `/tmp/study-buddy-photos/<timestamp>.jpg`
- 确认文件存在且 size > 0（小于 1KB 提示"图好像没传上来，重新发一下"）

### 2. 调 `extract_words_from_image`

```
extract_words_from_image({ imagePath: "/tmp/study-buddy-photos/xxx.jpg" })
→ { words: ["一", "二", "三", "上", "下", ...], model: "MiniMax-M3" }
```

如果 server 返 503（vision 没配 key），告诉家长"现在没法用照片，等配好 key 再试"。

### 3. **必须跟用户确认**（关键，不能跳）

把 list 完整念出来给家长，**逐字 confirm**：

```
我看到图里这些字（按图片里出现的顺序）：
1 2 3 4 5 6 7 ...
共 N 个字。

- 全部对的话回复「全对」
- 有错的话告诉我「加 X，去掉 Y」
- 想完全重念一遍的话回复「重试」
```

> 为什么要确认？vision 可能把拼音、偏旁、标点识别成字，**人工把最后一道关**。

### 4. 调 `add_words`

家长确认后，**用家长最终认定的字串**调：

```
add_words({ chars: "一二三上下...", addedBy: "agent-vision" })
→ { added: 8, skipped: 0 }
```

> `addedBy="agent-vision"` 是约定值，表示来自照片提取，便于将来 audit。
> 家长手输也走同一个 tool，addedBy 传 `"parent"`。

### 5. 反馈给家长

```
已加入 8 个字到字库 ✅
（去重跳过 0 个 — 说明都是新字）
下次孩子打开 /web/write/ 就能直接练了。
```

## ⚠️ 严格不要做

1. **跳过第 3 步用户确认** — vision 一定有误差，必须人工把最后一道关
2. **不要直接调 `add_words` 拿 vision 原始结果** — 哪怕 list 看起来很对
3. **不要把图片 URL 喂给 vision API** — 必须先 save 到本地（multipart 走 server endpoint）
4. **不要自己编字** — 家长念啥就传啥，没念的别擅自加
5. **不要在错误时静默重试** — server 502/503 直接告诉家长，别假装调用成功
6. **不要把 vision raw response 贴给家长** — 那是模型原始 JSON，家长看不懂
7. **不要给单个字多于一次确认** — 一次性念完整 list，**不要每字问一次**

## 默认参数

- `chars` 拼接方式：去重后按家长念的顺序串成连续字符串
- `addedBy` 默认 `"agent-vision"`（本 skill 触发时），手输时为 `"parent"`
- 文件落地目录：`/tmp/study-buddy-photos/`（mac mini 本地，dev 用，生产换持久路径）
- 一次最多处理 50 个字（图太大 vision 会慢/截断，>50 提示"分批来"）

## 失败处理

| 现象 | 动作 |
|----|----|
| 家长没发图，只说"加字" | 问"想加哪些字，念给我" — 走 add_words 手输路径 |
| vision 返空 list `[]` | "图里好像没识别到汉字，再发一张更清楚的？" |
| vision 503 | "现在没法用照片入字库，**手动念给我**也行" |
| 家长说"全对"但你看到 list 里有明显怪字 | 主动再问一次"X 这个字你确定要加吗" |
| 同一字反复调 add_words | server 端 PRIMARY KEY 自动跳过，无需特殊处理 |

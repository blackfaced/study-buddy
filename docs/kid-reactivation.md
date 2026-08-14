# 让孩子回到 app 的操作清单

数据上看：8/1 之后再没新 game_session，8/8 之后再没新 chat_turns，0 paired_devices。
#13 + #34b v0.5 + #38 都上完了，技术上能接住，但**孩子不点开 = 0 价值**。

下面是 3 步操作清单，不写代码，只配环境。

---

## 1. 配 PIN（必做，5 分钟）

`.env` 里已经有 `BUDDY_PIN=8864`（v0.1 砍半用，参考就行，自己换一个 4 位）。

**操作**：

1. 拿到 kid 的设备（旧手机 / iPad / 旧电脑都可以）
2. 浏览器打开 `https://<你的 Mac mini IP>:3000/buddy/`
3. 输入 PIN 8864（或你自己设的那个）
4. 完事 — 这台设备就被绑到 `default` child 下了

> 没配对也能用 un-paired 入口（cookie/localStorage 路径），但 6-13 天前那个聊天记录就是 un-paired 走的，cookie 一掉 kid 就"重新来过"。配对之后 kid 是稳定的 `paired_devices` 行，cookie 丢了也能从 `/api/pair/whoami` 找到自己。

**验证**：
```bash
cd /Users/mac/hc/github/study-buddy/server
node -e "const d=require('better-sqlite3')('data/study.db',{readonly:true}); console.log(d.prepare('SELECT device_id, child_id, device_name, last_seen_at FROM paired_devices').all());"
```

应该看到至少 1 行 `child_id: 'default'`，`last_seen_at` 是刚才。

---

## 2. 配飞书 / 钉钉 webhook（强烈建议，10 分钟）

`.env` 里**没有** webhook URL，需要你提供：

```bash
# 飞书：在群机器人 → 自定义机器人 → 复制 webhook URL，签名校验打开后有 secret
FEISHU_WEBHOOK_URL=https://open.feishu.cn/open-apis/bot/v2/hook/xxxxxxxx
FEISHU_WEBHOOK_SECRET=你的签名密钥

# 或者钉钉（如果你用钉钉）
# DINGTALK_WEBHOOK_URL=https://oapi.dingtalk.com/robot/send?access_token=xxxxxxxx
# DINGTALK_WEBHOOK_SECRET=SEC...
```

填好后跑：
```bash
cd /Users/mac/hc/github/study-buddy
node bin/feishu-reminder.js --text "测试一下飞书能不能收到 ✉️"
```

应该在飞书群里看到一条 "测试一下飞书能不能收到 ✉️"。如果没看到，看 `node bin/feishu-reminder.js` 的 stderr（HTTP 错误信息）。

---

## 3. 排个定时提醒（10 分钟）

我会在你填好 webhook URL 之后帮你起 mavis cron。挑一个：

| 时间 | 提示内容 | 适用 |
|---|---|---|
| **20:00** 周一到周五 | "小宝，今天的作业做完了吗？来做几道题吧 ✏️" | 习惯晚饭后 |
| **16:30** 周一到周五 | "放学啦，先做 10 道题再玩 🚀" | 放学后 |
| **10:00** 周末 | "周末不赖床，10 道题热热手 🧠" | 周末 |

告诉我**用哪个**（或者你自己写一句），我立刻配。

---

## 现状速览

| 状态 | 数据 |
|---|---|
| paired_devices | 0（待配） |
| 最近 game_session | 2026-08-01 (13 天前) |
| 最近 chat_turn | 2026-08-08 (6 天前) |
| 真实错题 | 14 条（8 vision_pending / 2 borrow / 2 compute / 1 carry / 1 审题 / 1 钟表）|
| 已 ship 但未触发 | PR #119 (MN observations), PR #120 (乘法大冒险), PR #121 (#34b v0.5) 等合了主之后 |

合了主之后，kid 第一次点开 `乘法大冒险` 按钮 → 走通整个新流程；点开 `糖果口算岛` → 走 30% 错题混入 + 错题讲解卡 (现在覆盖 8 种 errorType)。

# study-buddy 视觉系统 (v0.6.6+)

3 个 app (portal / buddy / game) 共享一份 design system, 通过 `web/shared/theme.css` 暴露。

## 用法

每个页面顶部加:
```html
<link rel="stylesheet" href="/shared/theme.css">
```

页面级 `<style>` 里只 override token + 写 app 自己的布局, 不重复通用规则。

## Theme 切换

**Default (warm)** — portal + buddy, 不需要 override:
```css
:root {
  --accent: #ffb84d;
  --bg-page-start: #fff9ea;
  --bg-page-end: #ffe5b4;
  --text-primary: #513a1e;
}
```

**Candy (game)** — 在 `<style>` 顶部 override:
```css
:root {
  --accent: #FF6B9D;
  --accent-soft: #FFE5EC;
  --bg-page-start: #FFE5EC;
  --bg-page-end: #FFF8F0;
  --bg-card: rgba(255, 255, 255, 0.85);
  --bg-input: #FFFAFC;
  --text-primary: #3D3D5C;
  --text-secondary: #806478;
  --text-on-accent: white;
}
```

## 设计 Token 清单

### 字体
- `--font-system`: 系统字体栈 (iOS / 鸿蒙 / Windows 通用)

### 间距 (4px 基线)
- `--space-1..7`: 4 / 8 / 12 / 16 / 24 / 32 / 48px

### 字号
- `--text-display`: 36px (大标题)
- `--text-title`: 24px (卡片标题)
- `--text-body`: 16px (正文)
- `--text-caption`: 14px (说明文字)
- `--text-button`: 16px (按钮)

### 圆角
- `--radius-pill`: 999px (胶囊按钮)
- `--radius-card`: 22px (卡片)
- `--radius-input`: 18px (输入框)
- `--radius-button`: 18px (按钮)

### 阴影
- `--shadow-card`: 0 4px 14px rgba(113, 78, 30, 0.06)
- `--shadow-card-lg`: 0 8px 28px rgba(113, 78, 30, 0.1)
- `--shadow-button`: 0 2px 6px rgba(0, 0, 0, 0.08)
- `--shadow-button-accent`: 0 4px 12px rgba(255, 143, 177, 0.35)

### 动效
- `--duration-fast`: 150ms (按钮按压)
- `--duration-normal`: 220ms (页面切换)
- `--duration-slow`: 400ms (大动画)
- `--ease-default`: cubic-bezier(0.4, 0, 0.2, 1)

## 组件

| class | 用途 |
|---|---|
| `.card` | 主内容卡片 (白底 + 阴影 + 圆角) |
| `.btn` + `.btn-primary` / `.btn-secondary` / `.btn-pill` | 按钮系统 |
| `.input` | 输入框 |
| `.app-topbar` | 统一 topbar (左 back / 中 title / 右 slot) |
| `.back-to-portal` | 回门户按钮 (40x40 圆) |
| `.entry` | portal 入口卡 |
| `.page` + `.page.active` | 多页 app 切换 (game 用) |

## 加新 app 的流程

1. `web/<app-id>/index.html` 创建 HTML
2. `<head>` 顶部加 `<link rel="stylesheet" href="/shared/theme.css">`
3. 选个主题 (warm 默认 / candy 等) 在 `<style>` override
4. 用 shared 组件: `.card`, `.btn`, `.app-topbar`, `.back-to-portal`
5. 在 `server/src/app.ts` 的 `APPS` 数组里登记

## 不要做

- ❌ 在 app 里重写 `box-sizing`, font-family, 等已 shared 的 reset
- ❌ 在 app 里硬编码颜色 / 圆角 / 间距, 走 token
- ❌ 给同一个 component 起新名字 (e.g. 别用 `.my-card` 代替 `.card`)

## 未来工作 (相关 issue)

- 候选 3 (Issue #21): 抽 `web/shared/app.js` (TTS 暖机 / fetch / camera pause)
- 候选 4 (Issue #22): AppShell hub-aware 统一导航
- 候选 5 (Issue #23): buddy 内部分层 (state / camera / chat / voice)

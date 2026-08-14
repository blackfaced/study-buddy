// server/src/routes/portal.ts
// =====================================================================
// Portal route module — extracted from app.ts (refactor PR 1).
// =====================================================================
//
// Owns:
//   - GET /              iOS Safari cache-bust 302 redirect
//   - GET /<anything>    express.static for the web/ dir, with HTML
//                        cache headers (no-cache + no ETag)
//   - GET /api/apps      apps registry for the platform portal
//
// Why extracted: the original app.ts was an 865-line god module.
// Splitting it by domain gives each module a clean test surface
// and lets future route changes (e.g. adding /api/portal-config)
// land in one place without touching chat / game / write logic.
//
// Public API (kept stable for tests / external callers):
//   - AppDescriptor     the type of one entry in APPS
//   - APPS              the registry array
//   - registerPortalRoutes(app, webDir)  mount everything above
// =====================================================================
import express, { type Express } from "express";

export interface AppDescriptor {
  id: string;
  name: string;
  url: string;
  emoji: string;
  description: string;
  status: "ready" | "draft";
}

// Static, code-defined list of apps that hang off the study-buddy
// hub. Each entry maps to a URL the portal page links to. Adding a
// new app = add an entry here + a directory under web/ + its own
// sync endpoints if it has server-side data.
export const APPS: AppDescriptor[] = [
  {
    id: "candy-math-island",
    name: "糖果口算岛",
    url: "/games/candy-math-island/",
    emoji: "🍭",
    description: "10 分钟口算闯关，进位 / 退位 / 应用题。错题自动汇入家长看板。",
    status: "ready",
  },
  {
    id: "multiplication-drill",
    name: "乘法大冒险",
    url: "/games/multiplication-drill/",
    emoji: "✖️",
    description: "1-9 乘法表 60 秒挑战，答错时显示完整 9×9 表。",
    status: "ready",
  },
  {
    id: "write",
    name: "写字练字",
    url: "/write/",
    emoji: "✍️",
    description: "Apple Pencil 写田字格，先看后写，养成观察和笔顺。",
    status: "ready",
  },
];

/**
 * Mount the portal routes on the given Express app.
 *
 * @param app   the Express app
 * @param webDir  absolute path to the static web/ directory
 */
export function registerPortalRoutes(app: Express, webDir: string): void {
  // iOS Safari 经常 page cache 住旧 HTML → 访问 / 强制 302 到带版本号的 URL，
  // 让浏览器把它当成全新 URL 拿新 HTML（带 ?v= 时不再 redirect，避免死循环）
  app.get("/", (req, res, next) => {
    if (Object.keys(req.query).length > 0) {
      return next();  // 有 query string → 让 static 接管
    }
    res.redirect(302, "/?v=" + Date.now());
  });

  // 强制不缓存 HTML（iOS Safari 经常用 cached 旧版导致 send() 失败）
  app.use(express.static(webDir, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith(".html")) {
        res.setHeader("Cache-Control", "no-cache, no-store, must-revalidate");
        res.setHeader("Pragma", "no-cache");
        res.setHeader("Expires", "0");
        // 关掉 ETag：避免 Safari 用 304 Not Modified 拿 cached 旧版
        res.removeHeader("ETag");
        res.setHeader("Last-Modified", new Date().toUTCString());
      }
    },
    etag: false,
    lastModified: false,
  }));

  // Apps registry — read by the portal page to render the home grid.
  app.get("/api/apps", (_req, res) => {
    res.json({ apps: APPS });
  });
}

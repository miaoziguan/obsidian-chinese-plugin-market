import { chromium } from "playwright";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const html = `<!DOCTYPE html><html lang="zh"><head><meta charset="utf-8">
<link rel="stylesheet" href="file://${resolve(__dirname, "..", "styles.css")}">
<style>body{background:#f5f5f5;padding:20px;font-family:sans-serif}.w{max-width:700px;margin:0 auto;background:#fff;padding:12px 16px 16px;border-radius:10px}</style>
</head><body><div class="w"><div class="pt-view"><div class="pt-header">
<div class="pt-header-top">
<button class="pt-toggle-filters" aria-label="展开筛选" aria-expanded="false">⚙</button>
<div class="pt-search"><input type="text" class="pt-search-input" placeholder="搜索中文名、原名、作者或描述…"><button class="pt-search-clear" style="display:none"></button><span class="pt-ai-badge" style="display:none">AI</span></div>
<button class="pt-refresh" type="button" title="刷新">↻</button>
</div>
<div class="pt-mode-tabs">
<button class="pt-mode-tab" aria-pressed="true">关键词</button>
<button class="pt-mode-tab" aria-pressed="false">AI 语义</button>
<button class="pt-mode-tab" aria-pressed="false">分类</button>
</div>
</div></div></div></body></html>`;

(async () => {
  const browser = await chromium.launch({
    executablePath: "/Users/pokerhu/Library/Caches/ms-playwright/chromium-1223/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
  });
  const page = await browser.newPage({ viewport: { width: 700, height: 250 } });
  await page.setContent(html);
  await page.waitForTimeout(300);
  await page.screenshot({ path: resolve(__dirname, "_debug-new-header.png") });
  await browser.close();
  console.log("done");
})();

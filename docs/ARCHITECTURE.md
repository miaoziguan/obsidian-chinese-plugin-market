# 架构文档 / Architecture

Chinese Plugin Market 是一个 Obsidian 社区插件搜索与翻译插件。源码位于 `src/`,采用**七层单向依赖**架构,通过 TypeScript 路径别名(`@layer/*`)引用,构建时打包为单一 `main.js`。

---

## 一、分层总览

```
src/
├─ app/          应用外壳 —— Obsidian Plugin 生命周期、命令注册、设置面板
├─ ui/           表现层 —— 视图、组件、DOM 操作(依赖 Obsidian / 浏览器 DOM)
├─ domain/       业务逻辑 —— 搜索、过滤、推荐、对比、插件目录编排
├─ translation/  翻译子系统 —— 翻译引擎、记忆库、词典、平台翻译
├─ semantic/     语义检索 —— 向量嵌入、向量库、Web Worker
├─ data/         数据访问 —— 缓存存储、网络请求、平台适配
└─ shared/       跨层公共 —— 常量、i18n、日志、通用工具
```

**依赖方向(只能自上而下,禁止回指):**

```
        app
         │
         ▼
        ui
         │
         ▼
      domain ──────┐
         │         │
         ▼         ▼
   translation  semantic
         │         │
         ▼         ▼
        data       │
         │         │
         ▼         ▼
       shared ◄────┘   (shared 是叶子,谁都可依赖)
```

规则:
- 上层可依赖下层,下层**不得**依赖上层。
- `shared` 是公共叶子,任何层都可引用它。
- Obsidian API 只应出现在 `app` 与 `ui` 两层(现状例外见 [§五](#五平台耦合边界))。

---

## 二、各层职责

### `app/` — 应用外壳
Obsidian `Plugin` 子类的入口与装配。

| 文件 | 职责 |
|---|---|
| `main.ts` | 入口,re-export `plugin` 的默认导出 |
| `plugin.ts` | `ChinesePluginMarketPlugin`:onload/onunload、命令与图标注册、数据加载与持久化、依赖装配 |
| `settings-tab.ts` | 设置面板 UI |

这一层是**组合根(composition root)**:创建各子系统实例、注入依赖、注册视图。

### `ui/` — 表现层
一切与 DOM / Obsidian View 相关的代码。

- `ui/view/` — 主视图 `translator-view.ts` 及其编排模块(`view-chrome/data/render/cards/featured/compare/ai-search/toolbar`),以及解耦用的 `view-context.ts`(ViewContext:视图公共状态与动作的扁平投影)。
- `ui/components/` — 可复用展示组件:`card-render`、`detail-drawer`、`compare-view`、`facet-chips`。
- `ui/dom/` — DOM 底层工具:`dom`、`virtual-scroll`、`list-state`。

**ViewContext 模式**:`view-*` 模块的函数签名统一为 `(ctx: ViewContext, ...)`,而非绑定 `this`。视图状态与动作通过 `ctx` 传递,使模块可脱离视图实例独立测试,并把视图对 `plugin` 的耦合收敛到 `DrawerHostPlugin` 最小端口。

### `domain/` — 业务逻辑
核心业务规则,大部分为纯函数,可独立单测。

- `domain/search/` — 检索:`bm25`、`query`、`search-mode`、`ai`(AI 搜索管线)、`ai-explorer`(查询路由分类)。
- `domain/filter/` — 过滤与排序:`filter`、`sort`、`smart-signal`(离线推荐信号)。
- `domain/recommend/` — 推荐:`similar`、`trending`、`featured`、`diversity`、`engine`。
- `domain/compare/` — 对比:`compare`、`compare-export`、`plugin-insight`。
- `domain/catalog/` — 插件目录与编排:`translator`(翻译管线编排器)、`plugin-tags`、`plugin-vm`(统一视图模型)、`coverage`、`mirror`、`stats`。

### `translation/` — 翻译子系统
自成一域的翻译能力。

- `translation/api/` — 翻译客户端:`api`(MyMemory/腾讯/LLM/AI)、`self-hosted`(DeepLX/LibreTranslate)、`guard`、`tencent-signer`。
- `translation/memory/` — 翻译记忆库:`translation-memory`(落盘为 vault 笔记)、`tm-dirty`(脏标记)。
- `translation/lexicon/` — 词典与中文处理:`dictionary`、`synonyms`、`t2s`/`t2s-table`(繁→简)、`pinyin-init`(拼音分组)。
- `translation/platform/` — 平台相关:`macos-shortcuts`(macOS 系统翻译)。

### `semantic/` — 语义检索基础设施
- `embedding`、`vec-store`(SqliteVectorStore,基于 sql.js/WASM)、`vec-codec`。
- `semantic/workers/` — `embedding-worker`(在 Web Worker 内跑 transformers + onnxruntime)、`worker-backend`。

### `data/` — 数据访问
IO、缓存与平台适配基础设施。

- `data/storage/` — `plugin-storage`(缓存文件读写)、`insight-cache`、`ai-asset-store`。
- `data/net/` — `net`(HTTP 请求端口,封装 Obsidian `requestUrl`)。
- `data/platform/` — `obsidian-internals`(Obsidian 内部 API 适配)。

### `shared/` — 跨层公共
`constants`(`VIEW_TYPE`/`LAYOUT`/`SEARCH_MODES`/URL)、`i18n`(文案字典 + `makeT`)、`logger`、`utils`。纯逻辑,零平台依赖。

---

## 三、路径别名

每层对应一个别名,`tsconfig.json` 的 `compilerOptions.paths` 是**唯一来源**:

| 别名 | 指向 |
|---|---|
| `@app/*` | `src/app/*` |
| `@ui/*` | `src/ui/*` |
| `@domain/*` | `src/domain/*` |
| `@translation/*` | `src/translation/*` |
| `@semantic/*` | `src/semantic/*` |
| `@data/*` | `src/data/*` |
| `@shared/*` | `src/shared/*` |

导入示例:
```ts
import { logger } from "@shared/logger";
import { Translator } from "@domain/catalog/translator";
import { renderFacetChips } from "@ui/components/facet-chips";
```

---

## 四、构建与测试如何解析别名

三个工具各自解析同一套别名,但机制不同:

| 工具 | 别名来源 | 说明 |
|---|---|---|
| **tsc**(类型检查) | tsconfig `paths` | 原生读取,唯一来源 |
| **esbuild**(打包 `main.js`) | tsconfig `paths` | 原生读取 —— `esbuild.config.mjs` 显式传 `tsconfig: "tsconfig.json"`,不重复声明别名 |
| **vitest**(测试) | `vitest.config.ts` 的 `resolve.alias` | 手写 7 行(`vite-tsconfig-paths` 插件为 ESM-only,与当前 CJS 配置不兼容,故手写) |

**构建入口**(`esbuild.config.mjs` 硬编码,移动入口文件时需同步):
- 主 bundle:`src/app/main.ts`
- Worker bundle:`src/semantic/workers/embedding-worker.ts`(先打包再内联进 `main.js`)

命令:
```bash
npm run dev      # 开发构建
npm run build    # tsc 类型检查 + esbuild 生产构建
npm test         # vitest
```

---

## 五、平台耦合边界

理想状态:Obsidian API 只出现在 `app` 与 `ui`。目前下层仍有 6 处直接依赖 `obsidian`,是后续解耦的目标:

| 文件 | 依赖内容 | 解耦方向 |
|---|---|---|
| `data/net/net.ts` | `requestUrl` | 已是 HTTP 端口雏形,让上层经它注入 |
| `data/storage/plugin-storage.ts` | 文件 IO | 抽象为存储端口接口 |
| `domain/catalog/stats.ts` | `requestUrl` | 改经 `data/net` 注入 |
| `translation/api/api.ts` | `requestUrl` | 改经 `data/net` 注入 |
| `translation/memory/translation-memory.ts` | vault 笔记读写 | 抽象为笔记存储端口 |
| `translation/platform/macos-shortcuts.ts` | 平台调用 | 平台层本就允许,可保留 |

解耦手法:下层定义接口(端口),由 `app` 层在装配时注入 Obsidian 实现(依赖倒置)——`ui` 层的 `ViewContext` 已示范此模式。

---

## 六、新增模块指引

1. **判断归属层**:它依赖 DOM/Obsidian 吗?→ `ui`。是纯业务规则吗?→ `domain`。是翻译/向量/存储?→ 对应子系统。跨层通用?→ `shared`。
2. **放进对应子目录**,用 kebab-case 命名。
3. **import 一律用别名**(`@layer/*`),不要写 `../../` 相对路径跨层引用。
4. **遵守依赖方向**:只向下依赖。若发现需要向上依赖,说明职责放错了层,或应通过接口注入(依赖倒置)。
5. **纯逻辑优先**:能不碰 Obsidian 就不碰,便于单测。

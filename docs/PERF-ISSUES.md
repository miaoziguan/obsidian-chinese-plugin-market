# 性能压榨点清单 — 中文区插件市场（obsidian-plugin-translator）

> **探查日期**：2026-08-10（基线 v2.15.0）
> **探查方式**：三路只读源码扫描（UI 渲染 / 翻译缓存网络 / 搜索向量启动构建），所有候选点附「文件:行号」证据。
> **重要原则**：本仓库此前多个「性能优化」探索（卸载清理、缓存命中率、搜索索引复用）**实证后均为伪需求**——核心热路径已优化到位。因此本清单每条都标注「需先实证」，**动手前必须先 profile 量出真实耗时，不得凭 grep 计数或表面推断下结论**。

**列表规模基线**：插件列表约 5617 项，窗口化渲染 ≤250 节点/帧，向量索引全库 ~6000 条。

---

## 总评

核心热路径（虚拟滚动、卡片池化、防抖合并、索引缓存、增量落盘、worker 化推理、WASM 延后加载）**已是优化后的形态**。剩余可压榨点集中在三类：

1. **缓存命中路径上仍全量重算**（复用判定本身 O(N)）
2. **worker 源码内联进 main.js**（975KB 产物最大单点）
3. **启动后无条件初始化向量库**（对从不用向量搜索的用户是浪费）

按预估收益排序如下。除 P0-1 外，多数在几百到几千规模下预计只是几 ms 级，**建议先 profile 再动手**。

---

## P0（高收益，优先实证）

### PERF-1 熔断 24h 过激：单次超时即熔断整天（可用性/正确性，重点）

- **现象**：`isFatalError` 把 `TimeoutError` 归为 fatal（`src/translation/api/guard.ts:111-114`），`recordFailure(fatal)` 无视阈值立即开路（`guard.ts:95-100`）；腾讯与 LLM 熔断器 fatal 冷却为 **24h**（`src/translation/api/api.ts:324`、`api.ts:354`）。即：弱网下 LLM 一次 30s 超时 / 腾讯一次 5s 超时，该来源当天被完全跳过，降级走质量更差的兜底。Google/MyMemory 的 fatal 冷却缺省=60s（`api.ts:57/191`），无此问题。
- **预估收益**：高（消除「一次抖动=24h 降级」）。
- **需先实证**：否（逻辑可单测确认）。改动前需确认 24h 的设计意图仅针对鉴权/配额，而非瞬时网络超时。

### PERF-2 稳态搜索的全库 t2s + hash 重算（复用判定 O(N)）

- **现象**：`search()` 每次调 `buildVectorIndex`（`src/domain/search/ai.ts:433`），即使 `needBuild=false` 只是复用索引，仍对全量 ~6000 插件做文本拼装 + `t2sForEmbed` + 全量 `contentHash`（`src/semantic/embedding.ts:306-326`），外加 `ai.ts:411-414` 的全量 `indexPlugins` 映射。叠加：`t2sForEmbed` 逐字符拼接且 `hasCJK` 快判未在入口短路（`src/translation/lexicon/t2s.ts:14-27`），被全库调用（`embedding.ts:322`、`ai.ts:79`）。
- **预估收益**：每次 AI/本地搜索省数十~上百 ms，连续输入防抖场景叠加明显。
- **需先实证**：是。已有探针日志 `ai.ts:449`（`索引构建/复用=${buildMs}ms`）可直接读数确认。

### PERF-3 worker bundle 以字符串内联进 main.js（构建产物最大单点）

- **现象**：transformers.web.js（源 1.05MB）+ ort.webgpu（110KB）打成 worker bundle 后经 `JSON.stringify` 内联进 main.js（`esbuild.config.mjs:82-97, 112-133`；消费处 `src/semantic/workers/worker-backend.ts:13`）。纯关键词用户也在插件加载时解析这段巨字符串。可改为 worker bundle 作为独立文件随插件分发，首次 local 搜索时经 adapter 读入再 Blob 实例化（读文件基建已存在于 `plugin.ts:1230-1238`）。
- **预估收益**：main.js 预计可缩减一半以上，插件加载/编译时间明显下降（Obsidian 启动总时长受益）。
- **需先实证**：是。用 esbuild `metafile: true` 出一次组成分析，确认 worker 字符串与 sql.js 各占多少再动刀。

### PERF-4 批量翻译并发分层（LLM/Google 固定并发=2 过保守）

- **现象**：`translateBatch` 在线阶段 CONCURRENCY=2（`src/domain/catalog/translator.ts:806-808`），注释是按 MyMemory ≤5 QPS 定的，但同一并发度也约束了第 4 层 AI（LLM，单次超时 30s）与 Google。数千条待译时 2 并发 × 每条数秒 = 数十分钟级。
- **预估收益**：高（按源分层并发：LLM 4-8、MyMemory 保持 2，批量耗时可缩 2-4 倍）。
- **需先实证**：是（需实测 DeepSeek 等端点的 rate limit 与 Google 非官方接口的隐性限流）。

---

## P1（中收益，实证后决定）

### PERF-5 translator-cache.json 全量序列化 + 无条件重写

- **现象**：`saveTranslatorCache` 每次把 cache+aiDict+insights+coverage+seenPluginIds 整体 stringify（`src/data/storage/plugin-storage.ts:164-184`）；入口 `_saveTranslatorDataImmediate` 每次还 O(n) 重建 persistCache（`src/app/plugin.ts:694-708`）。无脏标记/内容哈希短路。触发点密集：加载期 3 连调（`view-data.ts:187/198/203`）、每张卡系统翻译、洞察弹窗。800ms 防抖只合并频率，不降单次成本。
- **预估收益**：中（cache 数千条时单次 stringify+写约 10-30ms；加 dirty-flag 或拆文件只写脏块）。
- **需先实证**：是（先量文件大小与 stringify 耗时再决定拆片还是脏标记）。

### PERF-6 向量库启动后无条件初始化（应真懒加载）

- **现象**：加载在 onLayoutReady 后的延迟任务里（`plugin.ts:194-198, 381`），链路：读 644KB wasm → 实例化 sql.js → 读库 → 反量化全部向量 → 逐条归一化（`plugin.ts:1438-1444`，约 12MB Float32 常驻内存）。keyword 模式用户也用不到。可改为「首次向量搜索才 ensureVectorStore + loadVectorIndex」。
- **预估收益**：中（启动后任务省数十~数百 ms + 十几 MB 内存）。
- **需先实证**：是。探针已埋好（`plugin.ts:1223/1229/1241/1484`），先看真实耗时。

### PERF-7 onload 多个独立存储读串行（可 Promise.all）

- **现象**：`loadData` → `loadSettings`（内部串行 await `loadCredentials`、`loadFavorites`，`plugin.ts:470/482`）→ `loadTranslatorData`（await `loadTranslatorCache`，`plugin.ts:570`）→ `loadPluginRecommend`（`plugin.ts:192`）四文件互相无依赖，可并行。另 `initDeferredLoad` 中 `scanVaultTM` → `loadVectorIndex` → `loadStatsCache` → `loadTrendingHistory` 依次 await（`plugin.ts:369-386`），后三项不依赖 TM。
- **预估收益**：小-中（translator-cache.json 可能 MB 级，串行总耗数十 ms，并行约减半）。
- **需先实证**：是（加 performance 探针量各读耗时）。

### PERF-8 updateAiTranslateButton 每次渲染 O(N) 全量计数

- **现象**：`postRenderSync` 在包括签名命中路径的每次 `renderPluginList` 都调用（`src/ui/view/view-render.ts:66, 71, 207-213`），内部对 visibleList 全量循环调 `ctx.isTranslated` → `hasAnyTranslation`（`src/domain/catalog/translator.ts:406-414`）；TM 命中时 `lookupTMApproved` 每次还新分配 TranslateResult 对象（`translator.ts:600-603`）。5617 项 × 每次渲染 = 数千次查表 + 对象分配。
- **预估收益**：中（计数可缓存/仅在筛选相关时重算）。
- **需先实证**：是（在 5617 全量列表下 profile 一次 scheduleRender）。

---

## P2（低-中收益，边角优化）

### PERF-9 query embedding 无缓存（重复 query 重复花钱）
- 每次搜索 `vectorRecallScores` 重新 embed query（`src/semantic/embedding.ts:415`），API 模式即一次网络往返；同一 query 或微调一字符都重算。加 (model+query) LRU 即可，风险低。**需先实证：否**。

### PERF-10 窗口越界整窗 replaceChildren
- `updateWindowImpl` 步骤 4 用 `layer.replaceChildren(...)` 重写整窗 ~250 节点（`src/ui/view/view-render.ts:554-561`），即使只滑动 1 行。节点是复用的，但每帧移动 250 个 DOM 子节点有重排成本。可改为只换入/换出差集行。**需先实证：是**（快速甩动时录屏看 layout 耗时）。

### PERF-11 fillVisibleWindow 二次窗口计算造成读写交替（layout thrashing）
- `updateWindowImpl` 在 `replaceChildren` 写 DOM（`view-render.ts:561`）后，`fillVisibleWindow` 再次 `computeVisibleWindowRange` 读 `vp.scrollTop / vp.clientHeight`（`view-render.ts:602 → 260`），随后 `applyCardState` 又写。窗口区间其实已在步骤 2 算过、可直接传入。**需先实证：是**（看 forced reflow 计数）。

### PERF-12 相似推荐候选分词每次打开抽屉重复计算
- `scoreSimilarity` 对每个候选现场 `tokenize(candidateDesc)`（`src/domain/recommend/similar.ts:236`），热门分类候选上千；且 `computeSimilarFor` 每次打开还重建全量 translatedMap O(N)（`src/ui/view/view-cards.ts:74-78`）。可在 `InvertedIndex.build`（`similar.ts:62-89`）时预存候选 token Set。**需先实证：是**（对热门分类插件计时一次回填）。

### PERF-13 SQLite 批量写未包事务
- `replaceAll`（`vec-store.ts:107-130`）与 `upsertMany`（`vec-store.ts:137-155`）逐行 `stmt.run`，sql.js 每条语句自动提交；全量重建 6000 行无 BEGIN/COMMIT。仅影响一次性场景，写入提速约 2-5 倍。**需先实证：否**，但优先级低。

---

## 微小项（可顺手，不必单列）

- **排序不随前缀缓存增量**：`filter.ts:427-434` 每次渲染全量 O(n log n) sortPlugins，sortFavoritesFirst 再叠加一次（`filter.ts:437-445`）。前缀缓存只省过滤没省排序。
- **applyCardState 显隐写入合并**：每卡 ~10 次 `setCssStyles({display})`（`card-render.ts:481-586`）无论值是否变化都重写。
- **highlight terms 正则上提**：`highlightInto` 每卡每次填充重新 `new RegExp` + 排序（`card-render.ts:46-54`），可上提到调用方一次。
- **esbuild 死配置**：主 bundle 的 transformers/ort alias（`esbuild.config.mjs:101-107`）主线程无 import，可删；`.wasm: binary`（`:147`）建议 metafile 顺带确认未被意外内联。
- **`tokenizeCJK` 每字符两次 `regex.test`**（`bm25.ts:17-21`）可用 charCode 范围替代。
- **`expandQuery` 每次调用现场 `new RegExp`**（`synonyms.ts:158-159`），预编译即可。
- **滚动监听未加 `{ passive: true }`**（`view-chrome.ts:493`）。
- **ort wasm 单线程可换小版**：worker 强制 `numThreads=1`（`embedding-worker.ts:92`），可评估换更小的非 threaded `ort-wasm-simd.wasm` 分发。
- **抽屉 README 无缓存**：`loadReadme` 每次开抽屉重复拉（`detail-drawer.ts:790`），可加会话级 Map 缓存。
- **洞察三路抓取中 README 无谓等 manifest**：`gatherInsightSources`（`plugin-insight.ts:252-256`）README URL 不依赖 manifest，可与 manifest 同发。
- **插件列表 4s 硬超时偏短**：`fetchPlugins` `Promise.race` 4000ms（`view-data.ts:337-341`），弱网易误判失败。
- **`buildExplainability` 重复 expandQuery + tokenizeForBM25**（`ai.ts:691-693`）。

---

## 不建议动（已优化到位 / 有意为之）

- 虚拟滚动窗口化、卡片池化（refs WeakMap / SVG 单解析 / 事件委托）
- 搜索输入 200ms 防抖 + IME 守卫、rAF 合并渲染
- BM25 索引缓存、精排单次批量调用、inFlight 翻译去重
- stats/trending/插件列表独立缓存文件、TM 快照 baseline+delta 分片
- SQLite 向量库 30s 空闲 flush + 100 变更阈值
- 暖启动 3000ms / tmApprovedReady 30s / 视图 15s 分层安全阀

---

## 行动建议

1. 先跑 **esbuild metafile 分析**（PERF-3）和 **ai.ts:449 探针读数**（PERF-2），拿到硬数据再定 P0 优先级。
2. P0-1（熔断 24h）逻辑可直接单测确认，无需 profile。
3. 其余每条动手前先埋 performance 探针或录屏，量化收益后再提交。

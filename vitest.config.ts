import { defineConfig } from "vitest/config";
import { resolve } from "path";

/**
 * 测试环境把 `obsidian` 模块指向本地 mock（test/mocks/obsidian.ts），
 * 因为真实 obsidian 运行时 API 在 Node/vitest 下不可用。
 * 需要网络行为的用例，各测试文件用自己的 mock provider 覆盖，不走真实 requestUrl。
 */
export default defineConfig({
	resolve: {
		alias: {
			"@shared": resolve(__dirname, "src/shared"),
			"@app": resolve(__dirname, "src/app"),
			"@ui": resolve(__dirname, "src/ui"),
			"@domain": resolve(__dirname, "src/domain"),
			"@translation": resolve(__dirname, "src/translation"),
			"@semantic": resolve(__dirname, "src/semantic"),
			"@data": resolve(__dirname, "src/data"),
			obsidian: resolve(__dirname, "test/mocks/obsidian.ts"),
		},
	},
	test: {
		include: ["src/**/*.test.ts"],
		environment: "jsdom",
		setupFiles: ["./test/setup.ts"],
		coverage: {
			provider: "v8",
			reporter: ["text-summary", "json-summary"],
			reportsDirectory: "./coverage",
			/**
			 * 统计口径收窄至 src 生产代码。
			 * 不排除的话，被个别测试加载的 scripts/*.mjs、根产物 main.js、
			 * embedding-worker.bundle.js 会一并计入分母，把整体覆盖率拉低约 5 个百分点
			 * （实测 58.2% vs 63.6%），掩盖分层差异。
			 */
			exclude: [
				"scripts/**",
				"test/**",
				"main.js",
				"*.bundle.js",
				"**/*.test.ts",
				"**/*.d.ts",
				"esbuild.config.mjs",
				"node_modules/**",
			],
			/**
			 * 棘轮（ratchet）基线 —— 取「当前实测值」而非「希望达到的值」。
			 *
			 * 第 1 版（接入当天，收窄口径后）：lines/statements 61.59%、functions 59.32%、
			 *   branches 78.81% → 阈值定为 60 / 58 / 77（留 ~1.5pt 抖动余量，当前必 PASS）。
			 * 第 2 版（补齐 view-toolbar 测试后）：lines/statements 63.86%、functions 59.85%、
			 *   branches 78.96% → 阈值上调为 62 / 58 / 77。
			 * 第 3 版（补齐 settings-tab 测试后）：lines/statements 65.85%、functions 60.34%、
			 *   branches 79.14% → 阈值上调为 64 / 59 / 78。
			 * 第 4 版（补齐 settings-tab 的「有数据」渲染分支后）：66.43% / 61.02% / 79.28%
			 *   → 阈值上调为 65 / 60 / 78。
			 * 第 5 版（补齐 AI 连接测试的 HTTP 全分支后）：66.59% / 61.16% / 79.23%
			 *   → lines/statements 上调为 66；functions 61.16 与 branches 79.23 距整数仅 0.16/0.23pt，
			 *     余量过薄（一次删测试即破），故 functions/branches 暂维持 60 / 78 待下轮提升。
			 * 第 6 版（补齐百度全错误码 + 设置页翻译开关/缓存清理/联动重试后）：
			 *   66.73% / 61.26% / 79.50% → branches 上调为 79；lines 66、functions 60 维持
			 *   （66.73 距 67 只差 0.27，61.26 距 62 差 0.74，余量不足，不得再拧）。
			 * 第 7 版（补齐随包静态清单加载器 + initDeferredLoad 后）：
			 *   67.27% / 61.88% / 79.68% → functions 上调为 61；
			 *   lines 67.27 距 67 仅 0.27、branches 79.68 距 80 仅 0.32，余量不足，维持 66 / 79。
			 * 第 8 版（补齐 createCssStore 后）：67.55% / 62.37% / 79.84%
			 *   → lines/statements 上调为 67；functions 62.37 距 62 只差 0.37、branches 79.84 距 80 差 0.16，维持 61 / 79。
			 * 第 9 版（补齐 journal / TM 落盘路径后）：67.87% / 62.58% / 80.01%
			 *   → functions 上调为 62；branches 虽刚过 80 但余量仅 0.01pt（任何微调即破），仍维持 79；
			 *     lines 67 距 68 差 0.13，维持 67。
			 * 第 10 版（补齐翻译缓存落盘 / 向量库初始化 / 丝带菜单后）：
			 *   68.20% / 63.00% / 80.13% —— 三项实测都紧贴整数（差 0.20 / 0.00 / 0.13pt），
			 *   按「余量 < 0.5pt 不拧」规则一项都不能动，维持 67 / 62 / 79。
			 *   这不是停滞：阈值已在 10 轮内从 60/58/77 抬到 67/62/79，累计 +7 / +4 / +2pt。
			 * 第 11 版（把 onload 的下载闭包抽成 model-download-bridge 并补测后）：
			 *   68.54% / 63.20% / 80.11% → lines/statements 上调为 68（余量 0.54）；
			 *   functions 63.20 距 63 仅 0.20、branches 80.11 距 80 仅 0.11，维持 62 / 79。
			 * 第 12 版（抽出命令诊断体与启动防护后）：68.74% / 63.21% / 80.21%
			 *   → 三项距上一个整数分别为 0.74 / 0.21 / 0.21pt，维持 68 / 62 / 79。
			 *   本轮价值不在数字：新增的两个模块各 100% 覆盖，且它们原先都是
			 *   「callback 内联 / 出事才执行」的死区——这类代码删掉不会有测试变红。
			 * 第 13 版（进入 ui/ 层，补齐 view-data 的数据管线后）：69.09% / 63.79% / 80.90%
			 *   → functions 上调为 63、branches 上调为 80（余量 0.79 / 0.90）；
			 *     lines 69.09 距 69 仅 0.09，维持 68。
			 * 第 14 版（补齐 ensureDataLoaded 加载状态机后）：69.77% / 64.04% / 80.89%
			 *   → lines/statements 上调为 69（余量 0.77）；functions 64.04 距 64 仅 0.04、
			 *     branches 距 81 差 0.11，维持 63 / 80。
			 * 第 15 版（补齐对比页渲染器后）：70.74% / 64.96% / 80.94%
			 *   → lines/statements 上调为 70、functions 上调为 64（余量 0.74 / 0.96）；
			 *     branches 距 81 仅 0.06，维持 80。
			 * 第 16 版（补齐卡片的收藏/安装/卸载与筛排管线后）：
			 *   71.31% / 65.46% / 81.18% —— 三项距上一整数 0.31 / 0.46 / 0.18pt，
			 *   均不足 0.5pt 余量，维持 70 / 64 / 80。连续两轮出现「差一点点」是
			 *   正常的：越往上走，单个文件的增量对全仓百分比的推动越小。
			 * 第 17 版（补齐卡片交互：点击分发 / 键盘漫游 / 跨窗口焦点后）：
			 *   71.80% / 65.64% / 81.26% → lines 上调为 71、functions 上调为 65
			 *   （余量 0.80 / 0.64）；branches 距 81 仅 0.26，维持 80。
			 * 第 18 版（补齐虚拟滚动调度层后）：71.96% / 66.07% / 81.26%
			 *   → 全部维持（距上一整数 0.04 / 0.07 / 0.26，全都不足 0.5pt）。
			 *   注意边际收益已明显衰减：本轮 17 个用例 +66 条覆盖，只推动全局 +0.16pt；
			 *   继续在同一文件深挖的性价比低于换更大的块（如 detail-drawer 的 1195 条）。
			 * 第 19 版（开始啃 detail-drawer 的生命周期与判定逻辑）：72.24% / 66.89% / 81.45%
			 *   → functions 上调为 66（余量 0.89）；lines 距 72 差 0.24、branches 距 81 差 0.45，
			 *     均不足 0.5pt，维持 71 / 80。
			 * 第 20 版（补齐 buildContent 同步渲染分支后）：73.45% / 67.69% / 81.07%
			 *   → functions 上调为 67（余量 0.69）；lines 距 73 差 0.45、branches 距 81 差 0.07，
			 *     均不足 0.5pt，维持 71 / 80。本轮 buildContent 一次调用覆盖大量行，
			 *     detail-drawer 单文件 34.8% → 62.7%（+460 条）。
			 * 第 21 版（补齐 README 加载/渲染/网络错误降级后）：73.72% / 67.83% / 81.11%
			 *   → lines 上调为 72（余量 1.72）；functions 距 68 差 0.17、branches 距 81 差 0.11，
			 *     均不足 0.5pt，维持 67 / 80。detail-drawer 单文件 62.7% → 69.8%（+117 条）。
			 * 第 22 版（补齐 sysTranslate 翻译流程后）：73.97% / 67.91% / 81.09%
			 *   → lines 上调为 73（余量 0.97）；functions 距 68 差 0.09、branches 距 81 差 0.09，
			 *     均不足 0.5pt，维持 67 / 80。detail-drawer 单文件 69.8% → 76.2%（+104 条）。
			 * 第 23 版（补齐版本固定 / 评测编辑区两个可选端口后）：74.13% / 67.98% / 81.26%
			 *   → 全部维持 73 / 67 / 80。lines 距 74 仅 0.13、functions 距 68 差 0.02、
			 *     branches 距 81 差 0.26，三项都不足 0.5pt 余量——此时上调到 74 会让 CI
			 *     只剩 0.13pt 缓冲，任何微小回落都立刻转红，正是该余量规则要防的情况。
			 *     detail-drawer 单文件 76.2% → 80.3%（+69 条）。
			 * 第 24 版（啃 view-render 真·虚拟滚动渲染路径后）：74.82% / 68.13% / 81.22%
			 *   → lines 上调为 74（余量 0.82）；functions 距 68 差 0.13、branches 距 81 差 0.22，
			 *     均不足 0.5pt，维持 67 / 80。此前 view-render 只覆盖了「无视口降级」的早退分支，
			 *     本轮补上 renderWindow 非空分支 + updateWindowImpl + fillVisibleWindow，
			 *     view-render 单文件 40.7% → 81.6%（+293 条）。
			 * 第 25 版（补 view-render 入口与同步层后）：75.08% / 68.40% / 81.29%
			 *   → 全部维持 74 / 67 / 80。lines 距 75 仅 0.08、functions 距 68 差 0.40、
			 *     branches 距 81 差 0.29，三项都不足 0.5pt 余量（functions 是卡在 0.40 的
			 *     临界值，仍按规则不上调）。view-render 单文件 81.6% → 97.4%（+113 条），
			 *     仅剩 19 行未覆盖，可视为啃完。
			 * 第 26 版（啃 view-chrome 空态体系与视图骨架后）：76.09% / 69.20% / 81.37%
			 *   → lines 上调为 75（余量 1.09）、functions 上调为 68（余量 1.20）；
			 *     branches 距 81 差 0.37，不足 0.5pt，维持 80。
			 *     view-chrome 单文件 12.5% → 92.7%（+430 条，全周期单文件最大跃升）：
			 *     它此前是 ui 层最大的未覆盖缺口（469 条语句、仅 29 行测试）。
			 * 第 27 版（啃 createViewContext 委派层后）：77.05% / 74.13% / 82.18%
			 *   → lines 上调为 76、functions 上调为 69、branches 上调为 81
			 *     （余量 1.05 / 5.13 / 1.18；仍按每轮 +1pt 的节奏，不一次吃满）。
			 *     view-context 单文件 54.4% → 100.0%（888/888 全覆盖）：约 400 个
			 *     getter/setter 的函数体只有被读写才计入覆盖，光建对象不算——
			 *     故用遍历逐个读写，既覆盖也顺带验证委派两侧指到同一处。
			 * 第 28 版（啃 card-render 卡片骨架与状态填充后）：77.59% / 74.36% / 82.90%
			 *   → lines 上调为 77、functions 上调为 70、branches 上调为 82
			 *     （余量 0.59 / 4.36 / 0.90；仍按每轮 +1pt 的节奏）。
			 *     card-render 单文件 68.6% → 91.4%（+317 条）：createCardElement /
			 *     updateInstallButton / handleCardSysTranslate / applyCardState 这
			 *     ~675 行此前完全没跑到（旧测试只碰了 createPluginCard）。
			 * 第 29 版（补齐 view-data 数据管线副作用后）：78.22% / 74.74% / 82.94%
			 *   → functions 上调为 71（余量 3.74）；lines 距 78 仅 0.22、branches 距 83 差 0.06，
			 *     两项都不足 0.5pt 余量，维持 77 / 82。
			 *     view-data 单文件 63.7% → 90.7%（+331 条）：旧测试只覆盖纯逻辑，
			 *     refreshData / refreshOutdated / aiTranslateAllPending / reportNewPluginDelta /
			 *     refreshCardTranslation / disposeViewDataCache 这 ~360 行此前完全没跑到。
			 * 第 30 版（啃 view-toolbar 事件处理器与模式切换后）：78.61% / 75.08% / 83.03%
			 *   → lines 上调为 78（余量 0.61）、functions 上调为 72（余量 3.08）；
			 *     branches 距 83 仅 0.03，不足 0.5pt，维持 82。
			 *     view-toolbar 单文件 72.4% → 86.1%（+163 条）：旧测试只驱动 buildToolbar
			 *     结构契约，applySearchMode（259-342 模式切换大块）与全部事件处理器体
			 *     （预设菜单 / 一键全更 / AI 翻译 / 检查更新 / 溢出菜单 / 折叠面板）此前没触发。
			 * 第 31 版（啃 view-cards 卡片事件与入口函数后）：78.88% / 74.93% / 83.08%
			 *   → functions 上调为 73（余量 1.93）；lines 距 79 差 0.12、branches 距 83 差 0.08，
			 *     两项均不足 0.5pt 余量，维持 78 / 82。
			 *     view-cards 单文件 68.1% → 87.0%（+163 条）：既有 view-cards.test.ts /
			 *     view-cards-interaction.test.ts 把 ctx.flashAction / ctx.openDetailDrawer 都
			 *     mock 成 vi.fn()，导致这 4 个真实函数体（openDetailDrawer / computeSimilarFor /
			 *     flashAction 以及 insight 分支）零覆盖；本批直接调用真实函数 + 派发事件补齐。
			 * 第 32 版（啃 journal-table 渲染与交互后）：79.32% / 75.09% / 83.22%
			 *   → functions 上调为 74（余量 1.09）；lines 距 79 差 0.32、branches 距 83 差 0.22，
			 *     两项均不足 0.5pt 余量，维持 78 / 82。
			 *     journal-table 单文件 45.7% → 99.4%（+191 条）：旧测试只测纯函数，
			 *     renderJournalTable（167-352 全 185 行）一行没跑到；残余 2 行是 fmtDate
			 *     的 catch 兜底（Invalid Date 实际不抛错，属不可达防御代码）。
			 * 第 33 版（转向非 ui 层最大块 app/plugin.ts 后）：79.74% / 75.85% / 83.28%
			 *   → lines 上调为 79（余量 0.74）、functions 上调为 75（余量 0.85）；
			 *     branches 距 83 仅 0.28，不足 0.5pt，维持 82。
			 *     app/plugin.ts 单文件 64.2% → 69.3%（+175 条）：既有 8 个 plugin*.test.ts
			 *     覆盖了 css-store / journal-tm / loaders / ribbon / translator-save /
			 *     vector-store / updater，但台账跳转、组合预设 CRUD 与命令注册、
			 *     社区插件设置页、插件/CSS 片段切换命令这几组一行没跑到。
			 *     注意：mock 里 Plugin 是空类、Notice 是普通 class（非 spy），
			 *     需自行打桩 addCommand/removeCommand 并把 Notice 换成 spy。
			 * 第 34 版（啃 plugin.ts 的 onload 启动编排后）：80.71% / 75.85% / 83.38%
			 *   → lines 上调为 80（余量 0.71）；functions 实测 75.85% < 76，不足以上调，维持 75；
			 *     branches 距 83 仅 0.38，不足 0.5pt，维持 82。
			 *     app/plugin.ts 单文件 69.3% → 81.1%（+218 条）：onload()（491-771，约 280 行启动编排）
			 *     此前整段未覆盖——既有 plugin*.test.ts 从不调用 onload（被当成只能手测的集成入口）。
			 *     但这段绝大多数是顺序编排（装配端口 / 注册视图·命令·ribbon·设置页 / 武装 tmApproved
			 *     安全阀 / 两个 onLayoutReady 延迟体 / 卸载清理），逻辑分支极少，直接调用 onload +
			 *     把重 IO 子加载器 stub 掉即可一次性覆盖；JournalView 工厂闭包（606-633）经 mock 成
			 *     哑类后调用工厂覆盖。armTmApprovedSafetyValve 的 30s setTimeout 需用 fake timers 防挂起。
			 * 第 35 版（啃 plugin.ts 的 buildLocalIndex 完整 embed 闭环后）：81.04% / 76.23% / 83.61%
			 *   → branches 上调为 83（余量 0.61）；lines 实测 81.04 → 到 81 余量 0.04、
			 *     functions 实测 76.23 → 到 76 余量 0.23，两项均不足 0.5pt，维持 80 / 75。
			 *     app/plugin.ts 单文件 84.6% → 85.1%：buildLocalIndex 的 embed 主流程（3113-3256，约 145 行）
			 *     此前一行没跑到——既有 vector-status 测试只覆盖了它的早返回分支（无插件数据 / 并发去重 /
			 *     已请求卸载）。本轮把 buildVectorIndex 换成可控桩，真正调用 provider.embed 驱动 embed 闭包，
			 *     再回调 onPartial 增量发布 / 落盘 / error / finally 脏重跑，覆盖整段构建编排。
			 * 第 36-40 版（持续啃 plugin.ts 散落段）：81.36% / 76.67% / 83.89%
			 *   → functions 上调为 76（余量 0.67）；lines 实测 81.36 → 到 81 余量 0.36、
			 *     branches 实测 83.89 → 到 84 差 0.11，两项均不足 0.5pt，维持 80 / 83。
			 *     plugin.ts 单文件 81.1% → 89.0%（+783 条）：settings-load（翻译源配置同步 /
			 *     内联译名迁移 / plugin-tags 离线分类）、install-history 记账、buildLocalIndex 完整
			 *     embed 闭环、translator 缓存防抖落盘 + 清空已采纳 TM、TM vault 事件实时发现/清理、
			 *     waitMetadataResolved 超时兜底、loadLegacyVectorIndex 旧版 .bin/.json 一次性迁移。
			 * 第 41-48 版（持续啃 plugin.ts 大方法内部缺口）：82.04% / 77.84% / 84.58%
			 *   → branches 上调为 84（余量 0.58）；lines/statements 实测 82.04 距 82.5 还差 0.46、
			 *     functions 实测 77.84 → 到 78 差 0.16，两项均不足 0.5pt，维持 81 / 77。
			 *     plugin.ts 单文件 94.4% → 97.4%（+319 条）：saveJournalEntry 视图刷新、renameSnippetPrompt
			 *     弹窗、runIncrementalRescan 删除分支、backfillInstallHistory、openManageGroups、loadPluginDeps，
			 *     以及 loadSettings 大方法的旧版迁移全分支（locale/sourceFilter/versionPins/translateSettings/
			 *     credentials/favorites/translator-cache/embedding 模型与来源/移动端降级）。
			 *
			 * 第 49 版（转进啃 ui 层薄弱文件）：全局 82.42% / 78.57% / 84.77%
			 *   → functions 上调为 78（余量 0.57）；lines/statements 实测 82.42 距 82.5 还差 0.08、
			 *     branches 实测 84.77 → 到 85 差 0.73，两项均不足 0.5pt，维持 81 / 84。
			 *     ui 层整体 83.4% → 84.1%；installed-watch.ts 16.0% → 96.2%（+105 条）：桌面 fs.watch /
			 *     移动轮询 / 快照 diff / recordInstallDiff / applyCardState 原地刷新 / disposer 释放。
			 *
			 * 第 50 版（续啃 ui 层弹窗）：全局 82.71% / 79.17% / 84.83%
			 *   → lines/statements 上调为 82（实测 82.71 ≥ 82.5，余量 0.21）；functions 实测 79.17 距 79.5
			 *     还差 0.33、branches 实测 84.83 → 到 85 差 0.67，两项均不足 0.5pt，维持 78 / 84。
			 *     ui 层整体 84.9%；三个弹窗 confirm-modal 16.3%→100%、prompt-modal 27.3%→98.5%、
			 *     snippet-rename-modal 30.3%→90.9%（共 +160 条）：vi.mock("obsidian") 最小 Modal/Setting
			 *     /TextComponent/ButtonComponent，覆盖输入弹窗 commit/Enter 提交、破坏性确认/取消、
			 *     重命名空值/同名短路。
			 *
			 * 第 51 版（续啃 ui 层落地页推荐区）：全局 83.48% / 79.53% / 84.85%
			 *   → functions 上调为 79（实测 79.53 ≥ 79.5，余量 0.03，已逼近上限）；lines 实测 83.48 距
			 *     83.5 仅差 0.02、branches 实测 84.85 → 到 85 差 0.65，两项均不足 0.5pt，维持 82 / 84。
			 *     ui 层整体 87.1%（函数 83.3% / 分支 84.6%）；view-featured.ts 15.1%→94.6%（+194 条）：
			 *     展示条件门禁、推荐集为空/非空、签名缓存命中（内容+安装签名）、折叠态同步显隐、
			 *     ensureFeaturedSection 构建与 toggle 折叠切换、hideFeaturedSection。
			 *
			 * 第 52 版（续啃 ui 层评测台账视图）：全局 83.66% / 79.87% / 84.77%
			 *   → lines/statements 上调为 83（实测 83.66 ≥ 83.5，余量 0.16）；functions 实测 79.87 → 到 80
			 *     需 ≥80.5 还差 0.63、branches 实测 84.77 → 到 85 差 0.73，两项均不足 0.5pt，维持 79 / 84。
			 *     ui 层整体 87.6%（函数 84.1% / 分支 84.4%）；journal-view.ts 34.7%→100%（118/118，+118 条）：
			 *     onOpen 三并发 IO、加载指示、IO 失败错误块、无评测引导（含/不含『装过』提示）、有评测逐行
			 *     组装双语名 + 委托 renderJournalTable 并接上点击跳回回调、onClose 清空。
			 *
			 * 第 53 版（续啃 ui 层版本选择弹窗）：全局 83.95% / 80.53% / 84.72%
			 *   → functions 上调为 80（实测 80.53 ≥ 80.5，余量 0.03，已逼近上限）；lines 实测 83.95 → 到 84
			 *     需 ≥84.5 差 0.55、branches 实测 84.72 → 到 85 差 0.78，两项均不足 0.5pt，维持 83 / 84。
			 *     ui 层整体 88.4%（函数 85.6% / 分支 84.3%）；version-picker-modal.ts 32.8%→99.5%（188/189，+127 条）：
			 *     onOpen 渲染、load 加载中/空态/失败告警、renderList 逐行（保持最新/版本行/当前标记/预发布）、
			 *     点版本行 onPick(tag)、点『保持最新』onPick(null)、onPick 拒绝弹 Notice、busy 守卫、openVersionPicker。
			 *
			 * 第 54 版（续啃 ui 层对比页 + 依赖检查弹窗）：全局 84.57% / 80.74% / 85.0%
			 *   → lines/statements 上调为 84（实测 84.57 ≥ 84.5，余量 0.07）；functions 实测 80.74 距 81
			 *     还差 0.76、branches 实测 85.0 → 到 85 需 ≥85.5 差 0.5，两项均不足 0.5pt，维持 80 / 84。
			 *     ui 层整体 90.1%（函数 86.1% / 分支 85.0%）；compare-view.ts 70.2%→93.2%（+594 条）：
			 *     导航/卡片渲染、安装态三分支、GitHub 链接、tag/desc/分类/更新行、导出菜单展开+Markdown 导出
			 *     （clipboard 成功/失败两分支）、洞察信号（标签交集/陈旧告警）、无 key 时 AI 区禁用+徽标、
			 *     有 key 触发 AI 对比（网络/缓存/失败重试/取消）、命令级信号（有 repo 抽取/无 repo 跳过）、dispose；
			 *     dep-check-modal.ts 65.1%→100%（86/86，+86 条）：open 仅渲染 action 项+关闭、跳过 ok/unknown、
			 *     点修复回调并禁用、点关闭真正清空、全就绪仅关闭按钮。
			 *
			 * 第 55 版（续啃 ui 层：分组管理弹窗 / CSS 片段行 / CSS 片段列表）：全局 84.92% / 81.23% / 85.21%
			 *   → 三项均逼近上限但余量不足 0.5pt：lines 实测 84.92 < 85.5、functions 81.23 < 81.5、
			 *     branches 85.21 < 85.5，故阈值维持 84 / 80 / 84（本轮不拧紧）。ui 层整体 91.0%（函数 87.3% / 分支 85.6%）。
			 *     group-management-modal.ts 79.3%→98.4%（242/246，+193 条）：标题 css/plugin 分支、空态、计数提示、
			 *     添加分组（空/已存在/成功三分支）、配色变更与重置、用量计数、内联重命名（空/同名/新名/冲突/Enter/Esc/blur）、
			 *     删除（成功/返回 null 早退）、onClose 清空；css-snippet-row.ts 75.4%→96.6%（173/179，+118 条）：
			 *     徽标（有/无自定义色 + 配色变量）、备注编辑器、开关（成功/失败回滚/异常/pending 守卫）、分组菜单（跳过 ALL、
			 *     选中写入 meta + 重画 + 筛选）、打开、重命名回调；view-css-snippets.ts 77.4%→98.0%（299/305，+225 条）：
			 *     非 css 页签早退、工具栏与行渲染、空态与过滤空态、搜索、状态/分组筛选（菜单选择）、勾选→批量条、
			 *     批量启用/停用/删除（含失败与异常分支）、新建（有效/空输入）、重命名、行内删除确认、管理分组按钮。
			 *     本轮顺带修正 obsidian mock 的 TextComponent：输入即同步内部 value，贴合真实 Obsidian，
			 *     避免测试手搓输入值失真（影响 group-management-modal 重命名路径）。
			 *
			 * 第 56 版（续啃 ui 层：facet-chips / dep-section）：全局 84.96% / 81.23% / 85.38%
			 *   → 依旧余量不足 0.5pt：lines 实测 84.96 < 85.5、functions 81.23 < 81.5、branches 85.38 < 85.5，
			 *     阈值维持 84 / 80 / 84（本轮不拧紧）。ui 层整体 91.2%（函数 87.3% / 分支 86.0%）。
			 *     facet-chips.ts 84.7%→100%（59/59，+8 例）：class 分支（active/inactive/all）、toggle 回调与状态、
			 *     计数渲染、clear 按钮显隐、空列表渲染；dep-section.ts 89.9%→100%（109/109，+14 例）：依赖行（状态 class/
			 *     图标/名称/种类/回退 id）、canOpen 可点+点击、minVersion、confidence「可能」标记、状态→动作按钮
			 *     （missing/disabled/outdated/ok/unknown）、被依赖区（折叠/摘要/可点 chip）。本轮补齐为局部 DOM helper
			 *     （与 view-toolbar.test.ts 一致，各测试文件各自局部补齐），未触碰全局 obsidian mock 原型增强以避免
			 *     与既有局部实现冲突（settings-tab 等依赖自身 helper）。
			 *
			 * 第 57 版（续啃 ui 层：view-beta 直链列表）：全局 85.03% / 81.29% / 85.43%
			 *   → 三项余量仍不足 0.5pt：lines 实测 85.03 < 85.5、functions 81.29 < 81.5、branches 85.43 < 85.5，
			 *     阈值维持 84 / 80 / 84（本轮不拧紧）。ui 层整体 91.3%（函数 87.4% / 分支 86.1%）。
			 *     view-beta.ts 85.9%→98.2%（216/220，+19 例）：空态（pt-empty 标题/提示 + 无卡片）、计数/安装入口/说明、
			 *     有条目才渲染「全部更新」、betaListEl 缺失安全返回、安装菜单（插件/主题项 → openDirectInstall）、
			 *     菜单回调（recordBetaInstall + 重绘）、全部更新（禁用守卫 + updateAllBetaPlugins + 最终重绘）、
			 *     卡片字段（名称/类型标签/版本/冻结 chip/来源 chip 与 title/描述/三操作按钮）、主题与缺省 kind、
			 *     冻结态 is-on、未知项回退名且不点详情、已知项点击开详情、更新按钮（成功重绘 / 失败仍重绘 / pt-spin 守卫）、
			 *     冻结与取消跟踪按钮。
			 *
			 * 第 58 版（续啃 ui 层：active-filters 筛选维度单一事实来源）：全局 85.12% / 81.56% / 85.51%
			 *   → 本轮可拧紧：functions 实测 81.56 ≥ 81.5（80→81）、branches 实测 85.51 ≥ 85.5（84→85）；
			 *     lines 实测 85.12 < 85.5 仍维持 84。ui 层整体 91.6%（函数 88.0% / 分支 86.3%）。
			 *     active-filters.ts 84.8%→100%（276/276，+17 例）：11 类维度各自自检与 clear 副作用（source/install/
			 *     recommended/favorite/author/selectedCategories（多项）/chineseEco/series bamboo·yulin/newWithinDays
			 *     命中 NEW_LABELS 与兜底/updatedWithinDays 命中 UPD_LABEL 与兜底/tried·abandoned·verdict 兜底纳入）、
			 *     全维度叠加计数、clearOneFilter（clear + updateFacetVisibility + scheduleRender(true)）、
			 *     clearAllFilters（清空 + 统一收尾一次）、activeFilterSignature（\u0001 连接、顺序稳定、空态空串）。
			 *
			 * 第 59 版（续啃 ui 层：view-ai-search 语义搜索编排）：全局 85.19% / 81.61% / 85.54%
			 *   → 维持第 58 版拧紧后的阈值 84 / 81 / 85（lines 实测 85.19 ≥ 84、functions 81.61 ≥ 81、
			 *     branches 85.54 ≥ 85，均过线；但上调 1 仍需 新阈值+0.5：functions 81.61<82.5、branches 85.54<86.5，故不拧紧）。
			 *     ui 层整体 91.8%（函数 88.1% / 分支 86.4%）。view-ai-search.ts 85.8%→96.6%（259/268，+15 例）：
			 *     早退守卫（pending/空查询/AI 未开启/鉴权不可用/无数据且加载失败）、AI 成功（写回 aiSearchResult/缓存 +
			 *     badge done + saveVectorIndex + 重绘）、rankFallback 降级提示、keyword 模式不落盘、本地模式成功（badge「本地」）、
			 *     本地无索引提示、embedding=local 且缺索引先 buildLocalIndex、异常捕获（boom / NO_API_KEY）→ badge ready +
			 *     aiSearchResult 置空、finally 清理 loading 态、本地模型进度条（挂载 <progress> + 轮询更新百分比）。
			 *
			 * 第 60 版（续啃 ui 层：view-updates 更新页签列表渲染器）：全局 85.3% / 81.58% / 85.61%
			 *   → 维持第 58 版拧紧后的阈值 84 / 81 / 85（lines 实测 85.3 < 85.5、functions 81.58 ≥ 81.5 但上调 1 需 ≥82.5、
			 *     branches 85.61 ≥ 85.5 但上调 1 需 ≥86.5，均不收紧）。ui 层整体 92.1%（函数 88.0% / 分支 86.6%）。
			 *     view-updates.ts 86.3%→99.2%（361/364，+19 例）：updatesListEl 缺失安全返回、pending 空态（标题/提示）
			 *     + 固定组渲染、行列表（勾选/名称/版本差/固定/更新 按钮）、勾选变化回写 updateSelection + 计数同步、固定按钮
			 *     → openVersionPicker、更新按钮（成功 pt-spin 复位 + 重绘 / 失败仍撤旋转态 / pt-spin 守卫连点一次）、全选/取消、
			 *     更新所选（有选中→批量）/更新全部（有待更→批量、无待更→仅提示）、检查更新（refreshOutdated + 提示 + 复位）、
			 *     视图切换 onPick 改 updatesViewMode + 重绘、installed 空态、installed 四组互斥（可更新/固定/停用/最新）、
			 *     固定行取消固定（pinPluginVersion(id,null) + 重绘）、状态行（名称+本地版本+标签）。
			 *
			 * 第 61 版（续啃 ui 层：view-cards 卡片列表渲染/交互）：全局 85.42% / 81.79% / 85.69%
			 *   → 维持第 58 版拧紧后的阈值 84 / 81 / 85（lines 实测 85.42 < 85.5、functions 81.79 ≥ 81.5 但上调 1 需 ≥82.5、
			 *     branches 85.69 ≥ 85.5 但上调 1 需 ≥86.5，均不收紧）。ui 层整体 92.4%（函数 88.5% / 分支 86.8%）。
			 *     view-cards.ts 87.0%→94.9%（577/608，+40 例，mock @ui/dom/dom + similar + detail-drawer + confirm-modal
			 *     + plugin-installer + plugin-insight 共 6 依赖）：toggleFavorite（收藏/取消/筛选分组归属/缓存失效）、flashAction、
			 *     computeSimilarFor（无 tagService/空列表/懒建倒排）、handleInstall（已装/安装中守卫 + 成功清理重绘）、
			 *     handleToggleEnabled（安装中守卫 + all/installed-not-enabled 仅刷新 + enabled 重建）、handleUninstall（安装中/
			 *     取消/确认 + 重绘）、openDetailDrawer（复用抽屉/新建/退对比模式）、onCardClick 全操作分发（copy/compare 增删/
			 *     详情/评测/洞察/toggle-enabled/uninstall/market/作者钻取/favorite/整卡点击/操作行空白带开关不跳详情）、
			 *     onCardKeydown（Enter 开详情/方向键网格移动/输入框不拦截）、focusCardByIdx（无 layer 安全/滚入视口+聚焦）、
			 *     openInsightModal（无 AI 降级 + 抓 manifest 生成）。局部 rAF 同步执行以确定性覆盖 fillSimilar/focus。
			 *
			 * 第 62 版（续啃 ui 层：view-toolbar 工具栏交互收口）：全局 85.53% / 81.84% / 85.77%
			 *   → 维持第 58 版拧紧后的阈值 84 / 81 / 85（lines 85.53 < 86.0、functions 81.84 < 82.0、branches 85.77 < 86.0，
			 *     三项均够不着「+0.5 才许拧紧」的下限，故本轮不收紧；view-toolbar 单文件仍实打实抬升）。
			 *     view-toolbar.ts 86.1%→90.4%（1070/1184，+14 例，仅 mock refreshOutdated + createUpdateProgressLayer 两依赖）：
			 *     刷新按钮（track+refreshData）、检查更新（pt-spin 守卫 + refreshOutdated + 完成后清旋转 + 刷新徽标 + Notice）、
			 *     更新全部（有待更→进度层+updateAll；无待更→仅提示早退）、设置齿轮（setting.open + openTabById(manifest.id)）、
			 *     溢出菜单四项（refresh/checkUpdate/updateAll/aiTranslate 经 Menu.lastShown 触发）、排序按钮（pt-sort-wrap--open
			 *     切换）、普通排序项（sortBy/设置/关闭/重绘）、收藏优先项（sortFavoritesFirst 切换 + track）、生态 toggle
			 *     （chineseEcoFilter eco/all 互斥 + aria-pressed + scheduleRender(true)）、系列 toggle（竹林/羽鳞 互斥切换）、
			 *     上线 toggle（newWithinDays 切换 + 持久化）、更新 toggle（updatedWithinDays 切换 + 持久化）、高级筛选折叠
			 *     （pt-open + renderFeaturedSection + aria-expanded；动画 200ms 后 measureLayout/updateWindow 经 rAF 同步桩收敛）。
			 *
			 * 第 63 版（转战 app/ 层拉基线：beta-updater 直链 Beta 批量更新）：全局 85.62% / 81.9% / 85.81%
			 *   → 维持第 58 版拧紧后的阈值 84 / 81 / 85（lines 85.62 < 86.0、functions 81.9 < 82.0、branches 85.81 < 86.0，
			 *     三项均够不着「+0.5 才许拧紧」下限，故本轮不收紧）。
			 *     app/beta-updater.ts 70.4%→100%（125/125，函数 100%、分支 91%，+8 例；仅 mock @app/direct-install 两依赖，
			 *     Platform.isMobile 走 mock obsidian 的 Platform）：buildBetaEntry（默认 kind/release + name 回退 id）、updateBetaEntry
			 *     （kind=plugin→updateBetaPlugin / kind=theme→updateBetaTheme + release 布尔回写）、updateAllBetaPlugins（移动端非静默
			 *     弹提示空返回 / 移动端静默空返回 / 冻结跳过 / 更新成功 updated++ 带 version+release / 已最新计 skipped / 单条失败隔离
			 *     failed++ 记 error 不妨碍其余 / 非静默走逐条+汇总提示分支 / 静默跳过全部 !silent 分支 / 空列表不弹汇总）。
			 *
			 * 第 64 版（转战 app/ 层拉基线：obsidian-adapters 依赖倒置装配点）：全局 85.69% / 82.11% / 85.96%
			 *   → 维持第 58 版拧紧后的阈值 84 / 81 / 85（lines 85.69 < 86.0、functions 82.11 < 82.5、branches 85.96 < 86.5，
			 *     三项均差一点够不着「+0.5 才许拧紧」下限，故本轮不收紧）。
			 *     app/obsidian-adapters.ts 84.3%→100%（198/198，函数 100%、分支 98%，+28 例；vi.mock("obsidian") 工厂仅把
			 *     会抛错的 requestUrl 换成 vi.fn、并补 obsidian mock 缺失的 TFolder 等价类，其余沿用 mock）：ObsidianHttpClient.request
			 *     （补 throw:false + 整形响应 / 默认 GET）、ObsidianStoragePort（exists/read/write 委托）、ObsidianNoteStorage
			 *     全部分支（adapter/vault 双后端在 exists/createFolder/writeNote/deleteNote/listMarkdown/readNote/statMtime 的择路
			 *     与容错：逐级建目录、list 抛错视为空、vault 路径非文件回退 adapter.read、stat 抛错归 0）、obsidianPlatformCapability
			 *     （缺字段全 false / 补 isDesktopApp+isMacOS 透传 / 布尔化防御）。
			 *
			 * 第 65 版（转战 app/ 层拉基线：plugin-updater 一键更新已安装插件）：全局 85.74% / 82.11% / 86.26%
			 *   → 维持第 58 版拧紧后的阈值 84 / 81 / 85（lines 85.74 < 86.0、functions 82.11 < 82.5、branches 86.26 < 86.5，
			 *     三项均差一点够不着「+0.5 才许拧紧」下限，故本轮不收紧）。分支 53%→88% 是最大增量。
			 *     app/plugin-updater.ts 91.6%→98.9%（260/263，函数 100%、分支 88%，+30 例；mock requestUrl + Platform +
			 *     requireApiVersion + asAppInternals + buildManifestUrl + resolveUrl + githubReleaseAssetUrls 共 7 依赖）：
			 *     tagVariants（v 前缀变体 / 大写 V / 空白空数组）、updatePluginCore 守卫（移动端 / 无仓库）、跟随最新成功路径
			 *     （manifest→main(raw)→css(可选404)→写盘重载 + manifest 非 2xx / buildManifestUrl 空 / id 不符 / minApp 不满足 /
			 *     main 空）、writeAndReload 全分支（目录 !exists→mkdir、css 存在且新版无→删旧、css 不存在→不删、plugins 为 null、
			 *     已启用→disable、缺 enablePluginAndSave→回退 enablePlugin、重载后未启用→抛 enableFailed）、固定版本 installPinnedVersion
			 *     （version 非空走严格 tag、仓库非法、version 空白、manifest 全 404、main 全 404）、fetchWithReleaseFallback
			 *     （raw 200 直返 / raw404→release200 回退 / 可选全 404→null / 非可选全 404→抛 / 服务端 500 直抛 / 仓库非法→抛）。
			 *
			 * 第 66 版（转战 domain/ 层拉基线：plugin-insight 插件功能洞察）：全局 86.14% / 82.59% / 86.38%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，本轮**首次真正拧紧**：
			 *     lines/statements 84→**85**（86.14 ≥ 85.5）、functions 81→**82**（82.59 ≥ 82.5）、branches 维持 85（86.38 < 86.5 不够）。
			 *   （此前第 62-65 版实测虽多次逼近，但 lines/functions 总差 0.4~0.5 个百分点未能越线，本轮借 plugin-insight 100% 补足跨过。）
			 *     domain/compare/plugin-insight.ts 35.1%→100%（262/262，函数 100%、分支 98%，+41 例；仅 mock @data/net/net 的 netRequest
			 *     + @domain/catalog/mirror 的 resolveUrl/buildReadmeUrl 两依赖）：buildManifestUrl / buildMainJsUrl（repo 空、前后斜杠清理、
			 *     非两段、main 缺省/空白回退 main.js）、fetchManifest（repo 空直返 / 200 字段整形 / 非 2xx / json 非对象 / 字段类型不符 /
			 *     抛错兜底）、fetchReadmeText（repo 空 / 200 截断 5000 / 非 2xx / 抛错）、fetchMainSignals（repo 空 / 200 抽取 / 非 2xx / 抛错）、
			 *     extractMainSignals（id/name 抽取、缺字段跳过、hasSettings 正则、命令数封顶 40）、buildInsightPrompt（基础字段 / manifest
			 *     描述差异双呈现 / author-version-tags-deps / downloads-updated / mainSignals 命令+设置页 / readme / description 缺失不呈现）、
			 *     generateInsight（去首尾空白 / 空响应抛错）、gatherInsightSources（三路聚合 + readmeLimit 双向截断 / repo 空降级）。
			 *
			 * 第 67 版（续啃 domain/ 层：smart-signal 离线轻量推荐信号）：全局 86.25% / 82.64% / 86.44%
			 *   → 维持第 66 版拧紧后的阈值 85 / 82 / 85（lines 86.25 < 86.5、functions 82.64 < 83.5、branches 86.44 < 86.5，
			 *     三项均差一点够不着「+0.5 才许拧紧」下限，故本轮不收紧）。分支 73%→92% 是增量。
			 *     domain/filter/smart-signal.ts 64.0%→100%（136/136，函数 100%、分支 92%，+13 例；纯函数无 mock，仅 spy Date.now
			 *     固定时间窗）：computeSmartSignals（空列表直返 / 单插件 top1 / 200 插件分位边界 top1(<2)·top5(<10)·hot10(<20)·无(≥20) /
			 *     10 天内更新→top1+recentActive+recentUpdate / 50 天内→+recentActive / 100 天前→仅分位 / 无 updated→仅分位、
			 *     velocityRising 全分支：无 prevStats(null) / 空 Map / 增速明显高于均值(sigmoid>0.5) / 增速相同(stddev=0 置 0) /
			 *     curr≤prev(不计 velocity) / 信号已满 3 被 length<3 守卫挡下）+ computeVelocityScores（prev 缺失或 curr≤prev 跳过 /
			 *     velocities 空早返 / 均值-方差-Z-score-sigmoid 归一化）。
			 *
			 * 第 68 版（续啃 domain/ 层：sort + plugin-meta 两小块）：全局 86.31% / 82.75% / 86.51%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，branches 86.51 ≥ 86.5 → **85→86 拧紧**（lines 86.31 < 86.5、functions 82.75 < 83.5 仍不收紧）。
			 *   （branches 以 0.01 的微弱优势越线，是本轮 sort 把 73%→87% 分支补上叠加 plugin-meta 100% 的合力；按既定公式即应拧紧。）
			 *     domain/filter/sort.ts 89.6%→100%（134/134，函数 50%→100%、分支 87%，+14 例；纯函数无 mock）：7 个维度（downloads/updated/
			 *     published/name/popular/trending/recommended）+ relevance/default 保持原序，空列表直返、入参不可变、相等 key 稳定排序、
			 *     name 三层显示名来源（displayNameOf 回调 > displayName 字段 > name 回退）、popular 未安装优先→下载量→更新时间 决策链、
			 *     trending/recommended 缺评分表→全 0 维持原序。
			 *     domain/manage/plugin-meta.ts 76.9%→100%（52/52，函数/分支全 100%，纯函数无 mock）：getMeta（未登记→其他分组+空备注 /
			 *     group 假值回退 OTHER / remark 非字符串回退空串）、setMeta（仅 patch group 保留 remark、仅 patch remark 保留 group、二者同补、
			 *     不可变返回新对象）、pruneOrphanedMeta（validIds 为 Set 剔除孤儿 / 为可迭代数组同样生效 / 无孤儿返回原引用跳过写盘）。
			 *
			 * 第 69 版（续啃 domain/ 层：trending 趋势引擎）：全局 86.42% / 82.96% / 86.55%
			 *   → 维持第 68 版拧紧后的阈值 85 / 82 / 86（lines 86.42 < 86.5、functions 82.96 < 83.5、branches 86.55 < 87.5，
			 *     三项均够不着下一档「+0.5 才许拧紧」下限，故本轮不收紧）。分支 100% 为单文件满贯。
			 *     domain/recommend/trending.ts 80.4%→100%（240/240，函数/分支全 100%，+29 例；初版 23 例整文件重写时覆盖了既有
			 *     12 例旧测试，随后按断言逐条补回 6 条语义契约防线：serialize/load 多插件往返一致、load 混合非法条目合法项保留、
			 *     lastSampleStats 空历史空 Map、H1 自比恒 0 多插件基线、时距过短暴涨下载量不产生天文增速、999/天精确 log 压缩 0.75）。
			 *     仅 spy Date.now 固定采样时间轴，无模块 mock：构造函数（默认配置 / 部分覆盖）、updateWithStats（空 stats 不新增 / 新插件首次采样 / 间隔内仅跟进更大下载量
			 *     不新增点 / 超出间隔追加 / 自定义 intervalMs / maxSnapshots 裁剪 shift 最旧）、trendingScore（无历史或不足 2 点默认分 /
			 *     时距低于 MIN_SPAN 默认分 / 窗口外旧点剔除后不足 2 点默认分 / 正常增速 log10 压缩 / 下载量下降增速封底 0 / 极高增速封顶 1 /
			 *     defaultScore 可配置）、batchTrendingScores（空列表 / 单插件 stddev=0 统一 0.5 / 增速差异 sigmoid 归一化低增速更低）、
			 *     serialize/load 往返 + 非法数据（非对象/null/非数组/字段非法）静默跳过 + load 按 maxSnapshots 截断、
			 *     lastSampleStats 返回最新下载量、prune（删过期点 / 全过期删整条 / 无过期不改）、reset 清空、isEmpty/getSnapshots。
			 *
			 * 第 70 版（最后一块硬骨头：settings-integration-controller 设置页增强控制器）：全局 86.97% / 83.8% / 86.7%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，本轮**两项同时拧紧**：
			 *     lines/statements 85→**86**（86.97 ≥ 86.5）、functions 82→**83**（83.8 ≥ 83.5）、branches 维持 86（86.7 < 87.5 不够）。
			 *   （该 377 行文件此前函数 0%，一次性补满是 functions 跨过 83.5 的主因。）
			 *     app/settings-integration/settings-integration-controller.ts 38.7%→100%（377/377，函数 0%→100%、分支 98%，
			 *     +50 例；vi.hoisted 造两个 enhancer 类替身 + logger.warn + FakeObserver(可控 trigger) + rAF 队列(同步 flush)，
			 *     asAppInternals 为透明类型断言不 mock、pruneOrphanedMeta 保真）：start（setting 缺失/无容器静默放弃 / 幂等 / patch 8 方法
			 *     + observe + 排帧）、stop（disconnect / 取消帧 / 精确还原 / 两个 cleanup / 状态复位 / 可再 start）、requestRefresh、
			 *     reconcile（无 setting / 容器断开 / 总开关关闭 / 社区插件页 / 外观页 / 其它页 / 无 activeTab 回退 / Tab 切换重置
			 *     scannedRootEl / finally 解锁 isReconciling）、scheduleOrphanedCleanup（插件+CSS 双路签名去重、含孤儿写盘、无孤儿不写、
			 *     installedIds/listSnippets 抛错 warn + 签名重置）、ensureSnippetsScanned（同 root 防自激 / 成功 finally 排帧 /
			 *     失败 warn+置空重试 / 旧 generation 丢弃）、scheduleReconcile + cancelScheduledReconcile + getView（独立窗口 rAF 择路）、
			 *     patchLifecycleMethods（非函数跳过 / wrapper 正确 this + 同步排帧 / 返回 Promise 再排帧 / own property 与原型链精确恢复 /
			 *     外部改写则跳过还原）、MutationObserver（view 构造器优先 + 全局回退 / container 空早返 / 需重建与过滤两类 mutation）、
			 *     shouldReconcileMutation 全分支（isReconciling 锁 / owned 内忽略 / 文本节点取 parentElement / 仅 filtered-out class
			 *     变化不重建 / 其它 class 变化重建 / removed owned 立即重建 / added 全 owned 忽略 / 混入非 owned 重建 / 其它类型重建）、
			 *     onlyFilterVisibilityChanged（oldValue null 空串比较）。
			 *
			 * 第 71 版（收尾小洼地：shared/platform + insight-cache）：全局 87.08% / 84.33% / 86.78%
			 *   → 维持第 70 版拧紧后的阈值 86 / 83 / 86（lines 87.08 < 87.5、functions 84.33 < 84.5、branches 86.78 < 87.5，
			 *     三项均够不着下一档「+0.5 才许拧紧」下限，故本轮不收紧）。两文件语句/函数/分支三项全 100%。
			 *     shared/platform.ts 67.1%→100%（76/76，函数 20%→100%、分支 50%→100%，+16 例；vi.mock("obsidian") 用 getter
			 *     动态返回 Platform 以模拟 undefined/isMobile/读取抛错，vi.stubGlobal 控制 window/matchMedia/rIC，fake timers 驱动
			 *     降级 setTimeout）：isMobileEnvironment（Platform 未定义 / isMobile true / 非 true / getter 抛错 catch）、
			 *     isTouchEnvironment（window 未定义 / matchMedia 缺失或非函数 / matches true 且查询 coarse pointer 串 / matches 非 true /
			 *     抛错 catch）、requestIdle（原生 rIC 透传 timeout 并回调 / 默认 100 / 缺失降级 setTimeout 封顶 50ms / 小 timeout 不封顶）、
			 *     cancelIdle（原生 cIC / 降级 clearTimeout）。
			 *     data/storage/insight-cache.ts 78.4%→100%（102/102，函数 33%→100%、分支 71%→100%，+10 例；纯类无 mock）：
			 *     isValidEntry 经 load 间接覆盖（合法 / 旧 schema / 缺 text / text 非 string / 非对象 / null / 最早纯 string 格式全丢弃）、
			 *     load 缺字段不清空 / 空对象字段清空该侧、get/setInsight、compareKey 排序且不修改入参、{A,B} 与 {B,A} 命中同一缓存、
			 *     toJSON 两套导出 + load 往返一致。
			 *
			 * 第 72 版（翻译管线小件：note-port + tencent-signer）：全局 87.45% / 84.7% / 86.82%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，functions 84.7 ≥ 84.5 → **83→84 拧紧**；
			 *     lines 87.45 < 87.5（仅差 0.05）、branches 86.82 < 87.5，两项维持。
			 *     translation/memory/note-port.ts 83.3%→100%（66/66，函数 67%→100%、分支 100%，+7 例；纯类无 mock）：
			 *     normalizePath（反斜杠/连续斜杠/首尾斜杠/空串 + 归一化被其余方法共用）、exists（笔记/文件夹）、
			 *     createFolder 归一化+幂等、writeNote 覆盖、deleteNote 不存在静默、listMarkdown（目录前缀+子目录 .md、
			 *     排除非 md 与同名前缀目录外文件、空目录）、readNote 缺失返回空串、statMtime 存在 1 / 缺失 0。
			 *     translation/api/tencent-signer.ts 21.6%→100%（190/190，函数/分支全 100%，+10 例；vi.mock netRequest +
			 *     vi.stubGlobal 注入 Node 真实 webcrypto/TextEncoder，让 TC3 签名链路真实执行 + spy Date.now 固定时间戳）：
			 *     成功路径（TargetText 返回、url/method/X-TC-* 头/body payload/Authorization 的 Credential·SignedHeaders·
			 *     64 位 hex Signature、不同密钥签名不同、自定义 region 透传）、故障必须与成功区分（HTTP<200 / >=300 的
			 *     401·429·5xx / status 非数值跳过检查 / json null 或非对象 / Response.Error 抛 Code: Message /
			 *     TargetText 缺失·空串·非字符串抛空译文，绝不兜回原文）。
			 *   补记：整文件改写 note-port.test.ts 时发现它原先承载的并非 MemoryNoteStorage 自身测试，而是 translation-memory
			 *   的 7 个「NoteStoragePort 端口注入」集成用例（首次写入先建文件夹 / 已存在不重建成 / createFolder 抛错被吞 /
			 *   同 id 覆写 / removeTMNote 静默 / 非法字符转义 / normalizeTMPath 归一）。已原样迁到独立文件
			 *   tm-note-port.integration.test.ts 恢复，translation-memory.ts 95.8%→98.3%（函数 83%→100%）。
			 *   教训（第二次踩）：整文件重写前必须先读旧内容，覆盖率 100% 不等于断言等价。
			 *
			 * 第 73 版（翻译在线源：self-hosted 自托管翻译）：全局 87.73% / 85.24% / 86.93%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，lines/statements 87.73 ≥ 87.5 → **86→87 拧紧**；
			 *     functions 85.24 < 85.5、branches 86.93 < 87.5，两项维持。
			 *     translation/api/self-hosted.ts 41.1%→100%（202/202，函数 10%→100%、分支 33%→98%，+24 例；
			 *     仅 vi.mock netRequest + logger.warn，guard.ts 的 withTimeout/CircuitBreaker 保真、spy Date.now 控制冷却）：
			 *     isUnchanged 大小写/空白归一、DeepLXClient 与 LibreTranslateClient 两客户端全分支（constructor 去尾斜杠 +
			 *     key/provider/isAvailable、callApi 请求构造 + 500 字截断、HTTP 非 2xx 抛错且正文截断 120 / text 缺失回退空串、
			 *     非预期结构多种形态、正常返回、translate 双译出 / 双未变化返回 null / 单侧未变化保留原文、
			 *     失败 warn + 返回 null、连续两次失败熔断开路后不再发请求、HTTP 成功复位计数、冷却结束半开可试探）、
			 *     buildSelfHostedTranslators（undefined/空数组、过滤空与纯空白 baseUrl、质量序 DeepLX>LibreTranslate、
			 *     trim + 去尾斜杠、未知 type 回退 LibreTranslate、新实例全部可用）。
			 *   本轮事前已先确认是全新文件（无既有测试可被覆盖），规避了前两轮的误删。
			 *
			 * 第 74 版（设置页组件通道：settings-translator 原型补丁）：全局 88.24% / 86.09% / 87.14%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，functions 86.09 ≥ 85.5 → **84→85 拧紧**；
			 *     lines 88.24 < 88.5、branches 87.14 < 87.5，两项维持。
			 *     translation/settings/settings-translator.ts 48.8%→100%（426/426，函数 35%→100%、分支 79%→97%，
			 *     +40 例；**扩展既有测试文件**，原 7 例完整保留 —— 第三次踩坑前先查了同名文件，改用 append 而非重写）：
			 *     mock DOM 扫描通道（捕获 4 个回调）+ logger，给 obsidian mock 补 DropdownComponent.addOptions，
			 *     再按真实 obsidian 类型给组件构造传 containerEl。覆盖：缓存（loadCache/exportCache/clearCache/
			 *     CACHE_CAP=3000 淘汰最旧 / translateText 成功后 evict）、生命周期（originals 未初始化 restore 直返 /
			 *     isPatched 状态机 / enable 幂等 / disable 恢复 6 个原型方法 / activeDisable 热重载卸载上一任 /
			 *     disable 清 pending）、currentPluginId·domRoot·shouldSkip·domEligible 全分支（含 getter 抛错 catch）与
			 *     DOM 通道四回调接线、translateText（free 双通道兜底 / baidu 单通道 / 回显不算成功 / 引擎失败 warn /
			 *     inflight 去重 / finally 清理）、translateBatchTexts（全命中早返 / 整块请求写缓存 / 未译出交下一通道 /
			 *     baidu 单轮 / 抛错 continue / results 长于入参跳过）、translateDescEl（空节点 / 全跳过 / uniq 去重 /
			 *     失败保留原文 / 深层嵌套递归）、组件通道 6 个 patch（setName/setDesc/setButtonText/addOption/
			 *     addOptions/setPlaceholder 的回写、shouldSkip 跳过、文案已被改写则不覆盖、option 找不到静默）。
			 *   注：测试暴露一个边界 —— 若 translator 同步 throw（而非返回 rejected Promise），pending.delete 会早于
			 *     pending.set 导致残留；真实 async 实现不会同步抛，已按真实形态写测试，未改源码。
			 *
			 * 第 75 版（续 settings 通道之后：transmart 腾讯翻译免费层）：全局 88.31% / 86.19% / 87.34%
			 *   → 维持第 74 版拧紧后的阈值 87 / 85 / 86（lines 88.31 < 88.5、functions 86.19 < 86.5、branches 87.34 < 87.5，
			 *     三项均差一点够不着「+0.5 才许拧紧」下限，故本轮不收紧）。分支 93% 单项满。
			 *     translation/api/transmart.ts 89.6%→100%（279/279，函数 83%→100%、分支 93%，+29 例；**扩展既有测试文件**，
			 *     原 7 例完整保留 —— 吸取 trending/note-port 误删教训，先查同名文件再 append 而非重写）：沿用原 setHttpClient 注入
			 *     桩、补 generateClientKey（空 UA/普通 UA/超长截 100）、setEnabled/isAvailable/不可用短路（translate 不请求直接 null /
			 *     translateSegment 抛错 / translateSegments 不可用+空数组）、translate 中文源 zh 早返、detectLanguage 边界（空→en/
			 *     非 JSON catch→en/大写保留/中文源）、translateText（空串 unchanged/超 500 截断到 500/正常段 recordSuccess）、
			 *     translateSegment（正常译出/空白原样/中文源保留原文）、callApi 错误全分支（非 JSON/ret_code error/Unsupported-Language
			 *     透传/busy 限流重试 2 次后作 API 错误，用 fake timers 推进且 advance 前先挂 rejection handler 避免 unhandled）、
			 *     translateSegments 批量全分支（成功按行对齐/含空白/含换行/超 2000/整块回显/行数不符/空行/Unsupported 不计熔断/
			 *     其它错误 recordFailure）。
			 *
			 * 第 76 版（数据持久层：plugin-storage）：全局 88.64% / 86.83% / 87.18%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，lines 88.64 ≥ 88.5 → **87→88 拧紧**；
			 *     functions 86.83 ≥ 86.5 → **85→86 拧紧**；branches 87.18 < 87.5，维持。
			 *     data/storage/plugin-storage.ts 66%→98.6%（426/432，函数 57%→100%，分支 83%→76%，+26 例；
			 *     **扩展既有测试文件**，原 13 例完整保留 —— 仍沿用先查同名文件再 append 的纪律）：用 MemoryStoragePort
			 *     内存实现驱动，补齐此前全缺的保存/读取全分支：saveInstallHistory（成功往返/失败静默）、loadTranslatorCache
			 *     整函数（成功读全字段/缺失/旧版 vault 根回退/损坏非对象）、loadSeededTranslatorCache（成功/缺失/损坏/非对象，
			 *     且 seed 版本不含 firstSeenIds 键、调用方用 ?? {} 兜底）、save&loadFavorites（成功往返/缺失/损坏/
			 *     旧版 vault 根回退/favorites 非数组回退 legacyData 内嵌键/仅 legacyData）、save&loadCredentials
			 *     （成功且字段完整/缺失/旧版 vault 根回退/损坏非对象）+ CREDENTIAL_KEYS 含百度密钥（明文泄露修复回归）、
			 *     stats/列表/趋势读取边角（savedAt 非 number/parsed 非 object/坏 JSON/列表空数组回退 legacyData/
			 *     坏 JSON catch/savePluginListCache 成功回读/趋势 parsed 为数组非对象）。
			 *   注：分支 76% 低于语句 98.6%，源于新增代码里大量 `?? 默认值` 的 else 边（如 loadCredentials 11 个字段
			 *     `?? ""`、loadTranslatorCache 9 个 `?? {}`）在「完整对象」用例下未被触发；属安全兜底分支，未逐一造缺失键触发。
			 *
			 * 第 77 版（翻译 API 客户端集合：api.ts）：全局 88.8% / 87.15% / 87.54%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，branches 87.54 ≥ 87.5 → **86→87 拧紧**；
			 *     lines 88.8 < 89.5、functions 87.15 < 87.5，两项维持。
			 *     translation/api/api.ts 84.8%→97.5%（514/514，函数 79%→100%、分支 62%→86%，+33 例；
			 *     **扩展既有测试文件**，原 13 例完整保留）：补齐 callAITranslate 整函数（熔断器开路/null / 成功 JSON→source=ai /
			 *     name 空 / name+desc 双回显未翻译 / 仅 name 变+desc 回显 / llm.call 抛错 / 非 JSON）与 MyMemory·Google·Tencent·LLM
			 *     各客户端此前未覆盖的 restoreBlockedDate（跨天自动解除 + 当天恢复 blocked）/ isBlocked·getBlockedDate / isEnabled /
			 *     translateText（成功 + 空串）/ 配额分支（QUOTA_HINTS 触发 MyMemory blocked、含 429 字样的 Google 配额错误）/
			 *     callApi 错误分支（非 JSON / responseStatus≠200 / 非预期结构 / 空译文 / name+desc 双回显未变化）/
			 *     LLMClient 的 updateConfig / httpStatusHint 各状态码与默认 / 非 2xx 错误详情 / forceJson=false 不带 response_format /
			 *     TencentClient 未配置抛「未配置翻译 API」。
			 *   注（测试暴露的两个源码 bug 已修复，见后续 fix 提交）：① MyMemory 的 isAllCaps 判定 `translated.toUpperCase() === translated`
 *   ② LLMClient 非 2xx 时 `response.text` 回退分支为死代码（response.json 已解析、访问 errJson.error.message 不抛错，永不进 catch）；改为直接 fallback 到 response.text 并截断 120。
 *     两处均补了回归用例。
 *
 * 第 79 版（domain god-object：translator）：全局 89.34% / 88.81% / 87.7%
 *   → 经「新阈值 = floor(实测−0.5)」校验，functions 88.81 ≥ 88.5 → **87→88 拧紧**；
 *     lines 89.34 < 89.5、branches 87.7 < 88.5，两项维持。
 *     domain/catalog/translator.ts 80.1%→87.6%（函数 59%→94%、分支 72%→80%，+26 例；
 *     **扩展既有测试文件**，原 633 行 / 30 例完整保留 —— 仍沿用先查同名文件再 append 的纪律）：用解析 coverage-final.json
 *     精准定位 62 个函数中 40 个未覆盖，聚焦纯状态/配置/委托 getter-setter 补齐，覆盖 setApiConfig（trim）/setBaiduConfig（trim）/
 *     setUseMyMemory/setUseTransmart/setAIConfig（normalize 兜底）/setSelfHostedTranslators/getAllPluginTags/pluginsRev/
 *     getCategorySchemaVersion/aiDict getter+setter/recordCoverage（空 version 返回+新增+同版本更新+12 上限）/
 *     getCoverageTrend（空/单/双）/hasAnyTranslation（cache 非 original+TM+AI 资产+无）/getInsight/setInsight/clearCache/
 *     getCacheSize/clearAIDict/getAIDictSize/enqueueOnlineTM（online 落库 true/非 online false/已采纳 false）/TM 采纳管理
 *     （removeTMApproved/getTMApprovedCount/isTMApproved）/TM 脏标记（mark/peek/take/clear）/TM 移除标记（经私有 tracker 触发
 *     markRemoved 后 peek/take/clear）/getVectorIndex/setVectorIndex/hasAI/getLastSearchTiming/getLastMatchDiagnostics/
 *     compareKey/getCompareInsight/setCompareInsight/aiCompare（首调 aiSearcher.compare+缓存命中）/aiSearchLocal（委托 localSearch）/
 *     logTencentError（私有，直接调用断言 warn 日志）。
 *   注：剩余未覆盖多为翻译管线方法（translateTextSegment/translateTextSegments/translateBatch/translateBatchIncremental/
 *     solidifyAI 部分分支、aiSearch 复杂分支），需 mock 多个翻译客户端/embedding，成本高，留待后续；本轮已把该文件从「接近 80%」
 *     提到 87.6%（函数 94%），是本轮性价比最高的单文件提升。
 *
 * 第 80 版（app 安装层：direct-install）：全局 89.61% / 89.28% / 87.63%
 *   → 经「新阈值 = floor(实测−0.5)」校验，lines 89.61 ≥ 89.5 → **88→89 拧紧**；
 *     functions 89.28 < 89.5、branches 87.63 < 88.5，两项维持。
 *     app/direct-install.ts 64.3%→78.8%（779/779，函数 54%→80%、分支 86%→80%，+18 例；
 *     **扩展既有测试文件**，原 40 例完整保留）：用 vi.mock("obsidian") 把默认「未 mock 即抛错」的
 *     requestUrl 换成可控 vi.fn()，补齐安装/网络全链路——isFloatingGithubRef（raw+HEAD 判定）/
 *     FetchMissingError（file/status + instanceof）/fetchFromUrls（200 直接 / 404→200 换源 /
 *     全 404 且 optional→null 否则抛 FetchMissingError / 非 404-410 立即抛错）/fetchFileText（拼接 root+name /
 *     optional 缺失→null）/fetchLatestReleaseManifest（版本化→返回、非版本/异常/缺失→null）/
 *     resolveRemoteManifest（无 gh→源码树 release=false / gh+钉选 ref→release=false /
 *     gh+floating+Release 更高→release=true / release 模式→直接 fetchManifest）/
 *     installFromUrl（三件套写盘+重载启用、目录已存在走 remove 分支）/installThemeFromUrl（无 manifest→仓库名作目录名、版本留空）/
 *     updateBetaPlugin（版本相同→updated=false / 版本不同→重写盘 / 远程 id 不符→抛 idMismatch）/
 *     updateBetaTheme（无 manifest→重拉 theme.css）/rebuildUpdateSpec（还原 release 开关 + 钉选 tag）。
 *     DirectInstallModal（UI）未覆盖。
 *   注：本轮同时修复 translator.test.ts 遗留 tsc 错误——DictEntry 实际字段 {name,description?,source?}
 *     而非 {key,translation}，CompareItem 需 tags/commands/dependencies；此前提交 git commit 不校验 tsc 致类型错误入库，已修正。
 *
 * 第 81 版（data 平台安装层：plugin-installer）：全局 91% / 90.26% / 87.2%
 *   → 经「新阈值 = floor(实测−0.5)」校验，lines 91.0 ≥ 90.5 → **89→90 拧紧**；
 *     functions 90.26 ≥ 89.5 → **88→89 拧紧**；branches 87.2 < 87.5 → 维持 87。
 *     data/platform/plugin-installer.ts 19.7%（函数 0%）→80.3%（函数 96%、分支 66%，+30 例；
 *     **新建测试文件**，此前无同名测试）：用 vi.mock("@data/net/net") 把 netRequest 换成可控 vi.fn()
 *     （按 url 区分 manifest.json→json / main.js·styles.css→text），并 fake ViewContext 与 app.plugins
 *     （loadManifests / manifests / enablePluginAndSave / disablePluginAndSave / enabledPlugins.has·add·delete）
 *     + vault.adapter（mkdir·write·read·rmdir）、vi.mock 桩 mirrorConfig 与 reportMissingDeps，覆盖：
 *     isSafeInstallTarget（合法 id / 含 .. / 含 / / 点开头 / 非字符串 / manifest.id 不符 / main 穿越 / 空 main /
 *     无 manifest）/ installCommunityPlugin（无 repo→跳转 / 非法 id / 已安装 / plugins 缺失 / manifest 下载失败 /
 *     adapter 无 mkdir / 完整成功写盘 community-plugins.json+app.json / styles.css 200 一并写盘 /
 *     recognized+enabledPlugins 不可写→manualEnable / 未识别→needReload 回退 / main.js 失败）/ uninstallCommunityPlugin
 *     （成功 rmdir+同步清单+loadManifests / 无 rmdir / 非法 id / 未启用跳过 disable）/ togglePluginEnabled
 *     （plugins 缺失→enabledIds / 启用→禁用双写 / 禁用→启用）/ applyProfileByIds（enable 新+disable 旧 排除 selfId /
 *     plugins 缺失 0/0）/ applyEnabledProfile（委托+刷新）。未覆盖：nodeDownload（Node https 兜底，需 mock window.require）、
 *     downloadFullManifest 部分异常分支。全局由此首次突破 91%。
 *
 *

  *
 *     对中文译文恒为 true（中文 toUpperCase 不变），会把正常中文译文误判为「全大写回显 = 未变化」而保留原文；改为仅当译文含
			 *     拉丁字母且全大写、原文非全大写时才视为专有名词回显。② LLMClient 非 2xx 时 `response.text` 回退分支为死代码
			 *     （response.json 已解析、访问 errJson.error.message 不抛错，永不进 catch）；改为直接 fallback 到 response.text 并截断 120。
			 *     两处均补了回归用例。
			 *
			 * 第 78 版（语义 worker 主线程侧：worker-backend）：全局 89.13% / 87.59% / 87.62%
			 *   → 经「新阈值 = floor(实测−0.5)」校验，functions 87.59 ≥ 87.5 → **86→87 拧紧**；
			 *     lines 89.13 < 89.5、branches 87.62 < 88.5，两项维持。
			 *     semantic/workers/worker-backend.ts 60.1%→93.6%（392/419，函数 →96%、分支 83%，+16 例；
			 *     **扩展既有测试文件**，原 3 例完整保留 —— 仍沿用先查同名文件再 append 的纪律）：
			 *     该文件是**主线程侧**模块（源码注释「主线程侧：通过 Web Worker 运行本地 embedding」，
			 *     Worker 由它 new Worker() 实例化），本身在主线程执行、覆盖率可收集，区别于 embedding-worker.ts
			 *     （Worker 线程源码，Blob URL 实例化，vitest 不执行，属采集盲区已剔除）。用 FakeWorker 桩 +
			 *     URL.createObjectURL/revokeObjectURL 桩驱动，覆盖：模块装配函数（setWorkerFetchBridge /
			 *     isWorkerFetchBridgeInstalled / setModelProgressReporter / reportModelProgress / disposeAllShared）、
			 *     embed（空数组直接返回 / 正常 ready+result → 向量数组 / failed 抛「已禁用」/ init 失败 loader 抛错）、
			 *     warmup（failed 直接返回 / loader 抛错静默）、handleMessage（log→warn / progress 上报 / ready 置位 /
			 *     init-error 上报+实例移除 / result 命中缺失 id 静默 / fetch 桥接未注入回 error / 注入回 status+buffer）、
			 *     dispose（terminate worker + 拒绝在途 embed）。未触发分支为看门狗 240s 超时与桥接 30s 心跳回调体
			 *     （真实计时不会跑，属安全兜底，未逐一造超时）。
			 *
			 * 语义：只许上升、不许下降。新提交只要让任一项跌破阈值，CI 即红。
			 * 切忌把阈值直接写成理想值（第 1 版曾误设为 63，高于当时的实测 61.59%，
			 * 会导致接入当天 CI 永久失败 —— 团队学到的第一件事就是关掉它，这是装置自杀）。
			 *
			 * 拧紧流程：补一批薄弱文件的测试 → 实测提高 → 把阈值同步上调到新值下方。
			 * 定位下一个目标：看 coverage 报告里 ui/ 与 app/ 层低于 20% 的文件。
			 */
			thresholds: {
				lines: 90,
				statements: 90,
				functions: 89,
				branches: 87,
			},
		},
	},
});

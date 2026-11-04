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
			 * 语义：只许上升、不许下降。新提交只要让任一项跌破阈值，CI 即红。
			 * 切忌把阈值直接写成理想值（第 1 版曾误设为 63，高于当时的实测 61.59%，
			 * 会导致接入当天 CI 永久失败 —— 团队学到的第一件事就是关掉它，这是装置自杀）。
			 *
			 * 拧紧流程：补一批薄弱文件的测试 → 实测提高 → 把阈值同步上调到新值下方。
			 * 定位下一个目标：看 coverage 报告里 ui/ 与 app/ 层低于 20% 的文件。
			 */
			thresholds: {
				lines: 84,
				statements: 84,
				functions: 81,
				branches: 85,
			},
		},
	},
});

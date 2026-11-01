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
			 *
			 * 语义：只许上升、不许下降。新提交只要让任一项跌破阈值，CI 即红。
			 * 切忌把阈值直接写成理想值（第 1 版曾误设为 63，高于当时的实测 61.59%，
			 * 会导致接入当天 CI 永久失败 —— 团队学到的第一件事就是关掉它，这是装置自杀）。
			 *
			 * 拧紧流程：补一批薄弱文件的测试 → 实测提高 → 把阈值同步上调到新值下方。
			 * 定位下一个目标：看 coverage 报告里 ui/ 与 app/ 层低于 20% 的文件。
			 */
			thresholds: {
				lines: 80,
				statements: 80,
				functions: 75,
				branches: 82,
			},
		},
	},
});

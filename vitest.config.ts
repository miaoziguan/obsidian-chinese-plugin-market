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
			 *
			 * 语义：只许上升、不许下降。新提交只要让任一项跌破阈值，CI 即红。
			 * 切忌把阈值直接写成理想值（第 1 版曾误设为 63，高于当时的实测 61.59%，
			 * 会导致接入当天 CI 永久失败 —— 团队学到的第一件事就是关掉它，这是装置自杀）。
			 *
			 * 拧紧流程：补一批薄弱文件的测试 → 实测提高 → 把阈值同步上调到新值下方。
			 * 定位下一个目标：看 coverage 报告里 ui/ 与 app/ 层低于 20% 的文件。
			 */
			thresholds: {
				lines: 72,
				statements: 72,
				functions: 67,
				branches: 80,
			},
		},
	},
});

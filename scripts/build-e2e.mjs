/**
 * 构建 E2E 测试包：把源码 + 测试入口打包成浏览器可用的 IIFE。
 * - obsidian → 本地 mock（test/e2e/obsidian-mock.ts）
 * - @xenova/transformers → 桩（渲染层不触发 AI 模型）
 * 输出两个 bundle：
 *   - render.bundle.js   渲染层关键路径（卡片 / 对比页）
 *   - plugin.bundle.js   整插件启动关键路径（onload / 命令 / 设置读写）
 */
import { build } from "esbuild";
import { resolve } from "path";

const alias = {
	obsidian: resolve("test/e2e/obsidian-mock.ts"),
	"@xenova/transformers": resolve("test/e2e/transformers-stub.ts"),
};

const entries = [
	{ in: "test/e2e/render-entry.ts", out: "test/e2e/render.bundle.js" },
	{ in: "test/e2e/plugin-entry.ts", out: "test/e2e/plugin.bundle.js" },
];

for (const e of entries) {
	await build({
		entryPoints: [e.in],
		bundle: true,
		outfile: e.out,
		format: "iife",
		platform: "browser",
		target: ["es2020"],
		alias,
		loader: { ".css": "empty", ".json": "json" },
		logLevel: "info",
	});
	console.log(`[build-e2e] ${e.out} 构建完成`);
}

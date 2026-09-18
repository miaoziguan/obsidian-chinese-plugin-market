/**
 * 在纯 Node 脚本里加载 TS 模块：用 esbuild 现打成 ESM，再以 data URL 动态 import。
 *
 * 目的：让生成脚本与运行时共用 src/domain/deps/rules.ts 这一份正则规则，
 * 杜绝「生成脚本一份、运行时一份」两份正则漂移（弱信号/强信号阈值也必须统一）。
 */

import { build } from "esbuild";

/**
 * @param {string} entry 相对仓库根的 TS 文件路径，如 "src/domain/deps/rules.ts"
 * @returns {Promise<Record<string, unknown>>} 打包后模块的命名导出
 */
export async function loadModule(entry) {
	const out = await build({
		entryPoints: [entry],
		bundle: true,
		format: "esm",
		platform: "node",
		write: false,
	});
	const code = out.outputFiles[0].text;
	return import("data:text/javascript;base64," + Buffer.from(code).toString("base64"));
}

export const loadRules = () => loadModule("src/domain/deps/rules.ts");

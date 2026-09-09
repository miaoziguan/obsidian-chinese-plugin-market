/**
 * ESLint 扁平配置（flat config）
 *
 * 接入 obsidianmd 插件，并以「禁止 document.createElement、强制 Obsidian 的
 * createEl/createDiv/createSpan 系列辅助方法」这一核心规则作为长期保障，
 * 防止该问题在后续迭代中复发。
 *
 * 说明：
 * - `obsidianmd/prefer-create-el` 在本版本是「类型感知规则」，需开启类型化解析
 *   （parserOptions.project 指向仓库 tsconfig.json）。
 * - 不启用插件的完整 recommended 配置——它含 security / sdl / 更多类型感知规则，
 *   在存量代码上会产生海量无关报错。如需更全面把关，应单独做一轮清理后再逐步开启。
 * - 测试文件（*.test.ts）用原生 document.createElement 搭建 jsdom 夹具，属正常
 *   用法，对该规则豁免。
 */
import tseslintParser from "@typescript-eslint/parser";
import tseslint from "typescript-eslint";
import obsidianmd from "eslint-plugin-obsidianmd";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const obsidianGlobals = {
	// Obsidian 注入到全局的 DOM 辅助方法
	createEl: "readonly",
	createDiv: "readonly",
	createSpan: "readonly",
	createSvg: "readonly",
	createFragment: "readonly",
	activeDocument: "readonly",
	activeWindow: "readonly",
	// 浏览器 / 定时器全局
	document: "readonly",
	window: "readonly",
	HTMLElement: "readonly",
	Node: "readonly",
	setTimeout: "readonly",
	clearTimeout: "readonly",
	setInterval: "readonly",
	clearInterval: "readonly",
};

export default [
	{
		files: ["src/**/*.ts"],
		languageOptions: {
			parser: tseslintParser,
			parserOptions: {
				ecmaVersion: "latest",
				sourceType: "module",
				project: "./tsconfig.json",
				tsconfigRootDir: __dirname,
			},
			globals: obsidianGlobals,
		},
		plugins: { obsidianmd, "@typescript-eslint": tseslint.plugin },
		// 仓库源码中已有 eslint-disable @typescript-eslint/* 注释，但本配置
		// 不启用那些规则；关闭「未使用禁用指令」报告，避免无关噪音。
		linterOptions: { reportUnusedDisableDirectives: "off" },
		rules: {
			// 核心：禁止 document.createElement / createEl("div") 等，强制 Obsidian DOM 辅助方法
			"obsidianmd/prefer-create-el": "error",
			// 安全：禁止动态注入 <link>/<style> 元素（应用 styles.css）
			"obsidianmd/no-forbidden-elements": "error",
			// 兼容：禁止在 minAppVersion 以下的 Obsidian API（类型感知）
			"obsidianmd/no-unsupported-api": "error",
			// 安全：禁止整体赋值 element.style 等静态样式赋值
			"obsidianmd/no-static-styles-assignment": "error",
			// 规范：避免全局 this / 优先平台定时器 / 禁止示例残留代码
			"obsidianmd/no-global-this": "warn",
			"obsidianmd/prefer-window-timers": "warn",
			"obsidianmd/no-sample-code": "error",
		},
	},
	{
		// 测试文件用原生 DOM 做 jsdom 夹具，豁免该规则
		files: ["src/**/*.test.ts"],
		rules: {
			"obsidianmd/prefer-create-el": "off",
		},
	},
];

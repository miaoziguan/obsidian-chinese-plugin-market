/**
 * obsidian 模块的测试 mock。
 * 仅提供被源码 import 的最小 API 表面。真实 HTTP 行为在测试中由各自的
 * mock provider 覆盖，因此这里的 requestUrl 默认抛错，防止误连真实网络。
 */

export async function requestUrl(): Promise<never> {
	throw new Error(
		"requestUrl 在测试中被调用但未 mock —— 请在测试里注入 mock provider 而非真实网络请求"
	);
}

// 下列为源码类型引用可能需要的占位（按需扩充）
export class ItemView {}
export class Notice {}
export class Plugin {}
export class PluginSettingTab {}
export class Setting {}
export class Modal {}
export class TFile {}
export class Component {
	load() {}
	unload() {}
}
export const MarkdownRenderer = {
	async render() {},
};

/** 测试环境直接透传路径（无需 OS 归一化） */
export function normalizePath(p: string): string {
	return p;
}
export type App = unknown;
export type WorkspaceLeaf = unknown;

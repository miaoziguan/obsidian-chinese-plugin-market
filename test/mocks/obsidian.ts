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

// 测试环境补齐 Obsidian 在 HTMLElement 上挂载的样式辅助方法（setCssStyles / setCssProps），
// 使源码中 el.setCssStyles({...}) 的写法在 jsdom 下可运行（jsdom 原生 HTMLElement 不含这两个方法）。
// 实现语义对齐 Obsidian：批量写 style 属性。
if (typeof globalThis.HTMLElement !== "undefined" && !("setCssStyles" in globalThis.HTMLElement.prototype)) {
	const proto = globalThis.HTMLElement.prototype as unknown as {
		setCssStyles: (styles: Record<string, string>) => void;
		setCssProps: (props: Record<string, string>) => void;
	};
	proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		for (const [k, v] of Object.entries(styles)) {
			this.style.setProperty(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), v);
		}
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) {
			this.style.setProperty(k, v);
		}
	};
}
/** 测试环境直接透传路径（无需 OS 归一化） */
export function normalizePath(p: string): string {
	return p;
}
export type App = unknown;
export type WorkspaceLeaf = unknown;

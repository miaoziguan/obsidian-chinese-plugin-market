/**
 * 浏览器环境用的 obsidian 模块 mock（仅 E2E 测试使用）。
 *
 * 源码的渲染层（card-render / compare-view）依赖 Obsidian 给 HTMLElement
 * 注入的原型方法（createEl / appendText / empty 等）以及 Component 上的
 * createDiv/createSpan。本 mock 在导入时把这些方法补回原型，使渲染函数在
 * 真实浏览器（Playwright/Chromium）中可用。
 */
import { debounce } from "./obsidian-debounce";

// ── HTMLElement 原型扩展（对齐 Obsidian 的实现） ──
type ElOpts = {
	cls?: string | string[];
	text?: string;
	attr?: Record<string, string>;
	href?: string;
	type?: string;
};

function applyOpts(el: HTMLElement, opts?: ElOpts): HTMLElement {
	if (opts) {
		if (opts.cls) el.className = Array.isArray(opts.cls) ? opts.cls.join(" ") : opts.cls;
		if (opts.text != null) el.textContent = opts.text;
		if (opts.attr) for (const [k, v] of Object.entries(opts.attr)) el.setAttribute(k, String(v));
		if (opts.href) (el as HTMLAnchorElement).href = opts.href;
		if (opts.type) (el as HTMLButtonElement).type = opts.type;
	}
	return el;
}

function makeEl(tag: string, opts?: ElOpts): HTMLElement {
	return applyOpts(document.createElement(tag), opts);
}

function createEl(this: HTMLElement, tag: string, opts?: ElOpts): HTMLElement {
	const el = makeEl(tag, opts);
	this.appendChild(el); // Obsidian 的 createEl 会挂载到 this
	return el;
}

function appendText(this: HTMLElement, text: string): HTMLElement {
	this.appendChild(document.createTextNode(text));
	return this;
}

function setText(this: HTMLElement, text: string): HTMLElement {
	this.textContent = text;
	return this;
}

function setAttr(this: HTMLElement, attr: Record<string, string>): HTMLElement {
	for (const [k, v] of Object.entries(attr)) this.setAttribute(k, v);
	return this;
}

function empty(this: HTMLElement): HTMLElement {
	while (this.firstChild) this.removeChild(this.firstChild);
	return this;
}

function addClass(this: HTMLElement, ...cls: string[]): HTMLElement {
	this.classList.add(...cls);
	return this;
}

function removeClass(this: HTMLElement, ...cls: string[]): HTMLElement {
	this.classList.remove(...cls);
	return this;
}

function toggleClass(this: HTMLElement, cls: string, on?: boolean): HTMLElement {
	if (on === undefined) this.classList.toggle(cls);
	else if (on) this.classList.add(cls);
	else this.classList.remove(cls);
	return this;
}

function show(this: HTMLElement): HTMLElement {
	this.style.display = "";
	return this;
}

function hide(this: HTMLElement): HTMLElement {
	this.style.display = "none";
	return this;
}

const proto = HTMLElement.prototype as any;
proto.createEl ??= createEl;
proto.appendText ??= appendText;
proto.setText ??= setText;
proto.setAttr ??= setAttr;
proto.empty ??= empty;
proto.addClass ??= addClass;
proto.removeClass ??= removeClass;
proto.toggleClass ??= toggleClass;
proto.show ??= show;
proto.hide ??= hide;
// Obsidian 的 setCssStyles（camelCase → kebab-case 设 style），e2e 浏览器环境补齐
if (!proto.setCssStyles) {
	proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		for (const [k, v] of Object.entries(styles)) {
			this.style.setProperty(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), v);
		}
	};
}
// 内联赋值，避免被 esbuild tree-shake（仅原型赋值引用时会被移除）
proto.createDiv = function (this: HTMLElement, opts?: ElOpts): HTMLElement {
	return (proto.createEl as (this: HTMLElement, tag: string, o?: ElOpts) => HTMLElement).call(this, "div", opts);
};
proto.createSpan = function (this: HTMLElement, opts?: ElOpts): HTMLElement {
	return (proto.createEl as (this: HTMLElement, tag: string, o?: ElOpts) => HTMLElement).call(this, "span", opts);
};
// Obsidian 全局 helper：card-render 等用全局 createDiv()/createSpan()/createEl()/createFragment()
// （非实例方法），e2e 浏览器环境需补全局函数
(globalThis as unknown as Record<string, unknown>).createDiv = (opts?: ElOpts) => makeEl("div", opts);
(globalThis as unknown as Record<string, unknown>).createSpan = (opts?: ElOpts) => makeEl("span", opts);
(globalThis as unknown as Record<string, unknown>).createEl = (tag: string, opts?: ElOpts) => makeEl(tag, opts);
(globalThis as unknown as Record<string, unknown>).createFragment = () => document.createDocumentFragment();

// ── 渲染层 import 的最小符号 ──
export class Component {
	load(): void {}
	unload(): void {}
	registerEvent(): void {}
	register(): void {}
	createEl(tag: string, opts?: ElOpts): HTMLElement {
		return makeEl(tag, opts);
	}
	createDiv(opts?: ElOpts): HTMLElement {
		return makeEl("div", opts);
	}
	createSpan(opts?: ElOpts): HTMLElement {
		return makeEl("span", opts);
	}
}

export class Notice {
	constructor(_msg?: string, _timeout?: number) {}
}

export class Modal {
	constructor(_app?: unknown) {}
	open(): void {}
	close(): void {}
	contentEl = document.createElement("div");
}

export class PluginSettingTab {
	constructor(_app?: unknown, _plugin?: unknown) {}
	display(): void {}
	containerEl = document.createElement("div");
}

export class Setting {
	constructor(_containerEl?: HTMLElement) {}
	setName(): this { return this; }
	setDesc(): this { return this; }
	addButton(): this { return this; }
	addToggle(): this { return this; }
	addText(): this { return this; }
}

export class ItemView {
	containerEl = document.createElement("div");
	contentEl = document.createElement("div");
	leaf: unknown = null;
	icon = "";
	app: unknown = null;
	getViewType(): string { return ""; }
	async onOpen(): Promise<void> {}
	async onClose(): Promise<void> {}
}

export class Plugin {
	app: any;
	manifest: any;
	/** onload 期间注册的内容（供 E2E 断言「整插件启动关键路径」） */
	commands: { id: string; name: string; callback?: () => void }[] = [];
	ribbonIcons: { icon: string; title: string; callback?: () => void }[] = [];
	settingTabs: unknown[] = [];
	views: { type: string; factory: (leaf: unknown) => unknown }[] = [];
	/** 内存数据仓：loadData 读取、saveData 写入（替代真实 data.json） */
	_data: Record<string, unknown> = {};
	constructor(app?: any, manifest?: any) {
		this.app = app;
		this.manifest = manifest;
	}
	async onload(): Promise<void> {}
	onunload(): void {}
	addRibbonIcon(icon: string, title: string, callback?: () => void): void {
		this.ribbonIcons.push({ icon, title, callback });
	}
	addCommand(cmd: { id: string; name: string; callback?: () => void }): void {
		this.commands.push({ id: cmd.id, name: cmd.name, callback: cmd.callback });
	}
	addSettingTab(tab: unknown): void {
		this.settingTabs.push(tab);
	}
	registerView(type: string, factory: (leaf: unknown) => unknown): void {
		this.views.push({ type, factory });
	}
	registerEvent(): void {}
	async loadData(): Promise<Record<string, unknown>> {
		return this._data;
	}
	async saveData(data: Record<string, unknown>): Promise<void> {
		this._data = data;
	}
}

/**
 * 浏览器侧 vault.adapter mock。
 * read 通过 fetch 读取仓库根下的真实 JSON（路径形如
 * .obsidian/plugins/<id>/<file> → /<file>），从而真正走「推荐清单 /
 * 批量词典 / 分类索引」的文件加载路径；不存在时抛错，由插件侧优雅降级。
 */
export function makeAdapter() {
	const toUrl = (path: string): string => {
		const m = String(path).match(/\.obsidian\/plugins\/[^/]+\/(.+)$/);
		return m ? "/" + m[1] : "/" + String(path).replace(/^[./]+/, "");
	};
	return {
		async exists(path: string): Promise<boolean> {
			try {
				const r = await fetch(toUrl(path));
				return r.ok;
			} catch {
				return false;
			}
		},
		async read(path: string): Promise<string> {
			const r = await fetch(toUrl(path));
			if (!r.ok) throw new Error(`E2E: 文件不存在 ${path}`);
			return r.text();
		},
		async write(): Promise<void> {},
		async mkdir(): Promise<void> {},
		async list(): Promise<string[]> {
			return [];
		},
		async remove(): Promise<void> {},
		async rmdir(): Promise<void> {},
		async stat() {
			return { type: "file", size: 0, ctime: 0, mtime: 0 };
		},
		async copy(): Promise<void> {},
	};
}

/** 浏览器侧 App mock：workspace + vault.adapter（供实例化真实 Plugin） */
export function makeApp() {
	return {
		workspace: {
			getLeavesOfType: (): unknown[] => [],
			getLeaf: () => ({
				setViewState: async (): Promise<void> => {},
				setViewStateAsync: async (): Promise<void> => {},
				detach: (): void => {},
			}),
			setActiveLeaf: (): void => {},
			onLayoutReady: (cb: () => void): void => cb(), // 同步执行布局就绪回调
			on: () => ({ unload: (): void => {} }),
			off: (): void => {},
			trigger: (): void => {},
		},
		vault: {
			adapter: makeAdapter(),
			getName: () => "vault",
			getAbstractFileByPath: () => null,
			read: async (): Promise<string> => "",
		},
	};
}

export class MarkdownRenderer {
	static async render(_markdown: string, el: HTMLElement): Promise<void> {
		el.textContent = _markdown;
	}
}

export const Platform = {
	isMobile: false,
	isDesktop: true,
};

export function setIcon(el: HTMLElement, _icon: string): void {
	el.setAttribute("data-icon", _icon);
}

export async function requestUrl(_opts: unknown): Promise<never> {
	throw new Error("requestUrl 在 E2E 中不应被调用");
}

export { debounce };

export type App = unknown;
export type WorkspaceLeaf = unknown;
export class TFile {}
export class TFolder {}
export const normalizePath = (p: string): string => p;
export type Vault = unknown;
export type Workspace = unknown;
export type Scope = unknown;

/** E2E mock of Obsidian 的 Menu 组件（仅覆盖 e2e 用到的 API） */
export class Menu {
	items: { title: string; icon?: string; onClick?: () => void }[] = [];
	addItem(cb: (item: { setTitle: (t: string) => void; setIcon: (i: string) => void; onClick: (h: () => void) => void }) => void): this {
		const entry: { title: string; icon?: string; onClick?: () => void } = { title: "" };
		cb({
			setTitle: (t: string) => { entry.title = t; },
			setIcon: (i: string) => { entry.icon = i; },
			onClick: (h: () => void) => { entry.onClick = h; },
		});
		this.items.push(entry);
		return this;
	}
	showAtMouseEvent(_evt: MouseEvent): void {}
	showAtElement(_el: HTMLElement): void {}
	showAtPosition(_pos: { x: number; y: number }): void {}
}

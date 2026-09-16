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
export class Setting {
	constructor(_containerEl?: HTMLElement) {}
	setName(_name: string): this { return this; }
	setDesc(_desc: string): this { return this; }
	setClass(_cls: string): this { return this; }
	addText(cb: (t: TextComponent) => unknown): this {
		cb(new TextComponent());
		return this;
	}
	addButton(cb: (b: ButtonComponent) => unknown): this {
		cb(new ButtonComponent());
		return this;
	}
	addColor(cb: (c: ColorComponent) => unknown): this {
		cb(new ColorComponent());
		return this;
	}
}
export class Modal {
	app: unknown;
	contentEl: HTMLElement;
	constructor(app?: unknown) {
		this.app = app;
		this.contentEl = document.createElement("div");
	}
	open(): void { this.onOpen(); }
	close(): void { this.onClose(); }
	onOpen(): void {}
	onClose(): void {}
}
export class TFile {}
export class Component {
	load() {}
	unload() {}
}

/**
 * Menu 的最小可用实现。
 * 只补齐源码用到的 addItem / showAtMouseEvent，并保留 items 与 lastShown
 * 供测试断言菜单项内容与「菜单确实被弹出」。
 */
type MenuItemApi = {
	setTitle(title: string): MenuItemApi;
	setChecked(checked: boolean): MenuItemApi;
	setIcon(icon: string): MenuItemApi;
	onClick(cb: () => void): MenuItemApi;
};

export interface MenuItemSnapshot {
	title: string;
	checked: boolean;
	icon?: string;
	cb: (() => void) | null;
}

export class Menu {
	/** 最近一次被弹出的菜单（测试断言用） */
	static lastShown: Menu | null = null;
	readonly items: MenuItemSnapshot[] = [];

	addSeparator(): Menu {
		return this;
	}

	addItem(cb: (item: MenuItemApi) => void): Menu {
		const entry: MenuItemSnapshot = { title: "", checked: false, cb: null };
		const api: MenuItemApi = {
			setTitle: (title: string) => {
				entry.title = title;
				return api;
			},
			setChecked: (checked: boolean) => {
				entry.checked = checked;
				return api;
			},
			setIcon: (icon: string) => {
				entry.icon = icon;
				return api;
			},
			onClick: (fn: () => void) => {
				entry.cb = fn;
				return api;
			},
		};
		cb(api);
		this.items.push(entry);
		return this;
	}

	showAtMouseEvent(): void {
		Menu.lastShown = this;
	}

	close(): void {}
}

// 以下为设置页增强所需的 Obsidian 组件最小实现，供测试断言组件行为
// （源码以 `import { DropdownComponent, ExtraButtonComponent } from "obsidian"` 引用）。

/** DropdownComponent：底层 <select>，支持选项 / 取值 / 变更回调 */
export class DropdownComponent {
	selectEl: HTMLSelectElement;
	private value = "";
	constructor(containerEl?: HTMLElement) {
		this.selectEl = document.createElement("select");
		if (containerEl) containerEl.appendChild(this.selectEl);
	}
	addOption(value: string, text: string): this {
		const option = document.createElement("option");
		option.value = value;
		option.textContent = text;
		this.selectEl.appendChild(option);
		return this;
	}
	setValue(value: string): this {
		this.value = value;
		this.selectEl.value = value;
		return this;
	}
	getValue(): string {
		return this.value || this.selectEl.value;
	}
	onChange(cb: (value: string) => unknown): this {
		this.selectEl.addEventListener("change", () => {
			this.value = this.selectEl.value;
			void cb(this.value);
		});
		return this;
	}
}

/** ToggleComponent：底层 .checkbox-container，支持取值 / 变更回调 */
export class ToggleComponent {
	toggleEl: HTMLElement;
	private value = false;
	constructor(containerEl?: HTMLElement) {
		this.toggleEl = document.createElement("div");
		this.toggleEl.className = "checkbox-container";
		if (containerEl) containerEl.appendChild(this.toggleEl);
	}
	setValue(value: boolean): this {
		this.value = value;
		this.toggleEl.classList.toggle("is-enabled", value);
		return this;
	}
	onChange(cb: (value: boolean) => unknown): this {
		this.toggleEl.addEventListener("click", () => {
			this.value = !this.value;
			this.setValue(this.value);
			void cb(this.value);
		});
		return this;
	}
}

/** ExtraButtonComponent：底层 <button class="extra-button">，支持图标 / 提示 / 点击 */
export class ExtraButtonComponent {
	extraSettingsEl: HTMLButtonElement;
	constructor(containerEl?: HTMLElement) {
		this.extraSettingsEl = document.createElement("button");
		this.extraSettingsEl.className = "extra-button";
		if (containerEl) containerEl.appendChild(this.extraSettingsEl);
	}
	setIcon(name: string): this {
		this.extraSettingsEl.dataset.icon = name;
		this.extraSettingsEl.classList.add(`cpm-icon-${name}`);
		return this;
	}
	setTooltip(tooltip: string): this {
		this.extraSettingsEl.setAttribute("aria-label", tooltip);
		return this;
	}
	setDisabled(disabled: boolean): this {
		this.extraSettingsEl.toggleAttribute("disabled", disabled);
		return this;
	}
	onClick(cb: () => unknown): this {
		this.extraSettingsEl.addEventListener("click", () => void cb());
		return this;
	}
}

/** TextComponent：底层 <input type=text>，支持取值 / 占位 / 输入回调 */
export class TextComponent {
	inputEl: HTMLInputElement;
	private value = "";
	constructor(containerEl?: HTMLElement) {
		this.inputEl = document.createElement("input");
		this.inputEl.type = "text";
		if (containerEl) containerEl.appendChild(this.inputEl);
	}
	setValue(value: string): this { this.value = value; this.inputEl.value = value; return this; }
	getValue(): string { return this.value || this.inputEl.value; }
	setPlaceholder(text: string): this { this.inputEl.placeholder = text; return this; }
	onChange(cb: (value: string) => unknown): this {
		this.inputEl.addEventListener("input", () => {
			this.value = this.inputEl.value;
			void cb(this.value);
		});
		return this;
	}
}

/** ButtonComponent：底层 <button>，支持文案 / CTA / 图标 / 点击 */
export class ButtonComponent {
	buttonEl: HTMLButtonElement;
	constructor(containerEl?: HTMLElement) {
		this.buttonEl = document.createElement("button");
		if (containerEl) containerEl.appendChild(this.buttonEl);
	}
	setButtonText(text: string): this { this.buttonEl.textContent = text; return this; }
	setCta(): this { return this; }
	setWarning(): this { return this; }
	setIcon(name: string): this { this.buttonEl.dataset.icon = name; return this; }
	setTooltip(tip: string): this { this.buttonEl.setAttribute("aria-label", tip); return this; }
	onClick(cb: () => unknown): this {
		this.buttonEl.addEventListener("click", () => void cb());
		return this;
	}
}

/** ColorComponent：底层 <input type=color>，支持取值 / 变更回调 */
export class ColorComponent {
	inputEl: HTMLInputElement;
	private value = "";
	constructor(containerEl?: HTMLElement) {
		this.inputEl = document.createElement("input");
		this.inputEl.type = "color";
		if (containerEl) containerEl.appendChild(this.inputEl);
	}
	setValue(value: string): this { this.value = value; this.inputEl.value = value; return this; }
	getValue(): string { return this.value || this.inputEl.value; }
	onChange(cb: (value: string) => unknown): this {
		this.inputEl.addEventListener("input", () => {
			this.value = this.inputEl.value;
			void cb(this.value);
		});
		return this;
	}
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

/** setIcon 的最小实现（源码以 `import { setIcon } from "obsidian"` 引用） */
export function setIcon(el: HTMLElement, icon: string): HTMLElement {
	el.dataset.icon = icon;
	el.classList.add(`cpm-icon-${icon}`);
	return el;
}

/** 全局 DOM 构造函数的导出版（源码以 `import { createEl } from "obsidian"` 引用） */
export function createEl(tag: string, o?: { cls?: string; text?: string }): HTMLElement {
	const el = document.createElement(tag);
	if (o?.cls) el.className = o.cls;
	if (o?.text) el.textContent = o.text;
	return el;
}
export function createDiv(o?: { cls?: string; text?: string }): HTMLElement {
	return createEl("div", o);
}
export function createSpan(o?: { cls?: string; text?: string }): HTMLElement {
	return createEl("span", o);
}

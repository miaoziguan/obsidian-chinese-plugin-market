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

/**
 * Menu 的最小可用实现。
 * 只补齐源码用到的 addItem / showAtMouseEvent，并保留 items 与 lastShown
 * 供测试断言菜单项内容与「菜单确实被弹出」。
 */
type MenuItemApi = {
	setTitle(title: string): MenuItemApi;
	setChecked(checked: boolean): MenuItemApi;
	onClick(cb: () => void): MenuItemApi;
};

export interface MenuItemSnapshot {
	title: string;
	checked: boolean;
	cb: (() => void) | null;
}

export class Menu {
	/** 最近一次被弹出的菜单（测试断言用） */
	static lastShown: Menu | null = null;
	readonly items: MenuItemSnapshot[] = [];

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

export const MarkdownRenderer = {
	async render() {},
};

/** 测试环境直接透传路径（无需 OS 归一化） */
export function normalizePath(p: string): string {
	return p;
}
export type App = unknown;
export type WorkspaceLeaf = unknown;

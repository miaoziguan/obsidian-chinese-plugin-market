/**
 * 官方 select 风格下拉（与搜索模式选择器同款交互与视觉）。
 *
 * button 显示当前项文案，点击弹原生 Menu（勾选/分隔线由 Obsidian 官方渲染）。
 * 供 CSS 片段 / 收藏等页签的筛选下拉复用，替换原生 <select>（OS 级弹层无法定制）。
 *
 * 复用 .pt-select / .pt-select-btn / .pt-select-caret 现有样式，零新增 CSS。
 * 页面自身在状态变化后会整页重渲，无需外部同步按钮文案。
 *
 * 注：与 view-css-snippets / view-favorites 同款约束——只用标准 DOM API +
 * Obsidian 全局 createDiv/createEl/createSpan，不依赖 HTMLElement 原型扩展，
 * 以便与 jsdom 测试环境一致。
 */

import { Menu, setIcon } from "obsidian";

export interface MenuSelectOption {
	value: string;
	label: string;
}

export interface MenuSelectHandle {
	/** 外层 .pt-select 容器（含按钮） */
	el: HTMLElement;
	/** 外部状态变化时刷新按钮文案（一般整页重渲场景用不到） */
	refresh: () => void;
}

export function createMenuSelect(
	parent: HTMLElement,
	opts: {
		getOptions: () => MenuSelectOption[];
		getValue: () => string;
		onPick: (value: string) => void;
	},
): MenuSelectHandle {
	const wrap = createDiv({ cls: "pt-select" });
	const btn = createEl("button", {
		cls: "pt-select-btn",
		attr: { type: "button", "aria-haspopup": "menu" },
	});
	const labelEl = createSpan({ cls: "pt-select-label" });
	btn.appendChild(labelEl);
	const caret = createSpan({ cls: "pt-select-caret" });
	btn.appendChild(caret);
	setIcon(caret, "chevrons-up-down");
	wrap.appendChild(btn);

	const refresh = () => {
		const options = opts.getOptions();
		const cur = options.find((o) => o.value === opts.getValue()) ?? options[0];
		if (cur) labelEl.textContent = cur.label;
	};
	refresh();

	btn.addEventListener("click", () => {
		const menu = new Menu();
		for (const option of opts.getOptions()) {
			menu.addItem((item) =>
				item
					.setTitle(option.label)
					.setChecked(option.value === opts.getValue())
					.onClick(() => {
						if (option.value !== opts.getValue()) opts.onPick(option.value);
					}),
			);
		}
		// 锚定整颗胶囊：左对齐、从下缘展开（与官方 select 下拉一致）
		const rect = btn.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	});

	parent.appendChild(wrap);
	return { el: wrap, refresh };
}

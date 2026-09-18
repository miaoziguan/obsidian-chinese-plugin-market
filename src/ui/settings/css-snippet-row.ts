/**
 * CSS 片段行的统一渲染器。
 *
 * 「插件设置页内的 CSS 片段列表」与「外观页增强」共用同一套行 UI 与交互，
 * 保证两处的分组徽标 / 备注 / 启用开关 / 打开文件 / 重命名口径完全一致，
 * 也避免同一份行逻辑在两处各写一遍导致行为漂移。
 */

import {
	Menu,
	Notice,
	ToggleComponent,
	ExtraButtonComponent,
	setIcon,
} from "obsidian";
import { pickLang } from "@shared/i18n";
import { logger } from "@shared/logger";
import { GROUP_ALL, GROUP_OTHER } from "@domain/manage/types";
import { listGroups } from "@domain/manage/group";
import { getMeta } from "@domain/manage/plugin-meta";
import { renderInlineNoteEditor } from "./inline-note-editor";
import type { SnippetInfo } from "@data/platform/snippet";
import type { CssStorePort } from "./snippet-manage-store";

export interface CssSnippetRowContext {
	store: CssStorePort;
	/** 行内容变化（分组 / 备注）后重画该行 */
	onRowChange: (rowEl: HTMLElement, baseName: string) => void;
	/** 可能影响可见性的变化 → 重算筛选与计数 */
	onFilterChange: () => void;
	/** 请求重命名（宿主负责弹窗，ui 层不直接依赖 modal） */
	requestRename: (baseName: string) => void;
}

/** 「全部」与「其他」不显示为徽标 */
function shouldShowBadge(groupKey: string, hasName: boolean): boolean {
	return hasName && groupKey !== GROUP_ALL && groupKey !== GROUP_OTHER;
}

/**
 * 把单行片段渲染进 rowEl（调用方负责创建并标记 rowEl 的 data-cpm-snippet）。
 * 行数据从 store 实时读取，因此重画总能拿到最新分组 / 备注。
 */
export function renderCssSnippetRow(
	rowEl: HTMLElement,
	snippet: SnippetInfo,
	ctx: CssSnippetRowContext,
): void {
	const { store } = ctx;
	const meta = getMeta(store.settings.cssMeta, snippet.baseName);
	const groupName = store.settings.cssGroups[meta.group];

	const infoEl = createDiv({ cls: "setting-item-info" });
	rowEl.appendChild(infoEl);

	const nameEl = createDiv({ cls: "setting-item-name" });
	infoEl.appendChild(nameEl);
	nameEl.appendChild(createSpan({ text: snippet.name }));
	if (shouldShowBadge(meta.group, Boolean(groupName))) {
		const badge = createSpan({ cls: "cpm-group-badge", text: groupName });
		nameEl.appendChild(badge);
		const color = store.settings.cssGroupColors[meta.group];
		if (color) badge.setCssProps({ "--cpm-group-color": color });
	}

	const noteHost = createDiv({
		cls: "setting-item-description cpm-note-field",
	});
	infoEl.appendChild(noteHost);
	renderInlineNoteEditor(noteHost, {
		value: meta.remark,
		placeholder: pickLang("manage.note.ph"),
		emptyText: pickLang("manage.note.empty"),
		onSave: (value) => {
			store.saveCssMeta(snippet.baseName, { remark: value });
			ctx.onFilterChange();
		},
	});

	const controlEl = createDiv({ cls: "setting-item-control" });
	rowEl.appendChild(controlEl);

	const toggle = new ToggleComponent(controlEl);
	toggle.setValue(snippet.enabled);
	toggle.onChange((enabled) => {
		void store.setSnippetEnabled(snippet.baseName, enabled);
	});

	const groupBtn = createEl("button", { cls: "cpm-group-btn clickable-icon" });
	setIcon(groupBtn, "tag");
	groupBtn.type = "button";
	groupBtn.setAttribute("aria-label", pickLang("manage.group.set"));
	groupBtn.setAttribute("title", pickLang("manage.group.set"));
	groupBtn.addEventListener("click", (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		openGroupMenu(event, store, snippet.baseName, meta.group, rowEl, ctx);
	});
	controlEl.appendChild(groupBtn);

	// 打开按钮用原生 <button>：外观页的原生行控件区已是合成 DOM，
	// <button> 比 ExtraButtonComponent 更容易保持一致的点击语义。
	const openBtn = createEl("button", { cls: "cpm-open-btn" });
	openBtn.type = "button";
	setIcon(openBtn, "folder-open");
	openBtn.setAttribute("aria-label", pickLang("manage.file.open"));
	openBtn.setAttribute("title", pickLang("manage.file.open"));
	openBtn.addEventListener("click", (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		store.openSnippet(snippet.path);
	});
	controlEl.appendChild(openBtn);

	new ExtraButtonComponent(controlEl)
		.setIcon("pencil")
		.setTooltip(pickLang("manage.file.rename"))
		.onClick(() => ctx.requestRename(snippet.baseName));
}

/** 分组菜单：选中后重画该行并重算计数 */
function openGroupMenu(
	event: MouseEvent,
	store: CssStorePort,
	baseName: string,
	currentGroup: string,
	rowEl: HTMLElement,
	ctx: CssSnippetRowContext,
): void {
	try {
		const menu = new Menu();
		for (const { key, name } of listGroups(store.settings.cssGroups)) {
			if (key === GROUP_ALL) continue;
			menu.addItem((item) =>
				item
					.setTitle(name)
					.setChecked(key === currentGroup)
					.onClick(() => {
						store.saveCssMeta(baseName, { group: key });
						ctx.onRowChange(rowEl, baseName);
						ctx.onFilterChange();
					}),
			);
		}
		menu.addSeparator();
		menu.addItem((item) =>
			item
				.setTitle(pickLang("manage.file.rename"))
				.setIcon("pencil")
				.onClick(() => ctx.requestRename(baseName)),
		);
		menu.showAtMouseEvent(event);
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 打开 CSS 分组菜单失败：", error);
		new Notice("打开分组菜单失败，详情见控制台日志");
	}
}

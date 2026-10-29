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
import { GROUP_ALL, type ManageRow } from "@domain/manage/types";
import { listGroups, shouldShowGroupBadge } from "@domain/manage/group";
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

/** 从原生或自渲染片段行读取筛选数据，启用状态以当前 DOM 为准。 */
export function readCssSnippetRow(rowEl: HTMLElement, store: CssStorePort): ManageRow | null {
	const baseName = rowEl.dataset.cpmSnippet;
	if (!baseName) return null;
	const meta = getMeta(store.settings.cssMeta, baseName);
	return {
		id: baseName,
		name: baseName,
		author: "",
		remark: meta.remark,
		group: meta.group,
		enabled: Boolean(rowEl.querySelector(".checkbox-container.is-enabled")),
	};
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
	if (shouldShowGroupBadge(meta.group, Boolean(groupName))) {
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
	let displayedEnabled = snippet.enabled;
	let pending = false;
	toggle.onChange((enabled) => {
		// Obsidian 的 ToggleComponent 会先乐观切换 DOM。等待平台层确认后再保留，
		// 失败则立即恢复真实值；pending 期间的重复点击不会把旧快照再次写回。
		if (pending) {
			toggle.setValue(displayedEnabled);
			return;
		}
		pending = true;
		void Promise.resolve(store.setSnippetEnabled(snippet.baseName, enabled))
			.then((result) => {
				const current = store
					.listSnippets()
					.find((item) => item.baseName === snippet.baseName)?.enabled;
				const success = result !== false;
				displayedEnabled = success ? (current ?? enabled) : (current ?? displayedEnabled);
				toggle.setValue(displayedEnabled);
				if (!success) {
					new Notice(pickLang("manage.toggle.fail", { name: snippet.baseName }));
				}
				ctx.onFilterChange();
			})
			.catch((error) => {
				toggle.setValue(displayedEnabled);
				logger.warn("[Chinese Plugin Market] CSS 片段开关回滚失败：", error);
				new Notice(pickLang("manage.toggle.fail", { name: snippet.baseName }));
			})
			.finally(() => {
				pending = false;
			});
	});

	const groupBtn = createEl("button", { cls: "cpm-group-btn clickable-icon" });
	setIcon(groupBtn, "tag");
	groupBtn.type = "button";
	groupBtn.setAttribute("aria-label", pickLang("manage.group.set"));
	groupBtn.setAttribute("title", pickLang("manage.group.set"));
	groupBtn.addEventListener("click", (event: MouseEvent) => {
		event.preventDefault();
		event.stopPropagation();
		openCssSnippetGroupMenu(event, store, snippet.baseName, meta.group, () => {
			ctx.onRowChange(rowEl, snippet.baseName);
			ctx.onFilterChange();
		});
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
export function openCssSnippetGroupMenu(
	event: MouseEvent,
	store: CssStorePort,
	baseName: string,
	currentGroup: string,
	onChange: () => void,
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
						onChange();
					}),
			);
		}
		menu.showAtMouseEvent(event);
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 打开 CSS 分组菜单失败：", error);
		new Notice("打开分组菜单失败，详情见控制台日志");
	}
}

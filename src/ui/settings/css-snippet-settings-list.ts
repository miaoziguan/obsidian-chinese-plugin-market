/**
 * 插件设置页内的「CSS 片段管理」独立列表。
 *
 * 与原生外观页增强（SnippetListEnhancer）互补：当 Obsidian 版本把 CSS 片段
 * 收进带箭头的汇总行、不直接列出片段时，本列表保证用户在本插件设置页里
 * 始终能看到并管理片段（分组 / 备注 / 启用 / 重命名 / 打开文件），
 * 包括 vault 里没有任何 .css 文件的空状态。
 */

import {
	Menu,
	Notice,
	ToggleComponent,
	ExtraButtonComponent,
} from "obsidian";
import { pickLang } from "@shared/i18n";
import { GROUP_ALL, GROUP_OTHER, type ManageRow } from "@domain/manage/types";
import { listGroups } from "@domain/manage/group";
import { getMeta } from "@domain/manage/plugin-meta";
import {
	countByGroup,
	matchesFilter,
	type ManageFilterState,
} from "@domain/manage/manage-filter";
import { ManageFilterBar } from "./manage-filter-bar";
import { renderInlineNoteEditor } from "./inline-note-editor";
import { SnippetRenameModal } from "./snippet-rename-modal";
import type { CssStorePort } from "./snippet-manage-store";
import type { App } from "obsidian";
import type { SnippetInfo } from "@data/platform/snippet";

const FILTERED_CLASS = "cpm-filtered-out";

export interface CssSnippetSettingsHost {
	/** 管理分组按钮回调：当前已在设置页，重新打开即可回到分组区 */
	openPluginSettings: () => void;
	/** 弹窗管理分组（对齐参考插件的模态框交互） */
	openManageGroups: () => void;
}

export class CssSnippetSettingsList {
	private rootEl: HTMLElement | null = null;
	private listEl: HTMLElement | null = null;
	private emptyEl: HTMLElement | null = null;
	private filterBar: ManageFilterBar | null = null;

	constructor(
		private readonly app: App,
		private readonly store: CssStorePort,
		private readonly host: CssSnippetSettingsHost,
	) {}

	/** 渲染完整列表到容器 */
	render(containerEl: HTMLElement): void {
		this.rootEl = containerEl;
		containerEl.innerHTML = "";
		containerEl.classList.add("pt-setting-full-width");

		this.renderToolbar(containerEl);
		this.listEl = createDiv({ cls: "cpm-css-settings-list" });
		containerEl.appendChild(this.listEl);
		this.renderRows();
		this.applyFilters();
	}

	/** 数据变化后整体刷新 */
	refresh(): void {
		if (!this.rootEl) return;
		this.render(this.rootEl);
	}

	// ── 工具栏 ──

	private renderToolbar(parent: HTMLElement): void {
		this.filterBar = new ManageFilterBar({
			onChange: () => this.applyFilters(),
			onManageGroups: () => this.host.openManageGroups(),
		});
		this.filterBar.mount(parent);
		this.filterBar.restore(this.store.settings.cssFilterState);
		this.filterBar.updateGroups(listGroups(this.store.settings.cssGroups), {});
	}

	// ── 行列表 ──

	private renderRows(): void {
		if (!this.listEl) return;
		this.listEl.innerHTML = "";
		const snippets = this.store.listSnippets();
		for (const snippet of snippets) {
			const rowEl = createDiv({ cls: "cpm-css-settings-row setting-item" });
			rowEl.dataset.cpmSnippet = snippet.baseName;
			this.listEl.appendChild(rowEl);
			this.renderRow(snippet, rowEl);
		}
		this.renderEmptyState(snippets.length === 0);
	}

	private renderRow(snippet: SnippetInfo, rowEl: HTMLElement): void {
		const meta = getMeta(this.store.settings.cssMeta, snippet.baseName);
		const groupName = this.store.settings.cssGroups[meta.group];

		const infoEl = createDiv({ cls: "setting-item-info" });
		rowEl.appendChild(infoEl);
		const nameEl = createDiv({ cls: "setting-item-name" });
		infoEl.appendChild(nameEl);
		nameEl.appendChild(createSpan({ text: snippet.name }));
		if (this.shouldShowBadge(meta.group, Boolean(groupName))) {
			const badge = createSpan({
				cls: "cpm-group-badge",
				text: groupName,
			});
			nameEl.appendChild(badge);
			const color = this.store.settings.cssGroupColors[meta.group];
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
				this.store.saveCssMeta(snippet.baseName, { remark: value });
				this.applyFilters();
			},
		});

		const controlEl = createDiv({ cls: "setting-item-control" });
		rowEl.appendChild(controlEl);

		const toggle = new ToggleComponent(controlEl);
		toggle.setValue(snippet.enabled);
		toggle.onChange((enabled) => {
			void this.store.setSnippetEnabled(snippet.baseName, enabled);
		});

		const groupBtn = createEl("button", {
			cls: "cpm-group-btn",
			text: pickLang("manage.group.set"),
		});
		groupBtn.type = "button";
		groupBtn.addEventListener("click", (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			this.openGroupMenu(event, snippet.baseName, meta.group, rowEl);
		});
		controlEl.appendChild(groupBtn);

		new ExtraButtonComponent(controlEl)
			.setIcon("folder-open")
			.setTooltip(pickLang("manage.file.open"))
			.onClick(() => this.store.openSnippet(snippet.path));

		new ExtraButtonComponent(controlEl)
			.setIcon("pencil")
			.setTooltip(pickLang("manage.file.rename"))
			.onClick(() => this.requestRename(snippet.baseName));
	}

	private shouldShowBadge(groupKey: string, hasName: boolean): boolean {
		return hasName && groupKey !== GROUP_ALL && groupKey !== GROUP_OTHER;
	}

	// ── 筛选 ──

	private applyFilters(): void {
		if (!this.filterBar || !this.listEl) return;

		const state = this.filterBar.getState();
		const rows: Array<{ rowEl: HTMLElement; row: ManageRow }> = [];
		for (const rowEl of Array.from(
			this.listEl.querySelectorAll<HTMLElement>(".cpm-css-settings-row"),
		)) {
			const row = this.readRow(rowEl);
			if (row) rows.push({ rowEl, row });
		}

		for (const { rowEl, row } of rows) {
			rowEl.classList.toggle(FILTERED_CLASS, !matchesFilter(row, state));
		}

		this.filterBar.updateGroups(
			listGroups(this.store.settings.cssGroups),
			countByGroup(
				rows.map((r) => r.row),
				state,
			),
		);
		this.filterBar.setCount(rows.length, "个片段");
		this.persistFilter(state);
	}

	private readRow(rowEl: HTMLElement): ManageRow | null {
		const baseName = rowEl.dataset.cpmSnippet;
		if (!baseName) return null;
		const meta = getMeta(this.store.settings.cssMeta, baseName);
		return {
			id: baseName,
			name: baseName,
			author: "",
			remark: meta.remark,
			group: meta.group,
			enabled: Boolean(rowEl.querySelector(".checkbox-container.is-enabled")),
		};
	}

	private persistFilter(state: ManageFilterState): void {
		this.store.saveCssFilterState({
			keyword: state.keyword,
			group: state.group,
			status: state.status,
		});
	}

	// ── 分组菜单 ──

	private openGroupMenu(
		event: MouseEvent,
		baseName: string,
		currentGroup: string,
		rowEl: HTMLElement,
	): void {
		try {
			const menu = new Menu();
			for (const { key, name } of listGroups(this.store.settings.cssGroups)) {
				if (key === GROUP_ALL) continue;
				menu.addItem((item) =>
					item
						.setTitle(name)
						.setChecked(key === currentGroup)
						.onClick(() => {
							this.store.saveCssMeta(baseName, { group: key });
							this.refreshRow(rowEl, baseName);
							this.applyFilters();
						}),
				);
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(pickLang("manage.file.rename"))
					.setIcon("pencil")
					.onClick(() => this.requestRename(baseName)),
			);
			menu.showAtMouseEvent(event);
		} catch (error) {
			new Notice("打开分组菜单失败，详情见控制台日志");
		}
	}

	private refreshRow(rowEl: HTMLElement, baseName: string): void {
		const snippets = this.store.listSnippets();
		const snippet = snippets.find((s) => s.baseName === baseName);
		if (!snippet) {
			rowEl.remove();
			return;
		}
		rowEl.innerHTML = "";
		this.renderRow(snippet, rowEl);
	}

	// ── 空状态 ──

	private renderEmptyState(isEmpty: boolean): void {
		if (!this.rootEl) return;
		if (!isEmpty) {
			this.emptyEl?.remove();
			this.emptyEl = null;
			return;
		}
		if (this.emptyEl) return;
		this.emptyEl = createDiv({ cls: "cpm-css-empty-state" });
		this.rootEl.appendChild(this.emptyEl);
		this.emptyEl.textContent = pickLang("manage.css.empty.list");
	}

	// ── 重命名 ──

	private requestRename(baseName: string): void {
		const modal = new SnippetRenameModal(this.app, baseName, (newBase) => {
			void this.store.renameSnippet(baseName, newBase).then(() => this.refresh());
		});
		modal.open();
	}
}

/**
 * 插件设置页内的「CSS 片段管理」独立列表。
 *
 * 与原生外观页增强（SnippetListEnhancer）互补：当 Obsidian 版本把 CSS 片段
 * 收进带箭头的汇总行、不直接列出片段时，本列表保证用户在本插件设置页里
 * 始终能看到并管理片段（分组 / 备注 / 启用 / 重命名 / 打开文件），
 * 包括 vault 里没有任何 .css 文件的空状态。
 */

import { pickLang } from "@shared/i18n";
import { type ManageRow } from "@domain/manage/types";
import { listGroups } from "@domain/manage/group";
import { getMeta } from "@domain/manage/plugin-meta";
import {
	countByGroup,
	matchesFilter,
	type ManageFilterState,
} from "@domain/manage/manage-filter";
import { ManageFilterBar } from "./manage-filter-bar";
import { renderCssSnippetRow, type CssSnippetRowContext } from "./css-snippet-row";
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

	/** 数据变化后整体刷新（容器已随设置页重绘而离线时跳过） */
	refresh(): void {
		if (!this.rootEl?.isConnected) return;
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
		renderCssSnippetRow(rowEl, snippet, this.rowContext());
	}

	/** 行渲染器上下文：挂在一次渲染会话上，响应变化时委托回本组件 */
	private rowContext(): CssSnippetRowContext {
		return {
			store: this.store,
			onRowChange: (rowEl, baseName) => this.refreshRow(rowEl, baseName),
			onFilterChange: () => this.applyFilters(),
			requestRename: (baseName) => this.requestRename(baseName),
		};
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

	// ── 刷新单行 ──

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

/**
 * 增强 Obsidian 原生「设置 → 外观 → CSS 片段」列表。
 *
 * 与 PluginListEnhancer 对称：分组徽标 / 备注编辑器 / 分组菜单 / 筛选栏 / 计数。
 * 关键差异：
 * 1. 行 key 是 snippet 基名（文件名去 .css），而非插件 id；
 * 2. 启用状态来自行内 .checkbox-container.is-enabled（与 app.customCss 同步）；
 * 3. 行识别用平台 listSnippets 的已知基名集合过滤外观页 .setting-item，避免误伤
 *    主题 / 其他开关项（外观页无稳定的 snippet 行 data 属性）。
 */

import { Menu, Notice, setIcon } from "obsidian";
import { pickLang } from "@shared/i18n";
import { logger } from "@shared/logger";
import { GROUP_ALL, GROUP_OTHER, type ManageRow } from "@domain/manage/types";
import { listGroups } from "@domain/manage/group";
import { getMeta } from "@domain/manage/plugin-meta";
import { countByGroup, matchesFilter, type ManageFilterState } from "@domain/manage/manage-filter";
import { renderInlineNoteEditor } from "./inline-note-editor";
import { ManageFilterBar } from "./manage-filter-bar";
import type { CssStorePort } from "./snippet-manage-store";
import type { SnippetInfo } from "@data/platform/snippet";

const OWNED_ATTR = "data-cpm-owned";
const ROW_OWNER = "css-row";
const ENHANCED_ATTR = "data-cpm-css-enhanced";
const FILTERED_CLASS = "cpm-filtered-out";
const GROUP_BTN_ROLE = "cpm-css-group-btn";
const ROW_SELECTOR = ".setting-item";

/** 供 controller 传入的宿主能力 */
export interface SnippetEnhancerHost {
	onManageGroups: () => void;
	requestRenameSnippet: (baseName: string) => void;
}

/** 「其他」不显示为徽标 */
function shouldShowBadge(groupKey: string, hasName: boolean): boolean {
	return hasName && groupKey !== GROUP_ALL && groupKey !== GROUP_OTHER;
}

export class SnippetListEnhancer {
	private rootEl: HTMLElement | null = null;
	private filterBar: ManageFilterBar | null = null;
	private snippets: SnippetInfo[] = [];

	constructor(
		private readonly store: CssStorePort,
		private readonly host: SnippetEnhancerHost,
	) {}

	/** 增强给定根元素下的 CSS 片段列表；找不到目标结构则静默返回 */
	enhance(rootEl: HTMLElement): void {
		if (this.rootEl !== rootEl) {
			this.cleanup();
			this.rootEl = rootEl;
		}

		this.snippets = this.store.listSnippets();
		const known = new Set(this.snippets.map((s) => s.baseName));

		// 即便没有任何 CSS 片段也渲染工具栏与空状态，便于发现与管理
		const section = this.findSnippetSection(rootEl);
		const anchor = section ?? rootEl;
		this.ensureToolbar(anchor);
		const rows = this.getRows(rootEl, known);
		for (const { rowEl, baseName } of rows) this.enhanceRow(rowEl, baseName);
		this.applyFilters(rows.map((r) => r.rowEl));
		this.renderEmptyState(anchor, known.size === 0);
	}

	/** 移除全部注入内容，恢复原生页面 */
	cleanup(): void {
		const root = this.rootEl;
		if (root) {
			root.querySelectorAll<HTMLElement>(`[${OWNED_ATTR}]`).forEach((el) => el.remove());
			root
				.querySelectorAll<HTMLElement>(`.${FILTERED_CLASS}`)
				.forEach((el) => el.classList.remove(FILTERED_CLASS));
			root
				.querySelectorAll<HTMLElement>(`[${ENHANCED_ATTR}]`)
				.forEach((el) => el.removeAttribute(ENHANCED_ATTR));
		}
		this.rootEl = null;
		this.filterBar = null;
	}

	/** 分组数据变化后重画全部行 */
	refreshRows(): void {
		if (!this.rootEl) return;
		this.snippets = this.store.listSnippets();
		const known = new Set(this.snippets.map((s) => s.baseName));
		const rows = this.getRows(this.rootEl, known);
		for (const { rowEl, baseName } of rows) {
			this.removeRowEnhancement(rowEl);
			this.enhanceRow(rowEl, baseName);
		}
		this.applyFilters(rows.map((r) => r.rowEl));
	}

	// ── 行定位 ──

	private getRows(
		rootEl: HTMLElement,
		known: Set<string>,
	): Array<{ rowEl: HTMLElement; baseName: string }> {
		const result: Array<{ rowEl: HTMLElement; baseName: string }> = [];
		for (const el of Array.from(rootEl.querySelectorAll<HTMLElement>(ROW_SELECTOR))) {
			if (el.hasAttribute(ENHANCED_ATTR)) continue;
			// 已注入元素（如工具栏）跳过
			if (el.hasAttribute(OWNED_ATTR)) continue;
			const nameEl = el.querySelector<HTMLElement>(".setting-item-name");
			if (!nameEl) continue;
			const baseName = nameEl.textContent?.trim().replace(/\.css$/i, "") ?? "";
			if (!known.has(baseName)) continue;
			result.push({ rowEl: el, baseName });
		}
		return result;
	}

	// ── 工具栏 ──

	private ensureToolbar(anchorEl: HTMLElement): void {
		const existing = this.rootEl?.querySelector<HTMLElement>('[data-cpm-owned="css-toolbar"]');
		if (existing && this.filterBar?.containerEl.isConnected) return;

		if (!this.filterBar?.containerEl.isConnected) {
			this.filterBar = new ManageFilterBar({
				onChange: () => this.applyFilters(),
				onManageGroups: () => this.host.onManageGroups(),
			});
			this.filterBar.restore(this.store.settings.cssFilterState);
		}
		const toolbar = createDiv({ cls: "cpm-filter-bar cpm-css-toolbar" });
		toolbar.setAttribute(OWNED_ATTR, "css-toolbar");
		toolbar.appendChild(this.filterBar.containerEl);
		// 锚定到「CSS 代码片段」区块的 .setting-item-info 内（紧跟描述），
		// 保证工具栏与标题文字左对齐；找不到则退回标题后或根
		if (anchorEl === this.rootEl) {
			this.rootEl.appendChild(toolbar);
		} else {
			const infoEl = anchorEl.querySelector<HTMLElement>(".setting-item-info");
			if (infoEl) {
				infoEl.appendChild(toolbar);
			} else {
				anchorEl.parentElement?.insertBefore(toolbar, anchorEl.nextSibling);
			}
		}
	}

	/** 在外观页定位「CSS 代码片段」区块标题，把工具栏锚定到该区块 */
	private findSnippetSection(rootEl: HTMLElement): HTMLElement | null {
		for (const item of Array.from(
			rootEl.querySelectorAll<HTMLElement>(".setting-item, .setting-item-heading"),
		)) {
			const nameEl = item.querySelector<HTMLElement>(
				".setting-item-name, .setting-item-heading",
			);
			const name = nameEl?.textContent?.trim();
			if (name && /css/i.test(name)) return item;
		}
		return null;
	}

	/** 无 CSS 片段时显示空状态提示；一旦有片段则移除（若存在） */
	private renderEmptyState(anchorEl: HTMLElement, isEmpty: boolean): void {
		const root = this.rootEl;
		const existing = root?.querySelector<HTMLElement>('[data-cpm-owned="css-empty"]');
		if (!isEmpty) {
			existing?.remove();
			return;
		}
		if (existing) return;
		const el = createDiv({ cls: "cpm-css-empty-state" });
		el.setAttribute(OWNED_ATTR, "css-empty");
		el.textContent = pickLang("manage.css.empty.list");
		const toolbar = root?.querySelector<HTMLElement>('[data-cpm-owned="css-toolbar"]');
		if (toolbar?.parentElement) toolbar.parentElement.insertBefore(el, toolbar.nextSibling);
		else if (anchorEl === root) root?.appendChild(el);
		else anchorEl.parentElement?.insertBefore(el, anchorEl.nextSibling);
	}

	// ── 单行增强 ──

	private enhanceRow(rowEl: HTMLElement, baseName: string): void {
		const infoEl = rowEl.querySelector<HTMLElement>(".setting-item-info");
		const nameEl = rowEl.querySelector<HTMLElement>(".setting-item-name");
		const controlEl = rowEl.querySelector<HTMLElement>(".setting-item-control");
		if (!infoEl || !nameEl || !controlEl) return;

		const meta = getMeta(this.store.settings.cssMeta, baseName);
		if (
			rowEl.hasAttribute(ENHANCED_ATTR) &&
			this.isRowEnhancementComplete(rowEl, meta.group)
		) {
			return;
		}

		this.removeRowEnhancement(rowEl);
		rowEl.setAttribute(ENHANCED_ATTR, "true");
		rowEl.setAttribute("data-cpm-snippet", baseName);

		this.addGroupBadge(nameEl, meta.group);
		this.addRemarkEditor(infoEl, baseName, meta.remark);
		this.addGroupButton(controlEl, rowEl, baseName, meta.group);
		this.addOpenButton(controlEl, baseName);
	}

	private addGroupBadge(nameEl: HTMLElement, groupKey: string): void {
		const groupName = this.store.settings.cssGroups[groupKey];
		if (!shouldShowBadge(groupKey, Boolean(groupName))) return;

		const badge = createSpan({ cls: "cpm-group-badge", text: groupName });
		badge.setAttribute(OWNED_ATTR, ROW_OWNER);
		const color = this.store.settings.cssGroupColors[groupKey];
		if (color) badge.setCssProps({ "--cpm-group-color": color });
		nameEl.appendChild(badge);
	}

	private addRemarkEditor(infoEl: HTMLElement, id: string, remark: string): void {
		const wrapper = createDiv({ cls: "setting-item-description cpm-note-field" });
		wrapper.setAttribute(OWNED_ATTR, ROW_OWNER);
		infoEl.appendChild(wrapper);
		renderInlineNoteEditor(wrapper, {
			value: remark,
			placeholder: pickLang("manage.note.ph"),
			emptyText: pickLang("manage.note.empty"),
			onSave: (value) => {
				this.store.saveCssMeta(id, { remark: value });
				this.applyFilters();
			},
		});
	}

	private addGroupButton(
		controlEl: HTMLElement,
		rowEl: HTMLElement,
		id: string,
		currentGroup: string,
	): void {
		const button = createEl("button", {
			cls: "cpm-group-btn",
			text: pickLang("manage.group.set"),
		});
		button.type = "button";
		button.setAttribute(OWNED_ATTR, ROW_OWNER);
		button.setAttribute("data-role", GROUP_BTN_ROLE);
		button.addEventListener("click", (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			this.openGroupMenu(event, rowEl, id, currentGroup);
		});
		const firstNativeButton = Array.from(controlEl.children).find(
			(el) => el.tagName === "BUTTON" && !el.hasAttribute(OWNED_ATTR),
		);
		if (firstNativeButton) firstNativeButton.after(button);
		else controlEl.prepend(button);
	}

	private addOpenButton(controlEl: HTMLElement, baseName: string): void {
		const snippet = this.snippets.find((s) => s.baseName === baseName);
		if (!snippet) return;
		const button = createEl("button", { cls: "cpm-open-btn" });
		button.type = "button";
		setIcon(button, "folder-open");
		button.setAttribute("aria-label", pickLang("manage.file.open"));
		button.setAttribute("title", pickLang("manage.file.open"));
		button.setAttribute(OWNED_ATTR, ROW_OWNER);
		button.addEventListener("click", (event: MouseEvent) => {
			event.preventDefault();
			event.stopPropagation();
			try {
				this.store.openSnippet(snippet.path);
			} catch (error) {
				logger.warn("[Chinese Plugin Market] 打开 CSS 片段文件失败：", error);
				new Notice(pickLang("manage.file.open.fail"));
			}
		});
		controlEl.prepend(button);
	}

	private isRowEnhancementComplete(rowEl: HTMLElement, groupKey: string): boolean {
		const hasNote = Boolean(
			rowEl.querySelector(`.cpm-note-field[${OWNED_ATTR}="${ROW_OWNER}"]`),
		);
		const hasButton = Boolean(
			rowEl.querySelector(`[${OWNED_ATTR}="${ROW_OWNER}"][data-role="${GROUP_BTN_ROLE}"]`),
		);
		const needsBadge = shouldShowBadge(
			groupKey,
			Boolean(this.store.settings.cssGroups[groupKey]),
		);
		const hasBadge = Boolean(rowEl.querySelector(`.cpm-group-badge[${OWNED_ATTR}]`));
		return hasNote && hasButton && hasBadge === needsBadge;
	}

	private removeRowEnhancement(rowEl: HTMLElement): void {
		rowEl
			.querySelectorAll<HTMLElement>(`[${OWNED_ATTR}="${ROW_OWNER}"]`)
			.forEach((el) => el.remove());
		rowEl.removeAttribute(ENHANCED_ATTR);
		rowEl.removeAttribute("data-cpm-snippet");
	}

	// ── 筛选 ──

	private applyFilters(rows?: HTMLElement[]): void {
		if (!this.rootEl || !this.filterBar) return;

		// 无参重筛时，直接查已识别（带 data-cpm-snippet）的行；
		// 不能走 getRows，否则已增强行会被 ENHANCED_ATTR 过滤掉，导致筛选失效。
		const targetRows =
			rows ??
			Array.from(this.rootEl.querySelectorAll<HTMLElement>(ROW_SELECTOR)).filter(
				(el) => el.getAttribute("data-cpm-snippet") !== null,
			);
		const collected: ManageRow[] = [];
		for (const rowEl of targetRows) {
			const row = this.readRow(rowEl);
			if (row) collected.push(row);
		}

		const state = this.filterBar.getState();
		const rowById = new Map(collected.map((row) => [row.id, row]));
		for (const rowEl of targetRows) {
			const id = rowEl.dataset.cpmSnippet ?? "";
			const row = rowById.get(id);
			const visible = row ? matchesFilter(row, state) : true;
			rowEl.classList.toggle(FILTERED_CLASS, !visible);
		}

		this.filterBar.updateGroups(
			listGroups(this.store.settings.cssGroups),
			countByGroup(collected, state),
		);
		this.filterBar.setCount(collected.length, "个片段");
		this.persistFilter(state);
	}

	/** 从行 DOM 抽取可计算的数据 */
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

	/** 筛选状态变化即落盘 */
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
		rowEl: HTMLElement,
		id: string,
		currentGroup: string,
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
							this.store.saveCssMeta(id, { group: key });
							this.removeRowEnhancement(rowEl);
							this.enhanceRow(rowEl, id);
							this.applyFilters();
						})
				);
			}
			menu.addSeparator();
			menu.addItem((item) =>
				item
					.setTitle(pickLang("manage.file.rename"))
					.setIcon("pencil")
					.onClick(() => this.host.requestRenameSnippet(id))
			);
			menu.showAtMouseEvent(event);
		} catch (error) {
			logger.warn("[Chinese Plugin Market] 打开 CSS 分组菜单失败：", error);
			new Notice("打开分组菜单失败，详情见控制台日志");
		}
	}
}

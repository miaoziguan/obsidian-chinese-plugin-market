/**
 * 增强 Obsidian 原生「设置 → 社区插件 → 已安装插件」列表。
 *
 * 设计要点（照搬参考实现教训，缺一必踩坑）：
 * 1. 幂等增强：设置页会频繁重绘，行元素随时被重建。每次 enhance 都先
 *    用 isRowEnhancementComplete 判断「徽标/按钮/备注是否与当前数据一致」，
 *    一致则跳过，避免无脑重注入导致的闪烁与监听器泄漏。
 * 2. 归属标记：所有注入元素打 data-cpm-owned，cleanup 时整块移除；
 *    读取插件名时排除这些元素，避免徽标文字污染名称。
 * 3. 元素创建走 Obsidian 全局 createEl/createDiv/createSpan，动态样式走
 *    setCssProps（符合插件规范，且测试环境由 test/setup.ts 补齐，可单测）。
 */

import { Menu, Notice } from "obsidian";
import { pickLang } from "@shared/i18n";
import { logger } from "@shared/logger";
import { GROUP_ALL, GROUP_OTHER, type ManageRow } from "@domain/manage/types";
import { listGroups } from "@domain/manage/group";
import { getMeta } from "@domain/manage/plugin-meta";
import { countByGroup, matchesFilter, type ManageFilterState } from "@domain/manage/manage-filter";
import { renderInlineNoteEditor } from "./inline-note-editor";
import { ManageFilterBar } from "./manage-filter-bar";
import type { ManageStorePort } from "./manage-store";

const OWNED_ATTR = "data-cpm-owned";
const ROW_OWNER = "plugin-row";
const ENHANCED_ATTR = "data-cpm-enhanced";
const FILTERED_CLASS = "cpm-filtered-out";
const GROUP_BTN_ROLE = "cpm-group-btn";

const LIST_GROUP_SELECTOR = ".setting-group.mod-list";
const ROW_SELECTOR = ".setting-items > .setting-item[data-plugin-id]";

/** 供 controller 传入的宿主能力（避免 ui 反向依赖 app） */
export interface EnhancerHost {
	/** 打开分组管理界面（由 app 层实现，通常是定位到本插件设置页） */
	onManageGroups: () => void;
}

/** 「其他」是未分组条目的兜底归属，不显示为徽标，否则每行都挂一个「其他」纯属噪音 */
function shouldShowBadge(groupKey: string, hasName: boolean): boolean {
	return hasName && groupKey !== GROUP_ALL && groupKey !== GROUP_OTHER;
}

export class PluginListEnhancer {
	private rootEl: HTMLElement | null = null;
	private listGroupEl: HTMLElement | null = null;
	private filterBar: ManageFilterBar | null = null;

	constructor(
		private readonly store: ManageStorePort,
		private readonly host: EnhancerHost,
	) {}

	/** 增强给定根元素下的已安装插件列表；找不到目标结构则静默返回 */
	enhance(rootEl: HTMLElement): void {
		if (this.rootEl !== rootEl) {
			this.cleanup();
			this.rootEl = rootEl;
		}

		const listGroupEl = this.findInstalledListGroup(rootEl);
		if (!listGroupEl) return;

		if (this.listGroupEl !== listGroupEl) {
			this.listGroupEl = listGroupEl;
			this.filterBar = null;
		}

		this.ensureToolbar(listGroupEl);
		const rows = this.getRows(listGroupEl);
		for (const rowEl of rows) this.enhanceRow(rowEl);
		this.applyFilters(rows);
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
		this.listGroupEl = null;
		this.filterBar = null;
	}

	/** 分组数据变化后重画全部行（分组管理界面改动时调用） */
	refreshRows(): void {
		if (!this.listGroupEl) return;
		const rows = this.getRows(this.listGroupEl);
		for (const rowEl of rows) {
			this.removeRowEnhancement(rowEl);
			this.enhanceRow(rowEl);
		}
		this.applyFilters(rows);
	}

	// ── 定位 ──

	private findInstalledListGroup(rootEl: HTMLElement): HTMLElement | null {
		const groups = Array.from(
			rootEl.querySelectorAll<HTMLElement>(LIST_GROUP_SELECTOR)
		).filter(
			(el) =>
				el.querySelector(".setting-group-search") && el.querySelector(".setting-items")
		);
		return groups[groups.length - 1] ?? null;
	}

	private getRows(listGroupEl: HTMLElement): HTMLElement[] {
		return Array.from(listGroupEl.querySelectorAll<HTMLElement>(ROW_SELECTOR));
	}

	// ── 工具栏 ──

	private ensureToolbar(listGroupEl: HTMLElement): void {
		const headerControlEl = listGroupEl.querySelector<HTMLElement>(
			":scope > .setting-item.setting-item-heading > .setting-item-control"
		);
		if (!headerControlEl) return;

		if (!this.filterBar?.containerEl.isConnected) {
			this.filterBar = new ManageFilterBar({
				onChange: () => this.applyFilters(),
				onManageGroups: () => this.host.onManageGroups(),
			});
			// 恢复现场：重建筛选栏时套用上次保存的搜索词 / 分组 / 状态
			this.filterBar.restore(this.store.settings.filterState);
		}
		this.filterBar.mount(headerControlEl);
	}

	// ── 单行增强 ──

	private enhanceRow(rowEl: HTMLElement): void {
		const id = rowEl.dataset.pluginId;
		const infoEl = rowEl.querySelector<HTMLElement>(".setting-item-info");
		const nameEl = rowEl.querySelector<HTMLElement>(".setting-item-name");
		const controlEl = rowEl.querySelector<HTMLElement>(".setting-item-control");
		if (!id || !infoEl || !nameEl || !controlEl) return;

		const meta = getMeta(this.store.settings.pluginMeta, id);
		if (
			rowEl.hasAttribute(ENHANCED_ATTR) &&
			this.isRowEnhancementComplete(rowEl, meta.group)
		) {
			return;
		}

		this.removeRowEnhancement(rowEl);
		rowEl.setAttribute(ENHANCED_ATTR, "true");

		this.addGroupBadge(nameEl, meta.group);
		this.addRemarkEditor(infoEl, id, meta.remark);
		this.addGroupButton(controlEl, rowEl, id, meta.group);
	}

	private addGroupBadge(nameEl: HTMLElement, groupKey: string): void {
		const groupName = this.store.settings.pluginGroups[groupKey];
		if (!shouldShowBadge(groupKey, Boolean(groupName))) return;

		const badge = createSpan({ cls: "cpm-group-badge", text: groupName });
		badge.setAttribute(OWNED_ATTR, ROW_OWNER);
		const color = this.store.settings.pluginGroupColors[groupKey];
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
				this.store.saveMeta(id, { remark: value });
				this.applyFilters();
			},
		});
	}

	private addGroupButton(
		controlEl: HTMLElement,
		rowEl: HTMLElement,
		id: string,
		currentGroup: string
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
		// 放在首个原生按钮之后（通常是「更新」），没有则置顶
		const firstNativeButton = Array.from(controlEl.children).find(
			(el) => el.tagName === "BUTTON" && !el.hasAttribute(OWNED_ATTR)
		);
		if (firstNativeButton) firstNativeButton.after(button);
		else controlEl.prepend(button);
	}

	private isRowEnhancementComplete(rowEl: HTMLElement, groupKey: string): boolean {
		const hasNote = Boolean(
			rowEl.querySelector(`.cpm-note-field[${OWNED_ATTR}="${ROW_OWNER}"]`)
		);
		const hasButton = Boolean(
			rowEl.querySelector(`[${OWNED_ATTR}="${ROW_OWNER}"][data-role="${GROUP_BTN_ROLE}"]`)
		);
		const needsBadge = shouldShowBadge(
			groupKey,
			Boolean(this.store.settings.pluginGroups[groupKey])
		);
		const hasBadge = Boolean(rowEl.querySelector(`.cpm-group-badge[${OWNED_ATTR}]`));
		return hasNote && hasButton && hasBadge === needsBadge;
	}

	private removeRowEnhancement(rowEl: HTMLElement): void {
		rowEl
			.querySelectorAll<HTMLElement>(`[${OWNED_ATTR}="${ROW_OWNER}"]`)
			.forEach((el) => el.remove());
		rowEl.removeAttribute(ENHANCED_ATTR);
	}

	// ── 筛选 ──

	private applyFilters(rows?: HTMLElement[]): void {
		if (!this.listGroupEl || !this.filterBar) return;

		const targetRows = rows ?? this.getRows(this.listGroupEl);
		const collected: ManageRow[] = [];
		for (const rowEl of targetRows) {
			const row = this.readRow(rowEl);
			if (row) collected.push(row);
		}

		const state = this.filterBar.getState();
		const rowById = new Map(collected.map((row) => [row.id, row]));
		for (const rowEl of targetRows) {
			const id = rowEl.dataset.pluginId ?? "";
			const row = rowById.get(id);
			const visible = row ? matchesFilter(row, state) : true;
			rowEl.classList.toggle(FILTERED_CLASS, !visible);
		}

		this.filterBar.updateGroups(
			listGroups(this.store.settings.pluginGroups),
			countByGroup(collected, state)
		);
		this.filterBar.setCount(collected.length);
		this.persistFilter(state);
	}

	/** 筛选状态变化即落盘（flushSaveSettings 内部防抖，不阻塞输入） */
	private persistFilter(state: ManageFilterState): void {
		this.store.saveFilterState({
			keyword: state.keyword,
			group: state.group,
			status: state.status,
		});
	}

	/** 从行 DOM 抽取可计算的数据（剔除本插件注入元素，避免徽标污染名称） */
	private readRow(rowEl: HTMLElement): ManageRow | null {
		const id = rowEl.dataset.pluginId;
		if (!id) return null;
		const meta = getMeta(this.store.settings.pluginMeta, id);
		return {
			id,
			name: this.plainText(rowEl.querySelector<HTMLElement>(".setting-item-name")),
			// 原生描述里含作者与版本，作为附加可搜文本参与关键词匹配
			author: this.plainText(rowEl.querySelector<HTMLElement>(".setting-item-description")),
			remark: meta.remark,
			group: meta.group,
			enabled: Boolean(rowEl.querySelector(".checkbox-container.is-enabled")),
		};
	}

	private plainText(el: HTMLElement | null): string {
		if (!el) return "";
		const clone = el.cloneNode(true) as HTMLElement;
		clone.querySelectorAll(`[${OWNED_ATTR}]`).forEach((node) => node.remove());
		return (clone.textContent ?? "").trim();
	}

	// ── 分组菜单 ──

	/**
	 * 用 Obsidian 官方 Menu，而不是自绘浮层。
	 *
	 * 自绘方案需要自己处理定位、层级与「点击外部关闭」，而这三点在设置面板
	 * 这种高层级弹层里极易出错（菜单被遮在面板下方、或定位计算失效），
	 * 且这类问题无法在 jsdom 单测中暴露——实测才看得见。
	 * 官方 Menu 由 Obsidian 统一处理上述行为，视觉也与原生日历/右键菜单一致。
	 * 失败只 warn，绝不抛给原生事件链。
	 */
	private openGroupMenu(
		event: MouseEvent,
		rowEl: HTMLElement,
		id: string,
		currentGroup: string
	): void {
		try {
			const menu = new Menu();
			for (const { key, name } of listGroups(this.store.settings.pluginGroups)) {
				if (key === GROUP_ALL) continue;
				menu.addItem((item) =>
					item
						.setTitle(name)
						.setChecked(key === currentGroup)
						.onClick(() => {
							this.store.saveMeta(id, { group: key });
							this.removeRowEnhancement(rowEl);
							this.enhanceRow(rowEl);
							this.applyFilters();
						})
				);
			}
			menu.showAtMouseEvent(event);
		} catch (error) {
			// 可见提示：避免「点了没反应」这种无法归因的静默失败
			logger.warn("[Chinese Plugin Market] 打开分组菜单失败：", error);
			new Notice("打开分组菜单失败，详情见控制台日志");
		}
	}
}

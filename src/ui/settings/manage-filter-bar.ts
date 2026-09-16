/**
 * 注入到原生「已安装插件」标题栏的筛选栏：搜索框 + 分组下拉 + 状态下拉 + 计数 + 管理按钮。
 *
 * 全部使用 Obsidian 原生组件（DropdownComponent / ExtraButtonComponent）与全局
 * createEl，既符合插件规范（obsidianmd/prefer-create-el），也在 jsdom 测试里有 mock 兜底。
 */

import { DropdownComponent, ExtraButtonComponent } from "obsidian";
import { pickLang } from "@shared/i18n";
import { GROUP_ALL, type ManageFilterStatus } from "@domain/manage/types";
import type { ManageFilterState } from "@domain/manage/manage-filter";

export interface FilterBarOptions {
	/** 筛选条件变化（不含「管理分组」按钮） */
	onChange: () => void;
	/** 点击管理分组 */
	onManageGroups: () => void;
}

export class ManageFilterBar {
	readonly containerEl: HTMLElement;
	private readonly keywordInput: HTMLInputElement;
	private readonly groupDropdown: DropdownComponent;
	private readonly statusDropdown: DropdownComponent;
	private readonly countEl: HTMLElement;
	private status: ManageFilterStatus = "all";
	private initialGroup = GROUP_ALL;
	private mountedTo: HTMLElement | null = null;

	constructor(private readonly options: FilterBarOptions) {
		this.containerEl = createDiv({ cls: "cpm-filter-bar" });
		this.containerEl.setAttribute("data-cpm-owned", "filter-bar");

		this.keywordInput = createEl("input", { cls: "cpm-filter-keyword" });
		this.keywordInput.type = "search";
		this.keywordInput.placeholder = pickLang("manage.filter.keyword.ph");
		this.keywordInput.addEventListener("input", () => this.options.onChange());
		this.containerEl.appendChild(this.keywordInput);

		// 分组下拉：原生 DropdownComponent，视觉与原生设置项一致
		this.groupDropdown = new DropdownComponent(this.containerEl);
		this.groupDropdown.selectEl.addClass("cpm-filter-group");
		this.groupDropdown.onChange(() => this.options.onChange());

		// 状态筛选：同样是原生下拉（参考实现形态），而非自绘循环按钮
		this.statusDropdown = new DropdownComponent(this.containerEl);
		this.statusDropdown.selectEl.addClass("cpm-filter-status");
		this.statusDropdown
			.addOption("all", pickLang("manage.filter.status.all"))
			.addOption("enabled", pickLang("manage.filter.status.enabled"))
			.addOption("disabled", pickLang("manage.filter.status.disabled"));
		this.statusDropdown.onChange((value) => {
			this.status = value as ManageFilterStatus;
			this.options.onChange();
		});

		// 独立计数文本：aria-live，筛选变化时读屏可感知「剩 N 个」
		this.countEl = createSpan({ cls: "cpm-filter-count" });
		this.countEl.setAttribute("aria-live", "polite");
		this.containerEl.appendChild(this.countEl);

		// 管理分组：图标按钮（tags），tooltip 替代文字
		const manageBtn = new ExtraButtonComponent(this.containerEl);
		manageBtn
			.setIcon("tags")
			.setTooltip(pickLang("manage.filter.manageGroups"))
			.onClick(() => this.options.onManageGroups());
	}

	/** 挂载到目标容器（幂等：已挂载则跳过） */
	mount(parent: HTMLElement): void {
		if (this.mountedTo === parent && this.containerEl.isConnected) return;
		parent.appendChild(this.containerEl);
		this.mountedTo = parent;
	}

	getState(): ManageFilterState {
		return {
			keyword: this.keywordInput.value,
			group: this.groupDropdown.getValue() || GROUP_ALL,
			status: this.status,
		};
	}

	/** 刷新分组下拉（含各分组命中数），尽量保留当前选择 */
	updateGroups(
		groups: Array<{ key: string; name: string }>,
		counts: Record<string, number>,
	): void {
		const previous = this.groupDropdown.getValue();
		this.groupDropdown.selectEl.textContent = "";
		for (const { key, name } of groups) {
			const count = counts[key] ?? 0;
			this.groupDropdown.addOption(key, `${name}（${count}）`);
		}
		const stillExists = groups.some((g) => g.key === previous);
		const target = stillExists ? previous : this.initialGroup;
		this.groupDropdown.setValue(target);
	}

	/** 更新「N 个插件」计数（已装插件总数） */
	setCount(total: number): void {
		this.countEl.textContent = total > 0 ? `${total} 个插件` : "";
	}

	/** 恢复筛选现场（搜索词 / 分组 / 状态），由宿主在重建筛选栏时调用 */
	restore(state: ManageFilterState): void {
		this.keywordInput.value = state.keyword ?? "";
		this.status = state.status ?? "all";
		this.statusDropdown.setValue(this.status);
		this.initialGroup = state.group ?? GROUP_ALL;
		// dropdown 若已填充选项（重建前已挂载），立即套用恢复的分组；
		// 否则留给首次 updateGroups 在填充选项后按 initialGroup 选中
		if (this.groupDropdown.selectEl.querySelector(`option[value="${this.initialGroup}"]`)) {
			this.groupDropdown.setValue(this.initialGroup);
		}
	}
}

/**
 * 注入到原生「已安装插件」标题栏的筛选栏：搜索框 + 分组下拉 + 启用状态切换。
 *
 * 元素创建统一走 Obsidian 的全局 createEl / createDiv，符合插件规范
 * （obsidianmd/prefer-create-el），且测试环境已由 test/setup.ts 补齐。
 */

import { pickLang } from "@shared/i18n";
import { GROUP_ALL, type ManageFilterStatus } from "@domain/manage/types";
import type { ManageFilterState } from "@domain/manage/manage-filter";

export interface FilterBarOptions {
	/** 筛选条件变化（不含「管理分组」按钮） */
	onChange: () => void;
	/** 点击「管理分组」 */
	onManageGroups: () => void;
}

const STATUS_CYCLE: ManageFilterStatus[] = ["all", "enabled", "disabled"];

export class ManageFilterBar {
	readonly containerEl: HTMLElement;
	private readonly keywordInput: HTMLInputElement;
	private readonly groupSelect: HTMLSelectElement;
	private readonly statusButton: HTMLButtonElement;
	private status: ManageFilterStatus = "all";
	private mountedTo: HTMLElement | null = null;

	constructor(private readonly options: FilterBarOptions) {
		this.containerEl = createDiv({ cls: "cpm-filter-bar" });
		this.containerEl.setAttribute("data-cpm-owned", "filter-bar");

		this.keywordInput = createEl("input", { cls: "cpm-filter-keyword" });
		this.keywordInput.type = "search";
		this.keywordInput.placeholder = pickLang("manage.filter.keyword.ph");
		this.keywordInput.addEventListener("input", () => this.options.onChange());

		this.groupSelect = createEl("select", { cls: "cpm-filter-group" });
		this.groupSelect.addEventListener("change", () => this.options.onChange());

		this.statusButton = createEl("button", { cls: "cpm-filter-status" });
		this.statusButton.type = "button";
		this.statusButton.addEventListener("click", () => {
			const next =
				STATUS_CYCLE[(STATUS_CYCLE.indexOf(this.status) + 1) % STATUS_CYCLE.length];
			this.status = next;
			this.paintStatus();
			this.options.onChange();
		});

		const manageButton = createEl("button", {
			cls: "cpm-filter-manage",
			text: pickLang("manage.filter.manageGroups"),
		});
		manageButton.type = "button";
		manageButton.addEventListener("click", () => this.options.onManageGroups());

		this.containerEl.appendChild(this.keywordInput);
		this.containerEl.appendChild(this.groupSelect);
		this.containerEl.appendChild(this.statusButton);
		this.containerEl.appendChild(manageButton);
		this.paintStatus();
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
			group: this.groupSelect.value || GROUP_ALL,
			status: this.status,
		};
	}

	/** 刷新分组下拉（含各分组命中数），尽量保留当前选择 */
	updateGroups(
		groups: Array<{ key: string; name: string }>,
		counts: Record<string, number>,
	): void {
		const previous = this.groupSelect.value;
		this.groupSelect.textContent = "";
		for (const { key, name } of groups) {
			const count = counts[key] ?? 0;
			const option = createEl("option");
			option.value = key;
			option.textContent = `${name}（${count}）`;
			this.groupSelect.appendChild(option);
		}
		const stillExists = groups.some((g) => g.key === previous);
		this.groupSelect.value = stillExists ? previous : GROUP_ALL;
	}

	private paintStatus(): void {
		const label: Record<ManageFilterStatus, string> = {
			all: pickLang("manage.filter.status.all"),
			enabled: pickLang("manage.filter.status.enabled"),
			disabled: pickLang("manage.filter.status.disabled"),
		};
		this.statusButton.textContent = label[this.status];
		this.statusButton.setAttribute("data-status", this.status);
	}
}

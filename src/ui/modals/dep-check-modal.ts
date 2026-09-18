/**
 * 安装完成后的依赖检查弹窗。
 *
 * 为什么是 Modal 而不是 Notice：Obsidian 的 Notice 不可点击，承载不了「一键安装」。
 * 而这正是本功能的核心价值——装完就能立刻补上缺失依赖，让插件跑起来。
 *
 * 只在「有必需依赖没到位」时才弹；依赖都齐了则一声不响（不额外打扰）。
 */

import { App, Modal, Setting } from "obsidian";
import type { TFunc } from "@shared/i18n";
import type { DepStatus } from "@domain/deps/types";

export interface DepCheckItem {
	/** 依赖插件 id（用于 onFix 回调） */
	id: string;
	name: string;
	status: DepStatus;
	/** 缺失→安装 / 已装未启用→启用 / 版本过低→更新；ok/unknown 不提供动作 */
	action: "install" | "enable" | "update" | null;
}

export interface DepCheckOptions {
	app: App;
	pluginName: string;
	items: DepCheckItem[];
	t: TFunc;
	/** 点某条的处理按钮：安装 / 启用 / 更新 */
	onFix: (item: DepCheckItem) => void;
}

const STATUS_LABEL: Record<Exclude<DepStatus, "ok">, { key: Parameters<TFunc>[0]; action: Exclude<DepCheckItem["action"], null> }> = {
	missing: { key: "dep.status.missing", action: "install" },
	disabled: { key: "dep.status.disabled", action: "enable" },
	outdated: { key: "dep.status.outdated", action: "update" },
	unknown: { key: "dep.status.unknown", action: "install" },
};

const ACTION_LABEL: Record<NonNullable<DepCheckItem["action"]>, Parameters<TFunc>[0]> = {
	install: "dep.action.install",
	enable: "dep.action.enable",
	update: "dep.action.update",
};

export class DepCheckModal extends Modal {
	private opts: DepCheckOptions;

	constructor(opts: DepCheckOptions) {
		super(opts.app);
		this.opts = opts;
	}

	onOpen(): void {
		const { contentEl, opts } = this;
		contentEl.empty();
		contentEl.addClass("pt-dep-check-modal");
		contentEl.createEl("h3", { text: opts.t("dep.modal.title", { name: opts.pluginName }) });
		contentEl.createEl("p", {
			cls: "pt-dep-check-desc",
			text: opts.t("dep.modal.desc", { name: opts.pluginName }),
		});

		for (const item of opts.items) {
			if (!item.action) continue; // unknown 等无法处理的不显示行
			// 到这里的 item 状态只可能是 missing/disabled/outdated（ok 与 unknown 无 action 已跳过）
			const meta = STATUS_LABEL[item.status as Exclude<DepStatus, "ok">];
			new Setting(contentEl)
				.setName(item.name)
				.setDesc(opts.t(meta.key))
				.addButton((btn) =>
					btn.setButtonText(opts.t(ACTION_LABEL[item.action as NonNullable<DepCheckItem["action"]>])).setCta().onClick(() => {
						opts.onFix(item);
						btn.setDisabled(true);
					}),
				);
		}

		new Setting(contentEl).addButton((btn) =>
			btn.setButtonText(opts.t("dep.modal.dismiss")).onClick(() => this.close()),
		);
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

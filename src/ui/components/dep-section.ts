/**
 * 详情抽屉里的「依赖 / 被依赖」区块渲染。
 *
 * 只做 DOM 与回调，不碰 ViewContext 也不碰 Obsidian 状态：状态判定、可跳转性、
 * 安装/启用动作全部由宿主以端口传入（与 DrawerHostPlugin 的解耦风格一致）。
 */

import { setIcon } from "obsidian";
import type { I18nKey } from "@shared/i18n";
import type { DepEdge, DepStatus, DependentRef } from "@domain/deps/types";

export type DepFixAction = "install" | "enable" | "update";

export interface DepSectionHost {
	t: (k: I18nKey, vars?: Record<string, string>) => string;
	statusOf: (dep: DepEdge) => DepStatus;
	/** 依赖目标能否点开（在官方列表里才有详情页） */
	canOpen: (depId: string) => boolean;
	/** 展示名解析（被依赖方在数据文件里只存了 id） */
	nameOf: (pluginId: string) => string;
	onOpen: (depId: string) => void;
	onFix: (depId: string, action: DepFixAction) => void;
}

const STATUS_KEY: Record<DepStatus, I18nKey> = {
	ok: "dep.status.ok",
	missing: "dep.status.missing",
	disabled: "dep.status.disabled",
	outdated: "dep.status.outdated",
	unknown: "dep.status.unknown",
};

const ACTION_KEY: Record<DepFixAction, I18nKey> = {
	install: "dep.action.install",
	enable: "dep.action.enable",
	update: "dep.action.update",
};

/**
 * 未满足状态下给什么动作：
 * - missing → 安装；disabled → 启用；outdated → 更新
 * - ok / unknown 不给按钮（unknown 是直链安装等不在官方列表的情况，无从下手）
 */
function actionOf(status: DepStatus): DepFixAction | null {
	if (status === "missing") return "install";
	if (status === "disabled") return "enable";
	if (status === "outdated") return "update";
	return null;
}

export function renderDepSection(parent: HTMLElement, deps: DepEdge[], host: DepSectionHost): void {
	const list = parent.createDiv({ cls: "pt-detail-dep-list" });
	for (const dep of deps) {
		const status = host.statusOf(dep);
		const row = list.createDiv({ cls: `pt-detail-dep-row is-${status}` });

		const dot = row.createSpan({ cls: "pt-detail-dep-dot" });
		setIcon(dot, status === "ok" ? "check-circle" : "alert-circle");

		const name = row.createSpan({ cls: "pt-detail-dep-name", text: dep.name || dep.id });
		if (host.canOpen(dep.id)) {
			name.addClass("is-link");
			name.setAttribute("title", host.t("dep.section"));
			name.addEventListener("click", () => host.onOpen(dep.id));
		}

		row.createSpan({
			cls: "pt-detail-dep-kind",
			text: host.t(dep.kind === "required" ? "dep.required" : "dep.optional"),
		});
		if (dep.minVersion) {
			row.createSpan({ cls: "pt-detail-dep-ver", text: host.t("dep.minVersion", { v: dep.minVersion }) });
		}
		// 非精修 / 非代码证据（confidence < 0.85）标「可能」，避免把推断当结论
		if (dep.confidence < 0.85) {
			row.createSpan({ cls: "pt-detail-dep-maybe", text: host.t("dep.maybe") });
		}
		row.createSpan({ cls: "pt-detail-dep-status", text: host.t(STATUS_KEY[status]) });

		const action = actionOf(status);
		if (action) {
			const btn = row.createEl("button", {
				cls: "pt-detail-dep-fix",
				attr: { type: "button" },
				text: host.t(ACTION_KEY[action]),
			});
			btn.addEventListener("click", () => host.onFix(dep.id, action));
		}
	}
}

/** 「被依赖」折叠区：默认收起，避免正常浏览时被一堆名字干扰 */
export function renderDependentsSection(
	parent: HTMLElement,
	deps: DependentRef[],
	host: Pick<DepSectionHost, "t" | "canOpen" | "nameOf" | "onOpen">,
): void {
	const box = parent.createEl("details", { cls: "pt-detail-dependents" });
	box.createEl("summary", { text: host.t("dep.dependents", { n: String(deps.length) }) });
	box.createDiv({ cls: "pt-detail-dependents-hint", text: host.t("dep.dependents.hint") });
	const wrap = box.createDiv({ cls: "pt-detail-dependents-list" });
	for (const d of deps) {
		const chip = wrap.createSpan({ cls: "pt-detail-dependent-chip", text: host.nameOf(d.id) });
		if (host.canOpen(d.id)) {
			chip.addClass("is-link");
			chip.addEventListener("click", () => host.onOpen(d.id));
		}
	}
}

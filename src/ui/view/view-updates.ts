/**
 * 「更新」页签列表渲染器。
 *
 * 主视图顶部的「更新」页签切到本视图时，调用 renderUpdatesList 在
 * ctx.updatesListEl 中渲染：可更新插件的「名称 + 本地→最新版本差 + 勾选框」，
 * 顶部带「检查更新 / 全选 / 取消全选 / 更新所选(N) / 全部更新」工具条，
 * 底部为逐行更新按钮。多选 + 一键全更直接复用 ctx.updateSelected / ctx.updateAll。
 */

import { Notice, setIcon } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";
import { refreshOutdated } from "@ui/view/view-data";

export function renderUpdatesList(ctx: ViewContext): void {
	const el = ctx.updatesListEl;
	if (!el) return;
	const t = ctx.t;
	el.empty();

	const outdated = [...(ctx.outdatedIds ?? [])];

	// ── 顶部工具条 ──
	const bar = el.createDiv({ cls: "pt-updates-bar" });
	const count = bar.createSpan({
		cls: "pt-updates-count",
		text: t("updates.count", { n: String(ctx.updateSelection.size), m: String(outdated.length) }),
	});

	const checkBtn = bar.createEl("button", {
		cls: "pt-updates-checkbtn clickable-icon",
		attr: { "aria-label": t("action.checkUpdate"), title: t("action.checkUpdate"), type: "button" },
	});
	setIcon(checkBtn, "download-cloud");
	checkBtn.addEventListener("click", () => {
		checkBtn.addClass("pt-spin");
		void refreshOutdated(ctx)
			.then(() => {
				ctx.refreshViewTabsBadge?.();
				const n = ctx.outdatedIds?.size ?? 0;
				if (n <= 0) new Notice(t("action.checkUpdate.upToDate"));
				else new Notice(t("action.checkUpdate.available", { n: String(n) }));
			})
			.catch(() => new Notice(t("action.checkUpdate.failed")))
			.finally(() => {
				checkBtn.removeClass("pt-spin");
				ctx.renderUpdatesList();
			});
	});

	const selectAll = bar.createEl("button", { cls: "pt-updates-selectall", text: t("updates.selectAll") });
	selectAll.addEventListener("click", () => {
		outdated.forEach((id) => ctx.updateSelection.add(id));
		ctx.renderUpdatesList();
	});
	const deselectAll = bar.createEl("button", { cls: "pt-updates-deselect", text: t("updates.deselectAll") });
	deselectAll.addEventListener("click", () => {
		ctx.updateSelection.clear();
		ctx.renderUpdatesList();
	});

	const updateSel = bar.createEl("button", {
		cls: "pt-updates-update-sel",
		text: t("updates.updateSelected", { n: String(ctx.updateSelection.size) }),
	});
	updateSel.addEventListener("click", () => void ctx.updateSelected([...ctx.updateSelection]));

	const updateAll = bar.createEl("button", { cls: "pt-updates-update-all", text: t("updates.updateAll") });
	updateAll.addEventListener("click", () => void ctx.updateAll());

	// ── 空态 ──
	if (outdated.length === 0) {
		const empty = el.createDiv({ cls: "pt-updates-empty" });
		empty.createDiv({ cls: "pt-updates-empty-title", text: t("updates.empty") });
		empty.createDiv({ cls: "pt-updates-empty-hint", text: t("updates.empty.hint") });
		return;
	}

	// ── 行列表（按名称排序，便于定位）──
	const rows = el.createDiv({ cls: "pt-updates-rows" });
	const infos = ctx.allPlugins
		.filter((p) => ctx.outdatedIds?.has(p.id))
		.sort((a, b) => a.name.localeCompare(b.name));

	for (const p of infos) {
		const info = ctx.outdatedInfo?.get(p.id);
		const row = rows.createDiv({ cls: "pt-updates-row" });

		const cb = row.createEl("input", {
			cls: "pt-updates-check",
			type: "checkbox",
			attr: { type: "checkbox", "aria-label": p.name },
		});
		cb.checked = ctx.updateSelection.has(p.id);
		cb.addEventListener("change", () => {
			if (cb.checked) ctx.updateSelection.add(p.id);
			else ctx.updateSelection.delete(p.id);
			count.setText(t("updates.count", { n: String(ctx.updateSelection.size), m: String(outdated.length) }));
			updateSel.setText(t("updates.updateSelected", { n: String(ctx.updateSelection.size) }));
		});

		const name = row.createDiv({ cls: "pt-updates-name" });
		name.setText(p.name);

		row.createDiv({
			cls: "pt-updates-diff",
			text: t("updates.versionDiff", { local: info?.local ?? "", latest: info?.latest ?? "" }),
		});

		const updBtn = row.createEl("button", {
			cls: "pt-updates-row-update clickable-icon",
			attr: { "aria-label": t("action.update"), title: t("action.update"), type: "button" },
		});
		setIcon(updBtn, "arrow-down-to-line");
		updBtn.addEventListener("click", async () => {
			if (updBtn.hasClass("pt-spin")) return;
			updBtn.addClass("pt-spin");
			await ctx.updatePlugin(p.id);
			updBtn.removeClass("pt-spin");
			ctx.refreshViewTabsBadge?.();
			ctx.renderUpdatesList();
		});
	}
}

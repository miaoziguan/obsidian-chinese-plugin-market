/**
 * 「更新」页签列表渲染器。
 *
 * 主视图顶部的「更新」页签切到本视图时，调用 renderUpdatesList 在
 * ctx.updatesListEl 中渲染：
 * - 可更新插件的「名称 + 本地→最新版本差 + 勾选框 + 选版本 + 更新」；
 * - 「已固定版本」分区：列出被锁定到指定版本的插件（不参与自动更新检测），
 *   可一键「保持最新」或重新选择版本（BRAT 式）。
 * 顶部带「检查更新 / 全选 / 取消全选 / 更新所选(N) / 全部更新」工具条，
 * 多选 + 一键全更直接复用 ctx.updateSelected / ctx.updateAll。
 */

import { Notice, setIcon } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";
import { refreshOutdated } from "@ui/view/view-data";
import { openVersionPicker } from "@ui/components/version-picker-modal";
import { createUpdateProgressLayer } from "@ui/components/update-progress";

/** 打开某插件的版本选择弹窗（更新页签与详情抽屉共用同一交互） */
function openPickerFor(ctx: ViewContext, id: string, name: string, repo: string): void {
	openVersionPicker({
		app: ctx.app,
		pluginName: name,
		repo,
		pinned: ctx.pluginVersionPins?.[id] ?? null,
		installedVersion: ctx.installedVersions?.get(id),
		listVersions: (r, force) => ctx.listPluginVersions(r, force),
		onPick: (version) => ctx.pinPluginVersion(id, version),
	});
}

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
	updateSel.addEventListener("click", () => {
		const ids = [...ctx.updateSelection];
		if (ids.length === 0) return;
		runBatchUpdate(ctx, el, bar, ids, false);
	});

	const updateAll = bar.createEl("button", { cls: "pt-updates-update-all", text: t("updates.updateAll") });
	updateAll.addEventListener("click", () => {
		const ids = [...(ctx.outdatedIds ?? [])];
		if (ids.length === 0) {
			new Notice(t("action.update.none"));
			return;
		}
		runBatchUpdate(ctx, el, bar, ids, true);
	});

	// ── 空态 ──
	if (outdated.length === 0) {
		const empty = el.createDiv({ cls: "pt-updates-empty" });
		empty.createDiv({ cls: "pt-updates-empty-title", text: t("updates.empty") });
		empty.createDiv({ cls: "pt-updates-empty-hint", text: t("updates.empty.hint") });
		renderPinnedSection(ctx, el);
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

		// 选版本（固定到某个旧版本，或改为保持最新）
		const pinBtn = row.createEl("button", {
			cls: "pt-updates-row-pin clickable-icon",
			attr: { "aria-label": t("updates.pin"), title: t("updates.pin"), type: "button" },
		});
		setIcon(pinBtn, "tag");
		pinBtn.addEventListener("click", () => {
			if (p.repo) openPickerFor(ctx, p.id, p.name, p.repo);
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

	renderPinnedSection(ctx, el);
}

/**
 * 「已固定版本」分区：列出锁定到指定版本的已安装插件。
 * 这些插件不参与自动更新检测，因此不会出现在上面的可更新列表里，
 * 需要独立分区让用户能看见并解除固定。
 */
function renderPinnedSection(ctx: ViewContext, el: HTMLElement): void {
	const pins = ctx.pluginVersionPins ?? {};
	const t = ctx.t;
	const pinned = ctx.allPlugins
		.filter((p) => pins[p.id] && (ctx.installedIds?.has(p.id) ?? false))
		.sort((a, b) => a.name.localeCompare(b.name));
	if (pinned.length === 0) return;

	const section = el.createDiv({ cls: "pt-updates-pinned" });
	section.createDiv({ cls: "pt-updates-pinned-title", text: t("updates.pinned.title") });
	section.createDiv({ cls: "pt-updates-pinned-hint", text: t("updates.pinned.hint") });

	const rows = section.createDiv({ cls: "pt-updates-rows" });
	for (const p of pinned) {
		const row = rows.createDiv({ cls: "pt-updates-row pt-updates-row--pinned" });
		row.createDiv({ cls: "pt-updates-name", text: p.name });
		row.createDiv({
			cls: "pt-updates-diff pt-updates-pinned-ver",
			text: t("version.pinned", { version: pins[p.id] }),
		});

		const pinBtn = row.createEl("button", {
			cls: "pt-updates-row-pin clickable-icon",
			attr: { "aria-label": t("updates.pin"), title: t("updates.pin"), type: "button" },
		});
		setIcon(pinBtn, "tag");
		pinBtn.addEventListener("click", () => {
			if (p.repo) openPickerFor(ctx, p.id, p.name, p.repo);
		});

		const unpinBtn = row.createEl("button", {
			cls: "pt-updates-row-update pt-updates-unpin clickable-icon",
			attr: { "aria-label": t("version.latest"), title: t("version.latest"), type: "button" },
		});
		setIcon(unpinBtn, "arrow-down-to-line");
		unpinBtn.addEventListener("click", async () => {
			if (unpinBtn.hasClass("pt-spin")) return;
			unpinBtn.addClass("pt-spin");
			await ctx.pinPluginVersion(p.id, null);
			unpinBtn.removeClass("pt-spin");
			ctx.renderUpdatesList();
		});
	}
}

/**
 * 批量更新并展示进度条：进度条挂在列表容器内、工具条之后；批量期间 updateAll/updateSelected
 * 跳过逐条列表重渲（skipListRender），由它们在末尾统一刷新，进度条随之自然消失。
 */
function runBatchUpdate(
	ctx: ViewContext,
	el: HTMLElement,
	bar: HTMLElement,
	ids: string[],
	all: boolean,
): void {
	const prog = createUpdateProgressLayer();
	bar.after(prog.el);
	ctx.track(all ? "action:updateAll" : "action:updateSelected");
	const onProgress = (done: number, total: number, label?: string) =>
		prog.set(done, total, label ? ctx.t("action.update.current", { name: label }) : undefined);
	const task = all ? ctx.updateAll(onProgress) : ctx.updateSelected(ids, onProgress);
	void task.finally(() => prog.finish());
}

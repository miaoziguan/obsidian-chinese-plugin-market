/**
 * 「CSS 片段」页签列表渲染器。
 *
 * 主视图顶部「CSS 片段」页签切到本视图时，调用 renderCssSnippetsList 在
 * ctx.cssSnippetListEl 中渲染 vault 的 CSS 片段：
 * - 顶部工具栏：搜索框 + 分组筛选 + 状态筛选 + 新建片段按钮；
 * - 列表：每行复用 renderCssSnippetRow（分组徽标 / 备注 / 启用开关 / 打开 / 重命名），
 *   行首加勾选框，行内加删除按钮；
 * - 选中片段后顶部浮现批量工具栏（批量启 / 批量停 / 批量删除）；
 * - 新建：prompt 输入基名 → store.createSnippet；删除：确认 Modal → store.deleteSnippet；
 * - 搜索 / 分组 / 状态筛选复用 manage-filter 的 matchesFilter（纯函数，可单测）。
 *
 * 数据源是 .obsidian/snippets/*.css + app.customCss，由 CssStorePort 统一管理。
 *
 * 注：本模块刻意只用标准 DOM API + Obsidian 全局 createDiv/createEl/createSpan，
 * 不依赖 HTMLElement 原型扩展方法（如 el.createDiv / el.setCssStyles），
 * 以便与 jsdom 测试环境一致。
 */

import { Modal, Notice } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";
import type { CssStorePort } from "@ui/settings/snippet-manage-store";
import type { SnippetInfo } from "@data/platform/snippet";
import { renderCssSnippetRow } from "@ui/settings/css-snippet-row";
import { matchesFilter, type ManageFilterState } from "@domain/manage/manage-filter";
import { getMeta } from "@domain/manage/plugin-meta";
import { GROUP_ALL, type ManageFilterStatus, type ManageRow } from "@domain/manage/types";

/** 渲染主入口：根据 ctx.viewTab 决定是否渲染（非 css 页签直接返回，避免误渲染） */
export function renderCssSnippetsList(ctx: ViewContext): void {
	const el = ctx.cssSnippetListEl;
	if (!el || ctx.viewTab !== "css") return;
	el.innerHTML = "";
	const store = ctx.cssStore;
	const selected = new Set<string>();
	const state: ManageFilterState = { keyword: "", group: GROUP_ALL, status: "all" };

	// ── 顶部工具栏 ──
	const bar = createDiv({ cls: "pt-css-bar" });
	el.appendChild(bar);
	const search = createEl("input", {
		cls: "pt-css-search",
		attr: { "data-cpm-css-search": "", type: "text", placeholder: ctx.t("css.filter.keyword.ph") },
	});
	bar.appendChild(search);
	const listEl = createDiv({ cls: "pt-css-list-inner" });
	el.appendChild(listEl);

	const rerender = () => rerenderList(ctx, store, listEl, selected, state);
	search.addEventListener("input", () => {
		state.keyword = search.value;
		rerender();
	});
	// 状态筛选
	const statusSel = createEl("select", { cls: "pt-css-status" });
	bar.appendChild(statusSel);
	for (const [val, key] of [
		["all", "css.filter.status.all"],
		["enabled", "css.filter.status.enabled"],
		["disabled", "css.filter.status.disabled"],
	] as const) {
		statusSel.appendChild(createEl("option", { text: ctx.t(key), attr: { value: val } }));
	}
	statusSel.addEventListener("change", () => {
		state.status = statusSel.value as ManageFilterStatus;
		rerender();
	});
	// 分组筛选
	const groupSel = createEl("select", { cls: "pt-css-group" });
	bar.appendChild(groupSel);
	groupSel.appendChild(createEl("option", { text: ctx.t("css.filter.group.all"), attr: { value: GROUP_ALL } }));
	for (const [key, name] of Object.entries(store.settings.cssGroups)) {
		groupSel.appendChild(createEl("option", { text: name, attr: { value: key } }));
	}
	groupSel.addEventListener("change", () => {
		state.group = groupSel.value;
		rerender();
	});
	// 新建片段按钮
	const newBtn = createEl("button", {
		cls: "pt-css-new clickable-icon",
		text: ctx.t("css.new"),
		attr: { "data-cpm-css-new": "", type: "button" },
	});
	bar.appendChild(newBtn);
	newBtn.addEventListener("click", () => requestCreate(ctx, store));

	rerender();
}

/** 把片段转成 ManageRow，供 manage-filter 的 matchesFilter 计算 */
function toRow(s: SnippetInfo, store: CssStorePort): ManageRow {
	const meta = getMeta(store.settings.cssMeta, s.baseName);
	return {
		id: s.baseName,
		name: s.name,
		author: "",
		remark: meta.remark ?? "",
		group: meta.group ?? GROUP_ALL,
		enabled: s.enabled,
	};
}

/** 按当前筛选条件渲染可见行（复用 renderCssSnippetRow 画每行） */
function rerenderList(
	ctx: ViewContext,
	store: CssStorePort,
	listEl: HTMLElement,
	selected: Set<string>,
	state: ManageFilterState,
): void {
	listEl.innerHTML = "";
	const snippets = store.listSnippets();
	let shown = 0;
	for (const snippet of snippets) {
		if (!matchesFilter(toRow(snippet, store), state)) continue;
		shown++;
		const rowEl = createDiv({ cls: "setting-item" });
		rowEl.dataset.cpmSnippet = snippet.baseName;
		listEl.appendChild(rowEl);
		// 行首勾选框（包裹在行外层，不污染 renderCssSnippetRow）
		const check = createEl("input", { cls: "cpm-css-check", attr: { type: "checkbox" } });
		rowEl.appendChild(check);
		if (selected.has(snippet.baseName)) check.checked = true;
		check.addEventListener("change", () => {
			if (check.checked) selected.add(snippet.baseName);
			else selected.delete(snippet.baseName);
			updateBulkBar(ctx, ctx.cssSnippetListEl ?? listEl, store, selected);
		});
		renderCssSnippetRow(rowEl, snippet, {
			store,
			onRowChange: () => rerenderList(ctx, store, listEl, selected, state),
			onFilterChange: () => rerenderList(ctx, store, listEl, selected, state),
			requestRename: (base) => requestRename(ctx, store, base),
		});
		// 行内删除按钮（复用行控件区）
		const delBtn = createEl("button", {
			cls: "cpm-css-del clickable-icon",
			attr: { "aria-label": ctx.t("css.delete"), title: ctx.t("css.delete"), type: "button" },
		});
		rowEl.appendChild(delBtn);
		delBtn.addEventListener("click", (e) => {
			e.stopPropagation();
			requestDelete(ctx, store, snippet);
		});
	}
	if (shown === 0) {
		listEl.appendChild(createDiv({ cls: "pt-css-empty", text: ctx.t("css.empty") }));
	}
	// 清理已不在可见列表中的选中项
	for (const b of [...selected]) {
		const s = snippets.find((x) => x.baseName === b);
		if (!s || !matchesFilter(toRow(s, store), state)) selected.delete(b);
	}
}

/** 顶部「新建片段」：prompt 输入基名，校验后写空 .css */
function requestCreate(ctx: ViewContext, store: CssStorePort): void {
	const raw = window.prompt(ctx.t("css.new.name"));
	if (raw == null) return;
	const base = raw.trim().replace(/\.css$/i, "");
	if (!base) return;
	void store.createSnippet(base, "").then(() => renderCssSnippetsList(ctx));
}

/** 重命名：复用现有重命名范式（通过 store.renameSnippet） */
function requestRename(ctx: ViewContext, store: CssStorePort, base: string): void {
	const raw = window.prompt(ctx.t("css.rename.name"), base);
	if (raw == null) return;
	const next = raw.trim().replace(/\.css$/i, "");
	if (!next || next === base) return;
	void store.renameSnippet(base, next).then(() => renderCssSnippetsList(ctx));
}

/** 删除：确认 Modal → store.deleteSnippet → 重渲染 */
function requestDelete(ctx: ViewContext, store: CssStorePort, snippet: SnippetInfo): void {
	const modal = new Modal(ctx.app);
	const tip = createDiv({ text: ctx.t("css.delete.confirm", { name: snippet.name }) });
	modal.contentEl.appendChild(tip);
	const ok = createEl("button", { text: ctx.t("action.ok") });
	modal.contentEl.appendChild(ok);
	ok.addEventListener("click", () => {
		void store.deleteSnippet(snippet.baseName).then(() => renderCssSnippetsList(ctx));
		modal.close();
	});
	modal.open();
}

/** 选中集合变化 → 显隐批量工具栏（批量启 / 批量停 / 批量删除） */
function updateBulkBar(
	ctx: ViewContext,
	root: HTMLElement,
	store: CssStorePort,
	selected: Set<string>,
): void {
	let bulk = root.querySelector<HTMLElement>(".pt-css-bulk");
	bulk?.remove();
	if (selected.size === 0) return;
	bulk = createDiv({ cls: "pt-css-bulk" });
	root.appendChild(bulk);
	const label = createSpan({ text: ctx.t("css.bulk.selected", { n: String(selected.size) }) });
	bulk.appendChild(label);
	const enable = createEl("button", { text: ctx.t("css.bulk.enable") });
	bulk.appendChild(enable);
	enable.addEventListener("click", () => bulkApply(ctx, store, [...selected], "enable"));
	const disable = createEl("button", { text: ctx.t("css.bulk.disable") });
	bulk.appendChild(disable);
	disable.addEventListener("click", () => bulkApply(ctx, store, [...selected], "disable"));
	const del = createEl("button", { text: ctx.t("css.bulk.delete") });
	bulk.appendChild(del);
	del.addEventListener("click", () => bulkApply(ctx, store, [...selected], "delete"));
}

async function bulkApply(
	ctx: ViewContext,
	store: CssStorePort,
	bases: string[],
	op: "enable" | "disable" | "delete",
): Promise<void> {
	let ok = 0;
	let fail = 0;
	for (const b of bases) {
		try {
			if (op === "enable") await store.setSnippetEnabled(b, true);
			else if (op === "disable") await store.setSnippetEnabled(b, false);
			else await store.deleteSnippet(b);
			ok++;
		} catch {
			fail++;
		}
	}
	if (fail > 0) new Notice(ctx.t("css.bulk.summary", { ok: String(ok), fail: String(fail) }));
	renderCssSnippetsList(ctx);
}

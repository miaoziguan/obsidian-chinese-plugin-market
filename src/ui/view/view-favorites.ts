/**
 * 「收藏」页签列表渲染器：分组管理已收藏的插件。
 *
 * 顶部工具栏：搜索框 + 计数 + 分组筛选 + 新建分组按钮；
 * 列表：按组分区块（组名标题 + 数量 + 重命名/删除），未分组区固定在最后；
 * 每行：插件名（点击打开详情）+ 组归属下拉（换组即存）+ 取消收藏按钮。
 *
 * 数据模型（全部随 settings 持久化）：
 * - 收藏集 = ctx.favoritesSet（settings.favorites 的 Set 视图）；
 * - 分组 = settings.favoriteGroupOf（插件 id → 组名；未出现 = 未分组）。
 *   组列表由映射值动态派生（按首次出现顺序稳定排序），无需单独维护组清单——
 *   删除组 = 清掉成员映射；重命名组 = 遍历替换值。收藏量级小（几十），O(n) 足够。
 *
 * 注：与 view-css-snippets 同款约束——只用标准 DOM API，便于 jsdom 测试。
 */

import type { ViewContext } from "@ui/view/view-context";

/** 分组筛选哨兵值：全部 */
export const FAV_GROUP_ALL = "__all__";
/** 分组筛选哨兵值：未分组 */
export const FAV_GROUP_NONE = "__none__";

/** 渲染主入口：非 favorites 页签直接返回（与 renderCssSnippetsList 同款守卫） */
export function renderFavoritesList(ctx: ViewContext): void {
	const el = ctx.favoritesListEl;
	if (!el || ctx.viewTab !== "favorites") return;
	el.innerHTML = "";

	// 本地会话态（重渲染时重建，不持久化）；搜索词从 ctx.favKeyword 恢复，避免操作后丢失
	const state = { keyword: ctx.favKeyword || "", group: ctx.favoriteGroupFilter || FAV_GROUP_ALL };

	// ── 顶部工具栏 ──
	const bar = createDiv({ cls: "pt-css-bar" });
	el.appendChild(bar);
	const search = createEl("input", {
		cls: "pt-css-search",
		attr: { "data-cpm-fav-search": "", type: "text", placeholder: ctx.t("fav.filter.keyword.ph") },
	});
	bar.appendChild(search);
	search.value = state.keyword; // 整页重渲后回填搜索词（来自 favKeyword 暂存）
	const countEl = createSpan({ cls: "pt-css-count" });
	bar.appendChild(countEl);
	const listEl = createDiv({ cls: "pt-css-list-inner" });
	el.appendChild(listEl);

	const rerender = () => {
		ctx.favoriteGroupFilter = state.group;
		ctx.favKeyword = state.keyword;
		rerenderList(ctx, listEl, countEl, state);
	};
	search.addEventListener("input", () => {
		state.keyword = search.value;
		rerender();
	});

	// 分组筛选下拉
	const groupSel = createEl("select", { cls: "pt-css-group" });
	bar.appendChild(groupSel);
	for (const [val, key] of [
		[FAV_GROUP_ALL, "fav.filter.group.all"],
		[FAV_GROUP_NONE, "fav.group.none"],
	] as const) {
		groupSel.appendChild(createEl("option", { text: ctx.t(key), attr: { value: val } }));
	}
	for (const name of listGroups(ctx)) {
		groupSel.appendChild(createEl("option", { text: name, attr: { value: name } }));
	}
	groupSel.value = state.group;
	groupSel.addEventListener("change", () => {
		state.group = groupSel.value;
		rerender();
	});

	// 新建分组
	const newGroupBtn = createEl("button", {
		cls: "pt-css-new clickable-icon",
		text: ctx.t("fav.group.new"),
		attr: { "data-cpm-fav-new-group": "", type: "button" },
	});
	bar.appendChild(newGroupBtn);
	newGroupBtn.addEventListener("click", () => {
		const raw = window.prompt(ctx.t("fav.group.new.ph"), "");
		const name = raw?.trim();
		if (!name) return;
		if (listGroups(ctx).includes(name)) return; // 同名组已存在：静默忽略
		ctx.settings.favoriteGroupNames = [...ctx.settings.favoriteGroupNames, name];
		ctx.saveSettings();
		renderFavoritesList(ctx);
	});

	rerender();
}

/** 组名列表：显式清单 favoriteGroupNames 优先，兜底合并映射值派生（兼容升级前旧数据） */
function listGroups(ctx: ViewContext): string[] {
	const seen = [...ctx.settings.favoriteGroupNames];
	for (const name of Object.values(ctx.settings.favoriteGroupOf)) {
		if (name && !seen.includes(name)) seen.push(name);
	}
	return seen;
}

/** 收藏插件 → 展示信息（找不到插件信息时用 id 兜底，防脏数据渲染崩溃） */
function favInfo(ctx: ViewContext, id: string): { id: string; name: string } {
	const p = ctx.allPlugins.find((x) => x.id === id);
	return { id, name: p?.name ?? id };
}

/** 按当前筛选渲染分组区块列表 */
function rerenderList(ctx: ViewContext, listEl: HTMLElement, countEl: HTMLElement, state: { keyword: string; group: string }): void {
	listEl.innerHTML = "";
	const kw = state.keyword.trim().toLowerCase();
	const groupOf = ctx.settings.favoriteGroupOf;

	// 收集 + 过滤（搜索按名称/Id；分组按选中桶）
	const all = [...ctx.favoritesSet].map((id) => favInfo(ctx, id));
	const visible = all.filter((f) => {
		if (kw && !(`${f.name} ${f.id}`.toLowerCase().includes(kw))) return false;
		const g = groupOf[f.id] ?? "";
		if (state.group === FAV_GROUP_ALL) return true;
		if (state.group === FAV_GROUP_NONE) return g === "";
		return g === state.group;
	});

	countEl.textContent = ctx.t("fav.count", { shown: String(visible.length), total: String(all.length) });

	if (all.length === 0 && listGroups(ctx).length === 0) {
		listEl.appendChild(createDiv({ cls: "pt-css-empty", text: ctx.t("fav.empty") }));
		return;
	}
	// 有收藏但当前筛选+搜索无任何可见项（如某具体组内搜索无果）：提示而非空白
	if (visible.length === 0 && all.length > 0) {
		listEl.appendChild(createDiv({ cls: "pt-css-empty", text: ctx.t("fav.empty.filtered") }));
		return;
	}

	// 分桶：组名 → 成员（保持收藏原始顺序）；未分组桶 key 为 ""
	const buckets = new Map<string, { id: string; name: string }[]>();
	for (const f of visible) {
		const g = groupOf[f.id] ?? "";
		const arr = buckets.get(g);
		if (arr) arr.push(f);
		else buckets.set(g, [f]);
	}

	// 渲染顺序：有名组在前（组清单顺序，空组也渲染区块让用户知道组已建好），未分组最后
	const searchActive = kw.length > 0;
	for (const g of [...listGroups(ctx), ""]) {
		// 指定了某个具体桶时只渲染该桶
		if (state.group !== FAV_GROUP_ALL) {
			const want = state.group === FAV_GROUP_NONE ? "" : state.group;
			if (g !== want) continue;
		}
		const members = buckets.get(g) ?? [];
		// 搜索态下空桶不渲染（避免全是空区块）；非搜索态保留空组区块
		if (searchActive && members.length === 0) continue;
		if (!searchActive && g === "" && members.length === 0) continue;
		listEl.appendChild(renderGroupSection(ctx, g, members));
	}
}

/** 渲染单个分组区块（标题 + 行列表） */
function renderGroupSection(
	ctx: ViewContext,
	group: string,
	members: { id: string; name: string }[],
): HTMLElement {
	const section = createDiv({ cls: "pt-fav-group" });
	const head = createDiv({ cls: "pt-fav-group-head" });
	head.appendChild(createSpan({ cls: "pt-fav-group-name", text: group || ctx.t("fav.group.none") }));
	head.appendChild(createSpan({ cls: "pt-fav-group-count", text: String(members.length) }));

	// 有名组提供重命名 / 删除（未分组区不提供）
	if (group) {
		const renameBtn = createEl("button", {
			cls: "pt-fav-group-btn clickable-icon",
			text: ctx.t("fav.group.rename"),
			attr: { type: "button", "aria-label": ctx.t("fav.group.rename") },
		});
		head.appendChild(renameBtn);
		renameBtn.addEventListener("click", () => {
			const raw = window.prompt(ctx.t("fav.group.rename.ph"), group);
			const next = raw?.trim();
			if (!next || next === group) return;
			void renameGroup(ctx, group, next).then(() => renderFavoritesList(ctx));
		});

		const delBtn = createEl("button", {
			cls: "pt-fav-group-btn clickable-icon",
			text: ctx.t("fav.group.delete"),
			attr: { type: "button", "aria-label": ctx.t("fav.group.delete") },
		});
		head.appendChild(delBtn);
		delBtn.addEventListener("click", () => {
			if (!window.confirm(ctx.t("fav.group.delete.confirm", { name: group }))) return;
			void deleteGroup(ctx, group).then(() => renderFavoritesList(ctx));
		});
	}
	section.appendChild(head);

	const rows = createDiv({ cls: "pt-fav-rows" });
	for (const m of members) rows.appendChild(renderFavRow(ctx, m));
	section.appendChild(rows);
	return section;
}

/** 渲染单行：插件名（点击开详情）+ 组下拉（换组即存）+ 取消收藏 */
function renderFavRow(ctx: ViewContext, fav: { id: string; name: string }): HTMLElement {
	const row = createDiv({ cls: "pt-fav-row", attr: { "data-cpm-fav-row": fav.id } });
	const nameBtn = createEl("button", {
		cls: "pt-fav-name",
		text: fav.name,
		attr: { type: "button", title: ctx.t("fav.open.detail") },
	});
	row.appendChild(nameBtn);
	nameBtn.addEventListener("click", () => ctx.openDetailDrawer(fav.id));

	// 组归属下拉：换组直接写 favoriteGroupOf（选「未分组」即删映射）
	const groupSel = createEl("select", { cls: "pt-css-status", attr: { "aria-label": ctx.t("fav.move.ph") } });
	row.appendChild(groupSel);
	groupSel.appendChild(createEl("option", { text: ctx.t("fav.group.none"), attr: { value: FAV_GROUP_NONE } }));
	for (const g of listGroups(ctx)) {
		groupSel.appendChild(createEl("option", { text: g, attr: { value: g } }));
	}
	groupSel.value = ctx.settings.favoriteGroupOf[fav.id] || FAV_GROUP_NONE;
	groupSel.addEventListener("change", () => {
		const g = groupSel.value;
		const map = { ...ctx.settings.favoriteGroupOf };
		if (g === FAV_GROUP_NONE) delete map[fav.id];
		else map[fav.id] = g;
		ctx.settings.favoriteGroupOf = map;
		ctx.saveSettings();
		renderFavoritesList(ctx); // 整页重渲（搜索词经 favKeyword 恢复）
	});

	// 取消收藏
	const rmBtn = createEl("button", {
		cls: "pt-fav-remove clickable-icon",
		text: ctx.t("fav.remove"),
		attr: { type: "button", "aria-label": ctx.t("fav.remove"), "data-cpm-fav-remove": "" },
	});
	row.appendChild(rmBtn);
	rmBtn.addEventListener("click", () => {
		ctx.toggleFavorite(fav.id); // 切换语义：已收藏 → 取消，内部同步 settings + favoritesSet + 落盘
		renderFavoritesList(ctx); // 整页重渲（搜索词经 favKeyword 恢复）
	});
	return row;
}

/** 重命名组：替换组名清单项 + 遍历替换成员映射值（收藏量小，O(n) 足够） */
async function renameGroup(ctx: ViewContext, from: string, to: string): Promise<void> {
	// 目标名已存在（且非自身）：静默忽略，避免产生重复组名导致合并/渲染重复区块
	if (listGroups(ctx).some((g) => g !== from && g === to)) return;
	ctx.settings.favoriteGroupNames = ctx.settings.favoriteGroupNames.map((g) => (g === from ? to : g));
	const map = ctx.settings.favoriteGroupOf;
	for (const [id, g] of Object.entries(map)) {
		if (g === from) map[id] = to;
	}
	ctx.saveSettings();
}

/** 删除组：从清单移除，该组所有成员回到未分组（删除映射键） */
async function deleteGroup(ctx: ViewContext, group: string): Promise<void> {
	ctx.settings.favoriteGroupNames = ctx.settings.favoriteGroupNames.filter((g) => g !== group);
	const map = { ...ctx.settings.favoriteGroupOf };
	for (const [id, g] of Object.entries(map)) {
		if (g === group) delete map[id];
	}
	ctx.settings.favoriteGroupOf = map;
	ctx.saveSettings();
}

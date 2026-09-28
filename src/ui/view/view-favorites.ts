/**
 * 「收藏」页签列表渲染器：分组管理已收藏的插件（卡片形态，与浏览页统一）。
 *
 * 顶部工具栏：搜索框 + 计数 + 分组筛选（模式菜单同款下拉）+ 新建分组按钮；
 * 列表：按组分区块（组名标题 + 数量 + 重命名/删除），未分组区固定在最后；
 * 每项复用浏览页插件卡片（createPluginCard + .pt-featured-grid 网格），
 * 悬停卡片显示「换组」下拉（组归属即存）。
 *
 * 点击交互走 ctx.onCardClick 事件委托（与浏览页/推荐区完全同一套：
 * 安装 / 启用 / 收藏星标 / 对比 / 打开详情…）；取消收藏（点星标）后
 * favoritesSet 变化 → 整页重渲，被取消的卡片即时移除。
 *
 * 数据模型（全部随 settings 持久化）：
 * - 收藏集 = ctx.favoritesSet（settings.favorites 的 Set 视图）；
 * - 分组 = settings.favoriteGroupOf（插件 id → 组名；未出现 = 未分组）。
 *   组列表由映射值动态派生（按首次出现顺序稳定排序），无需单独维护组清单——
 *   删除组 = 清掉成员映射；重命名组 = 遍历替换值。收藏量级小（几十），O(n) 足够。
 *
 * 注：与 view-css-snippets 同款约束——只用标准 DOM API + 全局 createDiv/createEl，
 * 便于 jsdom 测试。
 */

import type { ViewContext } from "@ui/view/view-context";
import { Menu, Modal, setIcon } from "obsidian";
import { PromptModal } from "@ui/modals/prompt-modal";
import { createPluginCard } from "@ui/components/card-render";
import { createMenuSelect } from "@ui/components/menu-select";
import { handleToggleEnabled } from "@ui/view/view-cards";

/** 分组筛选哨兵值：全部 */
export const FAV_GROUP_ALL = "__all__";
/** 分组筛选哨兵值：未分组 */
export const FAV_GROUP_NONE = "__none__";

/** 渲染主入口：非 favorites 页签直接返回（与 renderCssSnippetsList 同款守卫） */
export function renderFavoritesList(ctx: ViewContext): void {
	const el = ctx.favoritesListEl;
	if (!el || ctx.viewTab !== "favorites") return;
	el.innerHTML = "";

	// 卡片交互走与浏览页同一套事件委托（ctx.onCardClick：安装/收藏/对比/详情…）。
	// 收藏集变化（点卡片星标取消收藏）→ 整页重渲，被取消的卡片即时移除。
	const bound = el as HTMLElement & { __favClickBound?: boolean };
	if (!bound.__favClickBound) {
		bound.__favClickBound = true;
		el.addEventListener("click", (ev) => {
			const before = ctx.favoritesSet.size;
			ctx.onCardClick?.(ev);
			if (ctx.favoritesSet.size !== before) renderFavoritesList(ctx);
		});
	}

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

	// 分组筛选下拉：搜索模式同款（button + 原生 Menu），替换原生 <select>
	createMenuSelect(bar, {
		getOptions: () => [
			{ value: FAV_GROUP_ALL, label: ctx.t("fav.filter.group.all") },
			{ value: FAV_GROUP_NONE, label: ctx.t("fav.group.none") },
			...listGroups(ctx).map((name) => ({ value: name, label: name })),
		],
		getValue: () => state.group,
		onPick: (v) => {
			state.group = v;
			rerender();
		},
	});

	// 新建分组
	const newGroupBtn = createEl("button", {
		cls: "pt-css-new clickable-icon",
		text: ctx.t("fav.group.new"),
		attr: { "data-cpm-fav-new-group": "", type: "button" },
	});
	bar.appendChild(newGroupBtn);
	newGroupBtn.addEventListener("click", () => {
		new PromptModal(
			ctx.app,
			ctx.t("fav.group.new"),
			ctx.t("fav.group.new.ph"),
			"",
			(name) => {
				if (listGroups(ctx).includes(name)) return; // 同名组已存在：静默忽略
				ctx.settings.favoriteGroupNames = [...ctx.settings.favoriteGroupNames, name];
				ctx.saveSettings();
				renderFavoritesList(ctx);
			},
			ctx.t("action.ok"),
			ctx.t("action.cancel"),
		).open();
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

/** 收藏插件展示名（找不到插件信息时用 id 兜底，防脏数据） */
function nameOf(ctx: ViewContext, id: string): string {
	return ctx.allPlugins.find((x) => x.id === id)?.name ?? id;
}

/** 按当前筛选渲染分组区块列表 */
function rerenderList(ctx: ViewContext, listEl: HTMLElement, countEl: HTMLElement, state: { keyword: string; group: string }): void {
	listEl.innerHTML = "";
	const kw = state.keyword.trim().toLowerCase();
	const groupOf = ctx.settings.favoriteGroupOf;

	// 收集 + 过滤（搜索按名称/Id；分组按选中桶）
	const all = [...ctx.favoritesSet];
	const visible = all.filter((id) => {
		if (kw && !(`${nameOf(ctx, id)} ${id}`.toLowerCase().includes(kw))) return false;
		const g = groupOf[id] ?? "";
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

	// 分桶：组名 → 成员 id（保持收藏原始顺序）；未分组桶 key 为 ""
	const buckets = new Map<string, string[]>();
	for (const id of visible) {
		const g = groupOf[id] ?? "";
		const arr = buckets.get(g);
		if (arr) arr.push(id);
		else buckets.set(g, [id]);
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

/** 渲染单个分组区块（标题 + 卡片网格） */
function renderGroupSection(ctx: ViewContext, group: string, members: string[]): HTMLElement {
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
			new PromptModal(
				ctx.app,
				ctx.t("fav.group.rename"),
				ctx.t("fav.group.rename.ph"),
				group,
				(next) => {
					if (next === group) return;
					void renameGroup(ctx, group, next).then(() => renderFavoritesList(ctx));
				},
				ctx.t("action.ok"),
				ctx.t("action.cancel"),
			).open();
		});

		const delBtn = createEl("button", {
			cls: "pt-fav-group-btn clickable-icon",
			text: ctx.t("fav.group.delete"),
			attr: { type: "button", "aria-label": ctx.t("fav.group.delete") },
		});
		head.appendChild(delBtn);
		delBtn.addEventListener("click", () => {
			const modal = new Modal(ctx.app);
			const tip = createDiv({ text: ctx.t("fav.group.delete.confirm", { name: group }) });
			modal.contentEl.appendChild(tip);
			const ok = createEl("button", { cls: "mod-cta", text: ctx.t("fav.group.delete") });
			modal.contentEl.appendChild(ok);
			ok.addEventListener("click", () => {
				void deleteGroup(ctx, group).then(() => renderFavoritesList(ctx));
				modal.close();
			});
			modal.open();
		});
	}
	section.appendChild(head);

	// 卡片网格：复用浏览页推荐区同款网格布局
	const grid = createDiv({ cls: "pt-featured-grid" });
	for (const id of members) {
		const wrap = renderFavCard(ctx, id);
		if (wrap) grid.appendChild(wrap);
	}
	section.appendChild(grid);
	return section;
}

/**
 * 渲染单个收藏卡片：浏览页同款卡片 + 悬停显示的「换组」下拉。
 * 插件信息缺失（脏数据：已收藏但目录里没有）时返回 null 跳过，防渲染崩溃。
 */
function renderFavCard(ctx: ViewContext, id: string): HTMLElement | null {
	const plugin = ctx.allPlugins.find((p) => p.id === id);
	if (!plugin) return null;

	const wrap = createDiv({ cls: "pt-fav-card-wrap", attr: { "data-cpm-fav-row": id } });
	const card = createPluginCard(plugin, ctx.translatedResults?.[id], {
		t: ctx.t,
		settings: ctx.settings,
		installedIds: ctx.installedIds,
		enabledIds: ctx.enabledIds,
		aiSearchResult: ctx.aiSearchResult ?? null,
		compareSet: ctx.compareSet,
		favoritesSet: ctx.favoritesSet,
		smartSignals: ctx.smartSignals,
		// 卡片高度固定，描述展开不改变布局
		onDescToggle: () => {},
		// 「🍎 系统翻译」成功 → 落库沉淀（cache + tmApproved）
		onSysTranslatePersist: (pid, name, desc) => {
			ctx.translator?.persistSystemTranslation?.(pid, name, desc);
			ctx.saveTranslatorData?.();
		},
		// 卡片电源按钮：切换已安装插件启用/禁用
		onToggleEnabled: (pid) => {
			const p = ctx.plugins.find((x) => x.id === pid);
			if (p) void handleToggleEnabled(ctx, p);
		},
	});
	wrap.appendChild(card);

	// 换组按钮：放在卡片头行「插件名 → 安装按钮」之间，紧跟插件名右侧。
	// 之前把 <select> 绝对定位在卡片右上角会与安装胶囊重叠，外置手柄又占用额外列宽；
	// 现在归位到头行内、插件名右边，既不打架又始终可见，点击弹出原生 Menu 选组。
	const groupBtn = createEl("button", {
		cls: "pt-card-group-btn",
		attr: { type: "button", "aria-label": ctx.t("fav.move.ph"), title: ctx.t("fav.move.ph") },
	});
	setIcon(groupBtn, "folder");
	groupBtn.addEventListener("click", (e) => {
		e.stopPropagation();
		const menu = new Menu();
		const current = ctx.settings.favoriteGroupOf[id] || "";
		const addOption = (label: string, value: string, isChecked: boolean) => {
			menu.addItem((item) =>
				item
					.setTitle(label)
					.setChecked(isChecked)
					.onClick(() => {
						const map = { ...ctx.settings.favoriteGroupOf };
						if (value === FAV_GROUP_NONE) delete map[id];
						else map[id] = value;
						ctx.settings.favoriteGroupOf = map;
						ctx.saveSettings();
						renderFavoritesList(ctx); // 整页重渲（搜索词经 favKeyword 恢复）
					}),
			);
		};
		for (const g of listGroups(ctx)) {
			addOption(g, g, g === current);
		}
		menu.addSeparator();
		addOption(ctx.t("fav.group.none"), FAV_GROUP_NONE, current === "");
		const rect = groupBtn.getBoundingClientRect();
		menu.showAtPosition({ x: rect.left, y: rect.bottom + 4 });
	});
	const headRow = card.querySelector<HTMLElement>(".pt-card-head-row");
	const installRef = headRow?.querySelector<HTMLElement>(".pt-card-install-btn");
	if (headRow && installRef) headRow.insertBefore(groupBtn, installRef);
	else wrap.appendChild(groupBtn);
	return wrap;
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

/**
 * 官方推荐区（featured）。
 *
 * 首页「官方推荐」区块的渲染，整合 plugin-recommend.json 与内置兜底清单。
 */

import { createPluginCard } from "./card-render";
import type { ViewContext } from "./view-context";

import { computeFeaturedIds as computeFeaturedIdsPure } from "./recommend/featured";

// 内容签名缓存：官方推荐仅依赖 recommendScores + installedIds（与搜索词、滚动无关），
// 故仅在这两者引用/规模变化时才重算引擎推荐 + 重建卡片，避免落地页加载期间多次
// renderPluginList（数据就绪 → 信号计算 → 分批评译触发 scheduleRender）反复空耗导致卡顿。
const featuredCache = new WeakMap<ViewContext, { contentSig: string; ids: string[]; installSig: string }>();

/** 已展示卡片的安装态签名：同尺寸换装（卸一装一）时 objId+size 签名不变，需按 id 逐一比对 */
function computeInstallSig(ids: string[], installedIds: Set<string>): string {
	return ids.map((id) => (installedIds.has(id) ? "1" : "0")).join("");
}
const objIdMap = new WeakMap<object, number>();
let objIdSeq = 1;
function objId(o: object | null | undefined): number {
	if (!o) return 0;
	let id = objIdMap.get(o);
	if (id === undefined) {
		id = objIdSeq++;
		objIdMap.set(o, id);
	}
	return id;
}

// ───────── 核心 ─────────

export function renderFeaturedSection(ctx: ViewContext) {

	// 首页即强曝光推荐，不受来源/安装筛选影响。
	// 关键词模式、无搜索词（默认落地页）时强曝光，避免重复曝光。
	// 仅在主动搜索、按作者钻取、或已开「推荐」筛选（列表已是推荐全集）时隐藏。
	const show =
		!ctx.searchQuery.trim() &&
		!ctx.authorFilter &&
		!ctx.recommendedOnly &&
		!ctx.compareMode &&
		ctx.searchMode === "keyword";

		if (!show) {
			ctx.hideFeaturedSection();
			return;
		}

		// 内容签名：仅 recommendScores / installedIds 变化时才重算 + 重建。
		// 官方推荐与搜索词、滚动无关，故落地页加载期间的高频 renderPluginList
		// 全部命中缓存，跳过昂贵的引擎重排与 4 张卡片重建，消除卡顿。
		const contentSig =
			objId(ctx.recommendScores) + "|" + objId(ctx.installedIds) + "|" + ctx.installedIds.size;
		const cached = featuredCache.get(ctx);
		if (
			cached &&
			cached.contentSig === contentSig &&
			cached.installSig === computeInstallSig(cached.ids, ctx.installedIds) &&
			ctx.featuredSectionEl
		) {
			// 内容不变：复用既有卡片，仅按折叠态同步显隐
			ctx.featuredSectionEl.setCssStyles({ display: ctx.featuredCollapsed ? "none" : "" });
			ctx.featuredSectionEl.classList.toggle("pt-featured--collapsed", ctx.featuredCollapsed);
			return;
		}

		// ── 生产 Featured 插件列表（引擎优先，回退到策划清单） ──
		const { ids, engineDriven } = computeFeaturedIds(ctx);
		if (ids.length === 0) {
			ctx.hideFeaturedSection();
			// 记录空结果签名，避免同内容渲染反复进入重算
			featuredCache.set(ctx, { contentSig, ids, installSig: "" });
			return;
		}

		if (!ctx.featuredSectionEl) ctx.ensureFeaturedSection();
		const section = ctx.featuredSectionEl!;
		const grid = ctx.featuredGridEl!;

		// 更新标题（副标题「羽鳞君 · 出品」已移除，更简洁）
		const titleEl = section.querySelector(".pt-featured-title") as HTMLElement;
		if (titleEl) titleEl.textContent = engineDriven
			? "为你精选"
			: (ctx.recommendedTitle || ctx.t("recommend.title"));

		// 渲染卡片
		grid.empty();
		// 按 ids 的顺序取插件：ids 承载推荐引擎的排序权重，
		// 若用 ctx.plugins.filter 会退化成插件列表原始顺序，推荐排序被丢弃
		const byId = new Map(ctx.plugins.map((p) => [p.id, p]));
		const recPlugins = ids
			.map((id) => byId.get(id))
			.filter((p): p is NonNullable<typeof p> => Boolean(p));
		for (const plugin of recPlugins) {
			const result = ctx.translatedResults[plugin.id];
			const card = createPluginCard(plugin, result, {
				t: ctx.t,
				installedIds: ctx.installedIds,
				enabledIds: ctx.enabledIds,
				aiSearchResult: ctx.aiSearchResult,
				compareSet: ctx.compareSet,
				favoritesSet: ctx.favoritesSet,
				smartSignals: ctx.smartSignals,
				isRecommended: true,
				// 卡片高度已固定，描述展开不再改变布局，无需重绘
				onDescToggle: () => {},
				// 「🍎 系统翻译」成功 → 落库沉淀（cache + tmApproved）
				onSysTranslatePersist: (pid, name, desc) => {
					ctx.translator.persistSystemTranslation(pid, name, desc);
					ctx.saveTranslatorData();
				},
			});
			grid.appendChild(card);
		}
		section.setCssStyles({ display: "" });
		section.classList.toggle("pt-featured--collapsed", ctx.featuredCollapsed);
		featuredCache.set(ctx, { contentSig, ids, installSig: computeInstallSig(ids, ctx.installedIds) });

	}

export function ensureFeaturedSection(ctx: ViewContext) {

		if (ctx.featuredSectionEl) return;
		const section = ctx.containerEl.createEl("div", { cls: "pt-featured" });
		const head = section.createEl("div", { cls: "pt-featured-head" });
		// 关键对齐属性已由 styles.css 中以 !important 锁定（head/title/toggle），
		// 彻底绕开 Obsidian 主题对 flex 方向/对齐的干扰，无需在 JS 内联 setProperty。

		head.createEl("span", {
			cls: "pt-featured-title",
			text: ctx.recommendedTitle || ctx.t("recommend.title"),
		});

		// 副标题「羽鳞君 · 出品」已按需求移除
		// 用 <span role="button"> 而非 <button>：避开 Obsidian 主题对 <button> 的默认盒模型覆盖。
		const toggle = head.createEl("span", {
			cls: "pt-featured-toggle",
			attr: {
				role: "button",
				tabindex: "0",
				"aria-label": ctx.t("recommend.section.collapse"),
				title: ctx.t("recommend.section.collapse"),
			},
		});

		const syncToggleLabel = () => toggle.setText(
			ctx.featuredCollapsed ? ctx.t("recommend.section.expand") : ctx.t("recommend.section.collapse")
		);
		syncToggleLabel();
		toggle.addEventListener("click", () => {
			ctx.featuredCollapsed = !ctx.featuredCollapsed;
			section.classList.toggle("pt-featured--collapsed", ctx.featuredCollapsed);
			syncToggleLabel();
		});
		toggle.addEventListener("keydown", (ev: KeyboardEvent) => {
			if (ev.key === "Enter" || ev.key === " ") {
				ev.preventDefault();
				toggle.click();
			}
		});
		const grid = section.createEl("div", { cls: "pt-featured-grid" });
		grid.addEventListener("click", (ev) => ctx.onCardClick(ev));
		// 放到滚动视口之前：始终可见，作为「推荐」强曝光区。
		// 注意：scrollViewport 是 ctx.contentEl 的直接子节点，而 ctx.containerEl
		// 是其更上层容器；insertBefore 的参考节点必须是直接子节点，故用 contentEl。
		ctx.contentEl.insertBefore(section, ctx.scrollViewport);
		ctx.featuredSectionEl = section;
		ctx.featuredGridEl = grid;
	
}

export function hideFeaturedSection(ctx: ViewContext) {

		if (ctx.featuredSectionEl) ctx.featuredSectionEl.setCssStyles({ display: "none" });
	
}

// ───────── Featured 生产逻辑（已拆离至 recommend/featured.ts，此处仅做 ctx → 参数投影） ─────────

function computeFeaturedIds(ctx: ViewContext): { ids: string[]; engineDriven: boolean } {
	const tagService = ctx.translator.tagService;
	return computeFeaturedIdsPure({
		plugins: ctx.plugins,
		recommendScores: ctx.recommendScores ?? null,
		installedIds: ctx.installedIds,
		curatedIds: ctx.getRecommendedIds() as Set<string>,
		allTags: tagService ? tagService.getAllTags() : null,
	});
}

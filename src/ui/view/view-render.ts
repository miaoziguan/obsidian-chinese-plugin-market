/**
 * 渲染管线核心。
 *
 * 签名守卫（列表未变不重渲）→ 卡片池复用 → 窗口化懒填充（仅渲染可见窗口）
 * → content-visibility 折叠屏外，四层递进降低渲染成本。
 */

import { type PluginInfo } from "@domain/catalog/translator";
import { filterAndSortPlugins, resolveEmptyState } from "@domain/filter/filter";
import { computeColCount, computeWindowRange, computeSpacerHeights } from "@ui/dom/virtual-scroll";
import { createCardElement, applyCardState, type CardRenderContext } from "@ui/components/card-render";
import { computeSmartSignals } from "@domain/filter/smart-signal";
import { scoreAllPlugins } from "@domain/recommend/engine";
import { setListState } from "@ui/dom/list-state";
import { q, toHTMLElement } from "@ui/dom/dom";
import type { ViewContext } from "@ui/view/view-context";
import { LAYOUT } from "@shared/constants";
import { requestIdle } from "@shared/platform";

export function renderPluginList(ctx: ViewContext, preserveScroll = false) {
		// 视图已卸载：不再渲染，避免对死 ctx 做无谓 DOM 工作
		if (ctx.disposed) return;
		// 对比模式下不渲染列表（列表被对比页面替换）
		if (ctx.compareMode) return;
		const query = ctx.searchQuery.trim();

		// Bug fix: 数据未加载时不渲染列表（避免显示"找到 0 个插件"的误导性计数）
		if (!ctx.dataLoaded && ctx.plugins.length === 0) return;

		// 查询为空时展示全量列表（按当前排序，默认热门）
		setListState(ctx, "list");

		// 离线智能信号：仅在插件数据变化时重算（避免每次按键全量 O(n log n)）
		ctx.recomputeSmartSignalsIfNeeded();

		// 过滤 + 排序管线（委托 filter.ts 纯函数）
		const filtered = ctx.runFilterPipeline(query);

		// 更新列表 chrome（结果计数、推荐区域等）
		ctx.updateListChrome(filtered);

		// ── S2 增量架构：列表身份未变 → 原地刷新 ──
		// 签名 = 模式 + 查询 + AI 空态标志 + 筛选状态 + 列表规模/首尾 id。
		// 签名一致说明"这是同一个列表"（典型：翻译到位后的 scheduleRender、数据 rev 同步），
		// 此时清空重建只会带来闪烁与回顶打扰——改为仅补渲染窗口 + 重测可见行高。
		// 轻量签名（长度 + 首尾 id）替代原先 filtered.map(id).join(",") 的 O(n) 长字符串分配，
		// 每帧渲染省一次 5617 个 id 的拼接；排序键显式纳入 filterState，保证排序变化仍被捕捉
		// （同一筛选 + 同一排序键下结果为确定性序列，首尾 id + 长度即可唯一标识）。
		const filterState =
			ctx.sourceFilter + "\u0000" + ctx.installFilter + "\u0000" +
			(ctx.sortFavoritesFirst ? "1" : "0") + "\u0000" +
			(ctx.recommendedOnly ? "1" : "0") + "\u0000" +
			(ctx.authorFilter ?? "") + "\u0000" +
			ctx.selectedCategories.join(",") + "\u0000" +
			ctx.sortBy;
		const listSig =
			filtered.length + ":" +
			(filtered[0]?.id ?? "") + ":" +
			(filtered[filtered.length - 1]?.id ?? "");
		const signature =
			ctx.searchMode + "\u0000" + query + "\u0000" + (ctx.aiSearchPending ? "1" : "0") +
			"\u0000" + filterState + "\u0000" + listSig + "\u0000" + String(ctx.smartSignalsRev);
		if (signature === ctx.lastListSignature && ctx.scrollCardLayer) {
			if (filtered.length === 0) {
				// 空态已在屏上且身份未变：不重建空态 DOM（消除闪烁）
				ctx.postRenderSync();
				return;
			}
		if (ctx.scrollCardLayer.childElementCount > 0) {
			// 列表身份未变：卡片已在 DOM，原生滚动自己管位移，无需重渲染（避免全量重绘闪烁/回顶）。
			ctx.postRenderSync();
			return;
		}
		}
		ctx.lastListSignature = signature;

		// 重置高度缓存 + 清空旧卡片 + 渲染窗口
		ctx.invalidateAndRender(preserveScroll);

		// 后渲染同步（懒翻译、AI 按钮、滚动按钮、作者横幅）
		ctx.postRenderSync();
	
}

export function recomputeSmartSignalsIfNeeded(ctx: ViewContext) {

		if (ctx.plugins.length > 0 && ctx.pluginsRev !== ctx.smartSignalsRev) {
			// 0) 趋势引擎水合：首次使用时从落盘历史恢复（跨会话累积才有真实增速）
			if (ctx.trendingEngine.isEmpty() && ctx.cachedTrendingHistory) {
				ctx.trendingEngine.load(ctx.cachedTrendingHistory);
			}
			// 1) 离线智能信号（top1/top5/hot10/recentActive/velocityRising badges）。
			// velocity 基线必须取「上一轮采样」（在 updateWithStats 之前快照）——
			// 修复 H1：曾把合并后的当前 statsMap 当 prevStats 传入，
			// 自己减自己永远得 0，velocityRising 信号从未点亮过。
			const prevStats = ctx.trendingEngine.lastSampleStats();
			ctx.smartSignals = computeSmartSignals(
				ctx.plugins,
				prevStats.size > 0 ? prevStats : undefined
			);
			ctx.smartSignalsRev = ctx.pluginsRev;

			// 2) 趋势评分（供 "trending" 排序模式使用）；
			// 仅在实际新增采样点时落盘历史（密集刷新去重，避免无谓 IO）
			if (ctx.trendingEngine.updateWithStats(ctx.statsMap)) {
				void ctx.saveTrendingHistory(ctx.trendingEngine.serialize());
			}
			const allIds = ctx.plugins.map((p) => p.id);
			ctx.trendingScores = ctx.trendingEngine.batchTrendingScores(allIds);

		// 3) 综合推荐评分（供 "recommended" 排序模式使用）
		// 注：用户行为亲和度信号（analytics）已移除，推荐退化为无个性化。
		ctx.recommendScores = scoreAllPlugins(ctx.plugins, {
			smartSignals: ctx.smartSignals,
			trendingScores: ctx.trendingScores,
			userAffinity: undefined,
		});

			// 4) 倒排索引（供相似推荐加速使用）
			const tagService = ctx.translator.tagService;
			if (tagService && ctx.plugins.length > 0) {
				const tagEntries = ctx.plugins.map((p) => {
					const tag = tagService.getTag(p.id);
					return tag ? { id: p.id, ...tag } : { id: p.id, category: "", tags: [] };
				});
				ctx.invertedIndex.build(tagEntries);
			}
		}
	}

export function runFilterPipeline(ctx: ViewContext, query: string) : PluginInfo[] {

		const filterResult = filterAndSortPlugins({
			plugins: ctx.plugins,
			searchMode: ctx.searchMode,
			query,
			sourceFilter: ctx.sourceFilter,
			installFilter: ctx.installFilter,
			authorFilter: ctx.authorFilter,
			recommendedOnly: ctx.recommendedOnly,
			recommendedSet: ctx.getRecommendedIds(),
			sortFavoritesFirst: ctx.sortFavoritesFirst,
			favoritesSet: ctx.favoritesSet,
			selectedCategories: ctx.selectedCategories.length ? ctx.selectedCategories : undefined,
			pluginTagMap: ctx.pluginTagMap,
			installedIds: ctx.installedIds,
			translatedResults: ctx.translatedResults,
			searchIndex: ctx.searchIndex,
			sortBy: ctx.sortBy,
			trendingScores: ctx.trendingScores,
			recommendScores: ctx.recommendScores,
			aiSearchResult: ctx.aiSearchResult,
			aiSearchQueryCache: ctx.aiSearchQueryCache,
			hasHistoryTranslation: (id, plugin) => ctx.translator.hasAnyTranslation(id, plugin),
			...ctx.filterCache.snapshot(),
		});
		// 回写缓存
		ctx.filterCache.sync(filterResult);
		// 非 AI 路径清空残留 AI 结果
		if (filterResult.clearAiResult) {
			ctx.aiSearchResult = null;
			ctx.aiSearchQueryCache = "";
		}
		ctx.visibleList = filterResult.list;
		ctx.focusedCardIdx = -1;
		return filterResult.list;
	
}

export function updateListChrome(ctx: ViewContext, filtered: PluginInfo[]) {

		ctx.renderFeaturedSection();
		// 计数可见性由 listState 派生（setListState），此处只更新文案
		if (ctx.resultCountEl) {
			const countText = `找到 ${filtered.length} 个`;
			ctx.resultCountEl.textContent = countText;
			ctx.announceStatus(countText);
		}
	
}

export function invalidateAndRender(ctx: ViewContext, preserveScroll: boolean) {

		// 架构重构（原生滚动 + content-visibility）：列表身份变化只需把卡片重排进正常流 grid，
		// 不再有 offsets / spacer / translateY。是否保留滚动位置交给浏览器原生滚动。
		// 列表身份/尺寸变化：布局参数失效，标脏让 renderWindow 路径按需重测一次（避免无谓 getComputedStyle/scrollHeight）。
		ctx.layoutDirty = true;
		ctx.measureLayout();
		if (ctx.scrollViewport && !preserveScroll) {
			ctx.scrollViewport.scrollTop = 0;
		}
		if (ctx.scrollCardLayer && !ctx.scrollCardLayer.classList.contains("pt-list-in")) {
			ctx.scrollCardLayer.classList.add("pt-list-in");
		}
		ctx.renderWindow();
}

// ───────── 列表渲染方案：固定高度 + 原生滚动 + content-visibility + 窗口化懒填充 ─────────
// 卡片高度由 CSS 锁死（.pt-card height: var(--pt-card-h)），每行高恒定（cardH + row-gap）。
// 列表把全部卡片 DOM 节点正常流入 CSS grid，由浏览器原生接管滚动位移——无 spacer / offsets
// / translateY / 窗口切片。屏外卡片靠 content-visibility:auto 折叠（不绘制不布局），
// 其卡片内容（applyCardState）延迟到进入可见窗口时才填充（pendingCards 机制），
// 把单次渲染的「内容填充」成本控制在 O(可见窗口) 而非 O(全量 N)，消除筛选放大列表时的卡顿。
// 早期「动态行高 + 后台预热 + 跨重载行高缓存 + 滚动锚定」等机制已废弃（见 translator-view.ts 字段清理）。

export function postRenderSync(ctx: ViewContext) {

		// 懒翻译（滚动/后渲染自动翻可见窗口）已废弃：翻译仅由用户点单卡「翻译」按钮触发，
		// 不再自动预翻译。这里只做 UI 同步态刷新。
		ctx.updateAiTranslateButton();
		ctx.updateScrollButtons();
		ctx.updateAuthorBanner();

}

export function refreshCardState(ctx: ViewContext, pluginId: string) {

		// 必须 CSS.escape：插件 id 可能含引号等特殊字符，直接内插会抛 SyntaxError 中断刷新
		const card = toHTMLElement(
			ctx.scrollCardLayer?.querySelector(`.pt-card[data-plugin-id="${CSS.escape(pluginId)}"]`) ?? null
		);
		if (!card) return;
		// 更新收藏态
		card.classList.toggle("is-favorited", ctx.favoritesSet.has(pluginId));
		// 更新对比态
		const compareIcon = q(card, "[data-action='compare']");
		compareIcon?.classList.toggle("is-compare-on", ctx.compareSet.has(pluginId));
	
}

/**
 * 计算当前可见窗口在 visibleList 中的索引区间 [start, end)（含上下各 PREFETCH_ROWS 行预取余量）。
 * 只翻译窗口内未译项，避免一次性把整张 5617 列表送翻：
 *   - 省网络请求，且避开 MyMemory/腾讯免费接口的限流（限流反而让可见卡译不出）
 *   - 屏外卡片根本没绘制，其 refreshCardTranslation 是空操作，翻译纯浪费
 * 供 renderWindow / fillVisibleWindow（卡片内容懒填充）复用。
 * 退化条件（缺视口 / 列数 / 行高未知）下回退 [0, total)，保证不漏译 / 不空白。
 */
function computeVisibleWindowRange(ctx: ViewContext): { start: number; end: number } {
	const vp = ctx.scrollViewport;
	const layer = ctx.scrollCardLayer;
	const total = ctx.visibleList.length;
	if (!vp || !layer || !ctx.colCount || total === 0) return { start: 0, end: total };
	// 优先用缓存行高，避免每帧 getComputedStyle 触发样式/布局回流（缓存未就绪时降级读取一次）。
	let rowH = ctx.cachedRowH;
	if (rowH <= 0) {
		const cardH = parseFloat(getComputedStyle(layer).getPropertyValue("--pt-card-h")) || LAYOUT.DEFAULT_ROW_H;
		const rowGap = parseFloat(getComputedStyle(layer).rowGap) || 0;
		rowH = cardH + rowGap;
	}
	if (rowH <= 0) return { start: 0, end: total };
	// #4: 速度自适应预取。慢速滚动只预取 1 行（省填充成本），快速甩动时预取 3~5 行
	// 保证窗口边缘不空白（滚动快时用户会快速越过缓冲区）。静止/初始（速度 0）回退到 LAYOUT 默认。
	const v = ctx.scrollVelocity;
	const PREFETCH_ROWS = v > 0
		? (v < 500 ? 1 : v < 2000 ? 3 : 5)
		: LAYOUT.PREFETCH_ROWS;
	// 复用纯函数（#3 虚拟滚动数学），与 spacer 高度计算同源
	const win = computeWindowRange(vp.scrollTop, vp.clientHeight, rowH, ctx.colCount, total, PREFETCH_ROWS);
	return { start: win.start, end: win.end };
}

/**
 * 卸载时清理当前视图的渲染状态：行高缓存。
 * 这些是 per-view 状态（挂在 ctx 上），视图关闭时显式清理，避免对已销毁 ctx 的幽灵写盘。
 */
export function disposeRenderTimers(ctx: ViewContext): void {
	ctx.cachedRowH = 0;
}

export function scheduleRender(ctx: ViewContext, preserveScroll = false) {

		if (ctx.renderRAF) return;
		ctx.renderRAF = window.requestAnimationFrame(() => {
			ctx.renderRAF = 0;
			ctx.renderPluginList(preserveScroll);
		});
	
}

// 行高（卡片高 + 行距）缓存：--pt-card-h / 行距是固定值，缓存后避免每帧 getComputedStyle 触发样式/布局回流。
// 在 measureLayout（首渲染 + 尺寸变化）时刷新。缓存挂在 ctx.cachedRowH（per-view，见 ViewContext）。
export function measureLayout(ctx: ViewContext) {

	const viewport = ctx.scrollViewport;
	const layer = ctx.scrollCardLayer;
	if (!viewport || !layer) return;

	const minCardW = LAYOUT.MIN_CARD_W;
	const padX = LAYOUT.GRID_PAD_X; // 左右 padding 合计（--pt-space-xs * 2）
	const cols = computeColCount(viewport.clientWidth - padX, minCardW);

	// 架构重构（原生滚动）：列数变化即同步 grid 列模板，并按内容比例保留阅读位置，
	// 不再有 offsets / 锚定补偿 / 防抖重排。
	const sh = viewport.scrollHeight;
	// 刷新 scrollHeight 缓存：内容/列数变化即失效，updateScrollButtons 每帧复用避免强制重排。
	ctx.cachedScrollHeight = sh;
	const ratio = sh > 0 ? viewport.scrollTop / sh : 0;
	const gapVal = parseFloat(getComputedStyle(layer).rowGap) || 0;
	if (gapVal > 0) ctx.rowGap = gapVal;
	// 刷新行高缓存（卡片高固定 + 当前行距），供滚动时可见窗口计算复用。
	const cardH = parseFloat(getComputedStyle(layer).getPropertyValue("--pt-card-h")) || LAYOUT.DEFAULT_ROW_H;
	ctx.cachedRowH = cardH + (gapVal || ctx.rowGap || 0);
	ctx.colCount = cols;
	const tmpl = `repeat(${cols}, 1fr)`;
	if (layer.style.gridTemplateColumns !== tmpl) layer.setCssStyles({ gridTemplateColumns: tmpl });
	if (ratio > 0) {
		window.requestAnimationFrame(() => {
			if (viewport && viewport.scrollHeight > 0) {
				viewport.scrollTop = ratio * viewport.scrollHeight;
			}
		});
	}
	ctx.layoutDirty = false;

}

// 幂等测量：仅当布局参数失效（尺寸/列数变化、首次渲染）时重测，避免每次 renderWindow 无谓触发
// getComputedStyle / scrollHeight 强制重排。invalidateAndRender 与 ResizeObserver 负责标脏。
export function measureLayoutIfNeeded(ctx: ViewContext) {
	if (!ctx.layoutDirty) return;
	measureLayout(ctx);
}

// 滚动实时诊断开关（开发者命令 toggles）。架构重构后为兼容既有命令保留，
// 原生滚动下不再需要逐帧采样，置位即为空操作。
export function setScrollDebug(_on: boolean) {
	// 原生滚动下 no-op
}

export function renderWindow(ctx: ViewContext, _opts?: { measure?: boolean }) {

	const layer = ctx.scrollCardLayer;
	if (!layer) return;
	if (!ctx.scrollViewport) return;

		const total = ctx.visibleList.length;

		// 空状态
		if (total === 0) {
			// 数据未加载完成：保留加载动画，不要用「暂无数据」覆盖。
			if (!ctx.dataLoaded) return;
			// 非列表态一律不覆盖：引导 / 加载 / 错误 / AI 等待 / AI 配置引导
			// 已各自渲染在 layer 中，滚动/measure 触发的 renderWindow
			// 不应把它们换成通用空态文案（旧守卫只挡引导态，AI 配置页可被覆盖）。
			if (ctx.listState !== "list") return;
			// AI 搜索进行中：显示醒目加载提示（P2-4：提升空态可见性）
			if (ctx.aiSearchPending) {
				layer.empty();
				ctx.cardById.clear(); // 清层后持久化索引失效，整体清空
				ctx.windowStart = -1; ctx.windowEnd = -1; // 清层后窗口守卫失效，防下次误跳过
				const loading = layer.createDiv({ cls: "pt-empty pt-ai-loading-state" });
				loading.createDiv({ cls: "pt-empty-icon" });
				loading.createDiv({ cls: "pt-empty-title", text: ctx.t("notice.ai.analyzing") });
				loading.createDiv({ cls: "pt-empty-hint", text: ctx.t("notice.ai.analyzing.hint") });
				return;
			}
			layer.empty();
			ctx.cardById.clear(); // 清层后持久化索引失效，整体清空
			ctx.windowStart = -1; ctx.windowEnd = -1; // 清层后窗口守卫失效，防下次误跳过
			const empty = layer.createDiv({ cls: "pt-empty" });
			empty.createDiv({ cls: "pt-empty-icon" });
			const hasQuery = !!ctx.searchQuery;
			// 空态文案与「清除筛选」按钮可见性委托给 filter.ts 的纯函数（含 bug #3 回归锁死）
			const emptyState = resolveEmptyState({
				hasQuery,
				searchMode: ctx.searchMode,
				aiSearchResult: ctx.aiSearchResult,
				sourceFilter: ctx.sourceFilter,
				installFilter: ctx.installFilter,
				hasAIKey: ctx.settings.aiSearchEnabled && !!ctx.settings.aiSearchApiKey,
				_query: ctx.searchQuery,
			});
			empty.createDiv({ cls: "pt-empty-title", text: ctx.t(emptyState.titleKey) });
			empty.createDiv({ cls: "pt-empty-hint", text: ctx.t(emptyState.hintKey) });
			// UX: 空状态提供「清除筛选」快捷恢复按钮
			if (emptyState.showClearAction) {
				const clearAction = empty.createEl("button", {
					cls: "pt-guide-chip pt-empty-clear",
					text: ctx.t("empty.clearAction"),
				});
				clearAction.addEventListener("click", () => {
					const input = toHTMLElement(ctx.contentEl.querySelector(".pt-search-input"), HTMLInputElement);
					if (input) { input.value = ""; }
					ctx.searchQuery = "";
					ctx.sourceFilter = "all";
					ctx.installFilter = "all";
					ctx.recommendedOnly = false;
					ctx.settings.sourceFilter = "all";
					void ctx.saveSettings();
					// 同步 UI 状态
					ctx.contentEl.querySelectorAll(".pt-filter").forEach((el) => {
						el.setAttribute("aria-pressed", "false");
					});
					const allBtn = q(ctx.contentEl, ".pt-source-filters .pt-filter[data-value='all']");
					if (allBtn) allBtn.setAttribute("aria-pressed", "true");
				const toggle = q(ctx.contentEl, ".pt-toggle-uninstalled");
				if (toggle) {
					toggle.setAttribute("aria-pressed", "false");
					toggle.textContent = "仅显示已安装";
				}
					const clearBtn = q(ctx.contentEl, ".pt-search-clear");
					if (clearBtn) clearBtn.setCssStyles({ display: "none" });
					ctx.scheduleRender();
				});
			}
			// 跨模式搜索桥接：当前模式结果为空时建议切换到另一模式
			if (emptyState.bridgeAction) {
				const bridgeBtn = empty.createEl("button", {
					cls: "pt-guide-chip pt-guide-chip--bridge",
					text: ctx.t(emptyState.bridgeAction.labelKey),
				});
				const targetMode = emptyState.bridgeAction.mode;
				bridgeBtn.addEventListener("click", () => {
					// 切换模式下拉
					const modeSelect = toHTMLElement(
						ctx.contentEl.querySelector(".pt-search-mode"),
						HTMLSelectElement
					);
					if (modeSelect) {
						modeSelect.value = targetMode;
						modeSelect.dispatchEvent(new Event("change", { bubbles: true }));
					}
				});
			}
			return;
		}

		// ── #3 真·虚拟滚动：仅渲染「可见窗口 + 预取余量」卡片（DOM 节点数稳定 ≤250）──
		// 由 top/bottom spacer 撑出整张列表总高，窗口内卡片正常流入 grid 由浏览器原生接管滚动；
		// 屏外卡片根本不入 DOM（而非 content-visibility 折叠），内存 / querySelectorAll / 样式重算
		// 均从 O(N=5600+) 降到 O(窗口)，移动端不再被全量常驻 DOM 拖垮。
		// 卡片池（cardPool）+ 持久化索引（cardById）+ 懒填充（pendingCards）全部复用，
		// 滚动仅做增量换入换出（见 updateWindow），避免频繁 create/destroy。
		ctx.measureLayoutIfNeeded();

		// 全量重渲路径（列表身份变化）：回收旧卡片、清空索引，再重建窗口
		for (const [, card] of ctx.cardById) {
			ctx.cardPool.push(card);
		}
		ctx.cardById.clear();
		ctx.pendingCards.clear();
		// 清掉遗留的非卡片节点（空态 / 引导占位 / spacer）
		layer.empty();

		const renderCtx = makeCardRenderCtx(ctx);
		// 首次渲染标记（用于入场动画，仅加一次）
		const firstPaint = !layer.classList.contains("pt-list-in");

		// 构造上/下 spacer（grid 跨所有列，撑出总高让窗口卡落在正确滚动位置）
		const spacerTop = createDiv({ cls: "pt-list-spacer pt-list-spacer-top" });
		const spacerBottom = createDiv({ cls: "pt-list-spacer pt-list-spacer-bottom" });
		layer.appendChild(spacerTop);
		layer.appendChild(spacerBottom);

		// 关键：全量重建前必须让窗口守卫失效（设为 -1），否则 updateWindowImpl 的
		// windowStart/End 守卫会因「上次窗口与本次相同」而直接 return，
		// 导致 layer 只剩两个空 spacer、一张卡片都不渲染 → 白屏。
		ctx.windowStart = -1;
		ctx.windowEnd = -1;

		// 填充窗口（结构 + 内容骨架），并补完内容填充
		updateWindowImpl(ctx, renderCtx);

		if (firstPaint) layer.classList.add("pt-list-in");

		// 补完：当前可见窗口内若有 pending 卡片，立即填充（≤20/帧 + 空闲续填）
		fillVisibleWindow(ctx);
}

/**
 * #3 虚拟滚动：增量窗口化（滚动监听调用）。
 * 仅根据当前滚动位置换入/换出窗口内卡片，DOM 节点数稳定在 ≤250。
 * 窗口未越界时直接跳过（windowStart/End 守卫），滚动静止不重排。
 * 离开窗口的卡片回收入池（脱离 DOM），进入窗口的卡片从池复用并懒填充，
 * 复用现有 cardById / pendingCards 体系，避免频繁 create/destroy。
 */
export function updateWindow(ctx: ViewContext): void {
	const layer = ctx.scrollCardLayer;
	if (!layer) return;
	if (!ctx.scrollViewport) return;
	ctx.measureLayoutIfNeeded();
	const renderCtx = makeCardRenderCtx(ctx);
	updateWindowImpl(ctx, renderCtx);
	fillVisibleWindow(ctx);
}

/**
 * 窗口化渲染核心：基于 computeVisibleWindowRange 计算 [start,end)，
 * 回收窗口外卡片、确保窗口内卡片在场（池化复用 + data-fill-pending 登记懒填充），
 * 更新上/下 spacer 高度，最后以 [spacerTop, ...窗口卡, spacerBottom] 顺序重写 layer 子节点。
 * 纯结构操作（不触发 applyCardState），内容填充交给 fillVisibleWindow 的帧预算分片。
 */
function updateWindowImpl(ctx: ViewContext, renderCtx: CardRenderContext): void {
	const layer = ctx.scrollCardLayer;
	const vp = ctx.scrollViewport;
	if (!layer || !vp || ctx.visibleList.length === 0) return;

	const total = ctx.visibleList.length;
	const win = computeVisibleWindowRange(ctx);
	// 窗口未越界：跳过整轮重写（滚动静止 / 窗口内微动不重排）
	if (win.start === ctx.windowStart && win.end === ctx.windowEnd) return;
	ctx.windowStart = win.start;
	ctx.windowEnd = win.end;

	// ── 1. 回收窗口外卡片（脱离 DOM + 回收入池 + 清理索引/pending）──
	for (const [id, card] of ctx.cardById) {
		if (card === undefined) continue;
		if (!isInWindow(card, win.start, win.end)) {
			ctx.cardPool.push(card);
			ctx.pendingCards.delete(card);
			ctx.cardById.delete(id);
		}
	}

	// ── 2. 确保窗口内卡片在场（池化复用 + 标记 pending 懒填充）──
	const seen = new Set<string>();
	for (let i = win.start; i < win.end; i++) {
		const plugin = ctx.visibleList[i];
		if (!plugin) continue;
		const id = plugin.id;
		seen.add(id);
		let card = ctx.cardById.get(id);
		if (!card) {
			// 从池取（节点可能残留旧插件内容，必填 pending 待 fillVisibleWindow 覆盖）或新建
			card = ctx.cardPool.pop() ?? createCardElement(ctx.cardPoolCtx ?? renderCtx);
			card.setAttribute("data-plugin-id", id);
			card.setAttribute("data-fill-pending", "1");
			ctx.cardById.set(id, card);
			ctx.pendingCards.add(card);
		}
		card.setAttribute("data-idx", String(i));
	}

	// ── 3. 计算 spacer 高度（撑出总高，使窗口卡落在正确滚动位置）──
	const rowH = ctx.cachedRowH > 0 ? ctx.cachedRowH : (LAYOUT.DEFAULT_ROW_H + ctx.rowGap);
	const pureWin = computeWindowRange(
		vp.scrollTop, vp.clientHeight, rowH, ctx.colCount, total,
		ctx.scrollVelocity > 0 ? (ctx.scrollVelocity < 500 ? 1 : ctx.scrollVelocity < 2000 ? 3 : 5) : LAYOUT.PREFETCH_ROWS,
	);
	const { top, bottom } = computeSpacerHeights(pureWin, rowH);
	// 确保 spacer 存在（renderWindow 已建；兜底：缺失时补建，避免空引用）
	let spacerTop = q(layer, ".pt-list-spacer-top");
	let spacerBottom = q(layer, ".pt-list-spacer-bottom");
	if (!spacerTop) { spacerTop = createDiv({ cls: "pt-list-spacer pt-list-spacer-top" }); }
	if (!spacerBottom) { spacerBottom = createDiv({ cls: "pt-list-spacer pt-list-spacer-bottom" }); }
	spacerTop.setCssStyles({ height: `${top}px` });
	spacerBottom.setCssStyles({ height: `${bottom}px` });

	// ── 4. 按索引顺序重写 layer 子节点：[spacerTop, ...窗口卡, spacerBottom] ──
	// 复用同一批节点引用（不重建），仅调整其在 DOM 中的顺序与数量，避免闪烁/重排抖动。
	const fragment = createFragment();
	for (let i = win.start; i < win.end; i++) {
		const id = ctx.visibleList[i]?.id;
		if (!id) continue;
		const card = ctx.cardById.get(id);
		if (card) fragment.appendChild(card);
	}
	layer.replaceChildren(spacerTop, fragment, spacerBottom);
}

/** 卡片的 data-idx 是否落在窗口 [start,end) 内 */
function isInWindow(card: HTMLElement, start: number, end: number): boolean {
	const di = parseInt(card.getAttribute("data-idx") || "-1", 10);
	return di >= start && di < end;
}

/** 构造卡片渲染上下文（renderWindow 与 fillVisibleWindow 共用，避免重复） */
function makeCardRenderCtx(ctx: ViewContext): CardRenderContext {
	return {
		t: ctx.t,
		installedIds: ctx.installedIds,
		enabledIds: ctx.enabledIds,
		aiSearchResult: ctx.aiSearchResult,
		compareSet: ctx.compareSet,
		favoritesSet: ctx.favoritesSet,
		smartSignals: ctx.smartSignals,
		recommendedIds: ctx.getRecommendedIds(),
		// 固定卡片高度：描述展开不改变行高，无需重排整列 → 空实现
		onDescToggle: () => {},
		// 「🍎 系统翻译」成功 → 落库沉淀（cache + tmApproved），下次直接命中复用
		onSysTranslatePersist: (pid, name, desc) => {
			ctx.translator.persistSystemTranslation(pid, name, desc);
			ctx.saveTranslatorData();
		},
	};
}

/**
 * 填充进入可见窗口的 pending 卡片（renderWindow 窗口化懒填充的补完）。
 * 滚动 / 尺寸变化 / 筛选重渲后调用：仅对窗口内仍 pending 的卡片执行 applyCardState，
 * 把内容填充成本控制在 O(可见窗口)，且 pending 集合为空时直接短路返回。
 * content-visibility:auto 已让屏外卡片不绘制，故未填充的 pending 卡片对用户不可见。
 */
export function fillVisibleWindow(ctx: ViewContext): void {
	const pending = ctx.pendingCards;
	if (pending.size === 0) return;
	const layer = ctx.scrollCardLayer;
	if (!layer) { pending.clear(); return; }
	const { start, end } = computeVisibleWindowRange(ctx);
	if (start >= end) return;
	const renderCtx = makeCardRenderCtx(ctx);
	const filled: HTMLElement[] = [];
	// #4: 单帧预算控制。窗口内 pending 卡片 ≤20 时一帧填完；超过则先填 20 张，
	// 剩余挂入 requestIdleCallback 分帧填充，避免 5600 项快速滚动时单帧超 16ms。
	const MAX_PER_FRAME = 20;
	let count = 0;
	for (const card of pending) {
		if (count >= MAX_PER_FRAME) break;
		const di = parseInt(card.getAttribute("data-idx") || "-1", 10);
		if (di < start || di >= end) continue; // 仍屏外
		const plugin = ctx.visibleList[di];
		if (!plugin || plugin.id !== card.getAttribute("data-plugin-id")) continue;
		applyCardState(card, plugin, ctx.translatedResults[plugin.id], renderCtx);
		card.removeAttribute("data-fill-pending");
		filled.push(card);
		count++;
	}
	for (const card of filled) pending.delete(card);
	// 窗口内仍有未填卡（本次超预算）→ 空闲期续填，不阻塞当前帧
	if (pending.size > 0 && ctx.fillIdleHandle === null) {
		const runIdle = () => {
			ctx.fillIdleHandle = null;
			if (ctx.disposed) return; // 视图已卸载：放弃幽灵写盘
			fillVisibleWindow(ctx);
		};
		ctx.fillIdleHandle = requestIdle(runIdle, 100);
	}
}

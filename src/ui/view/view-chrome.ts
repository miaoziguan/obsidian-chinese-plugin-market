/**
 * 顶部工具栏（chrome）。
 *
 * 搜索框、排序切换、筛选栏（安装/收藏/推荐/作者/来源）、分类 Tab 与
 * 语言切换等静态 UI 与交互绑定。
 */

import { type I18nKey } from "@shared/i18n";
import { isMobileEnvironment } from "@shared/platform";
import { logger } from "@shared/logger";
import { setListState } from "@ui/dom/list-state";
import { isAIMode, isKeywordMode } from "@domain/search/search-mode";
import { q, appendSVG } from "@ui/dom/dom";
import type { ViewContext } from "@ui/view/view-context";
import { buildToolbar, alignFacetLabels, type ToolbarState } from "@ui/view/view-toolbar";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { LAYOUT } from "@shared/constants";
import { setIcon } from "obsidian";

export function showSearchGuide(ctx: ViewContext) {

		const layer = ctx.scrollCardLayer;
		if (!layer) return;
		setListState(ctx, "guide");

		layer.empty();
		ctx.cardById.clear(); // 清层后持久化卡片索引失效
		// 模式引导行：渲染在列表区顶部（而非 header 中），避免与工具栏视觉混淆
		ctx.guidanceEl = layer.createDiv({ cls: "pt-mode-guidance pt-mode-guidance--in-list" });
		ctx.updateGuidance();
		const empty = layer.createDiv({ cls: "pt-empty pt-search-guide" });
		empty.createDiv({ cls: "pt-empty-icon" });
		empty.createDiv({
			cls: "pt-empty-title",
			text: ctx.t("guide.title"),
		});
		empty.createDiv({
			cls: "pt-empty-hint",
			text: ctx.t("guide.hint"),
		});
		// 示例词：点击即填入搜索框并触发搜索，降低首屏冷启动门槛
		const examples = ["思维导图", "日历", "同步", "日程", "图表"];
		const chips = empty.createDiv({ cls: "pt-guide-examples" });
		chips.createSpan({ cls: "pt-guide-examples-label", text: ctx.t("guide.examples") });
		for (const ex of examples) {
			const chip = chips.createEl("button", {
				cls: "pt-guide-chip",
				text: ex,
			});
			chip.addEventListener("click", () => {
			const input = q<HTMLInputElement>(ctx.contentEl, ".pt-search-input");
				if (!input) return;
				input.value = ex;
				input.focus();
				input.classList.add("pt-search-flash");
				input.closest?.(".pt-search")?.addClass("pt-search--flash");
				window.setTimeout(() => {
					input.classList.remove("pt-search-flash");
					input.closest?.(".pt-search")?.removeClass("pt-search--flash");
				}, LAYOUT.SEARCH_FLASH_MS);
				// 跳过 200ms debounce，立即触发搜索（含懒加载 + loading 反馈），
				// 让用户点击示例词后立刻看到"加载中"而非静止 200ms。
				ctx.applySearchInput();
			});
		}
		// 对比功能发现提示（一次性引导后仍可在此处看到入口提示）
		empty.createDiv({
			cls: "pt-guide-compare-hint",
			text: ctx.t("compare.discover"),
		});
	
}

export function showAIPendingHint(ctx: ViewContext) {

		const layer = ctx.scrollCardLayer;
		if (!layer) return;
		setListState(ctx, "aiPending");

		layer.empty();
		ctx.cardById.clear(); // 清层后持久化卡片索引失效
		const hint = layer.createDiv({ cls: "pt-empty pt-ai-pending" });
		hint.createDiv({ cls: "pt-empty-icon" });
		hint.createDiv({
			cls: "pt-empty-title",
			text: ctx.t("ai.pending.title"),
		});
		hint.createDiv({
			cls: "pt-empty-hint",
			text: ctx.t("ai.pending.hint"),
		});
		// 3b: AI 模式示例词——点击即填入并触发 AI 语义搜索，降低冷启动门槛
		const aiExamples = ["做思维导图的插件", "管理日程和待办", "同步笔记到云端", "美化界面主题"];
		const aiChips = hint.createDiv({ cls: "pt-guide-examples" });
		aiChips.createSpan({ cls: "pt-guide-examples-label", text: ctx.t("guide.examples") });
		for (const ex of aiExamples) {
			const chip = aiChips.createEl("button", { cls: "pt-guide-chip", text: ex });
			chip.addEventListener("click", () => {
			const input = q<HTMLInputElement>(ctx.contentEl, ".pt-search-input");
			const badge = q(ctx.contentEl, ".pt-ai-badge");
				if (!input || !badge) return;
				input.value = ex;
				input.classList.add("pt-search-flash");
				input.closest?.(".pt-search")?.addClass("pt-search--flash");
				window.setTimeout(() => {
					input.classList.remove("pt-search-flash");
					input.closest?.(".pt-search")?.removeClass("pt-search--flash");
				}, LAYOUT.SEARCH_FLASH_MS);
				ctx.searchQuery = ex;
				const clearBtn = q(ctx.contentEl, ".pt-search-clear");
				if (clearBtn) clearBtn.setCssStyles({ display: "" });
				void ctx.runAISearch(input, badge);
			});
		}
	
}

export function showAIConfigGuide(ctx: ViewContext, reason: "disabled" | "noKey") {

		const layer = ctx.scrollCardLayer;
		if (!layer) return;
		setListState(ctx, "aiConfig");

		layer.empty();
		ctx.cardById.clear(); // 清层后持久化卡片索引失效
		const guide = layer.createDiv({ cls: "pt-empty pt-ai-config-guide" });
		guide.createDiv({ cls: "pt-empty-icon" });
		guide.createDiv({
			cls: "pt-empty-title",
			text: reason === "disabled"
				? "AI 语义搜索未开启"
				: "未配置 API Key",
		});
		guide.createDiv({
			cls: "pt-empty-hint",
			text: reason === "disabled"
				? "请在插件设置 → 高级设置 → AI 智能搜索 中开启「启用 AI 智能搜索」，即可用自然语言搜索插件。"
				: "请在插件设置 → 高级设置 → AI 智能搜索 中填写 API Key（支持 DeepSeek / 通义千问 / 智谱等 OpenAI 兼容接口）。",
		});
		// 提供快捷入口：打开设置面板
		const openSettingsBtn = guide.createEl("button", {
			cls: "pt-guide-chip",
			text: "打开设置",
		});
		openSettingsBtn.addEventListener("click", () => {
			asAppInternals(ctx.app).setting?.openTabById?.(ctx.manifest.id);
		});
	
}

export function showLoadingState(ctx: ViewContext, message: string) {

		const layer = ctx.scrollCardLayer;
		if (!layer) return;
		setListState(ctx, "loading");

		layer.empty();
		ctx.cardById.clear(); // 清层后持久化卡片索引失效
		const loading = layer.createDiv({ cls: "pt-empty pt-loading" });
		loading.createDiv({ cls: "pt-loading-spinner" });
		loading.createDiv({ cls: "pt-empty-title", text: ctx.t("app.loading") });
		loading.createDiv({ cls: "pt-empty-hint", text: message });
	
}

export function updateStats(ctx: ViewContext) {

		const stats = q(ctx.containerEl, ".pt-stats");
		if (!stats) return;
		stats.setCssStyles({ display: "" });
	const total = ctx.plugins.length;
	stats.empty();
	stats.createSpan({ cls: "pt-stat", text: `共 ${total}` });
	
}

export function applyAIConfig(ctx: ViewContext) {

		const s = ctx.settings;
		if (s.aiSearchEnabled && s.aiSearchApiKey) {
			ctx.translator.setAIConfig({
				baseURL: s.aiSearchBaseURL,
				apiKey: s.aiSearchApiKey,
				model: s.aiSearchModel,
			});
		} else {
			ctx.translator.setAIConfig(null);
		}
	
}

export function updateGuidance(ctx: ViewContext) {

		if (!ctx.guidanceEl) return;
		const hasQuery = ctx.searchQuery.trim().length > 0;
		if (hasQuery) {
			ctx.guidanceEl.setCssStyles({ display: "none" });
			return;
		}
		const key = `mode.guidance.${ctx.searchMode}` as I18nKey;
		ctx.guidanceEl.textContent = ctx.t(key);
		ctx.guidanceEl.setCssStyles({ display: "" });
	
}

export function updateFacetVisibility(ctx: ViewContext) {

		const showCat = isAIMode(ctx) || isKeywordMode(ctx);
		const showAuthor = (isAIMode(ctx) || isKeywordMode(ctx)) && ctx.authorFacetList.reduce((n, g) => n + g.authors.length, 0) > 0;
		if (ctx.facetContainerEl) {
			ctx.facetContainerEl.setCssStyles({ display: showCat || showAuthor ? "" : "none" });
		}
		if (ctx.catRowEl) ctx.catRowEl.setCssStyles({ display: showCat ? "" : "none" });
	if (ctx.authorRowEl) ctx.authorRowEl.setCssStyles({ display: showAuthor ? "" : "none" });

	// 重置按钮状态反馈：有任何筛选激活时高亮，让用户一眼知道「可以清空」
	const resetBtn = q(ctx.contentEl, ".pt-toolbar-reset--inline");
	if (resetBtn) {
		const hasActive =
			ctx.sourceFilter !== "all" ||
			ctx.selectedCategories.length > 0 ||
			ctx.authorFilter !== null ||
			ctx.installFilter === "installed" ||
			ctx.favoriteFilter;
		resetBtn.classList.toggle("is-active", hasActive);
	}

	// 兜底：JS 强制统一所有 facet 标签列宽，保证多行标签左缘严格对齐。
	// 即便 CSS 解析失败或被主题覆盖，此处按实测最大宽度重排，杜绝"差一大截"。
	window.requestAnimationFrame(() => alignFacetLabels(ctx.contentEl));

	// 同步活跃筛选条件 chips（面板收起时仍可见当前生效的筛选）
	renderActiveFilters(ctx);
}

/**
 * 活跃筛选条件常驻 chips：筛选面板收起后，用户仍能在搜索行下方看到
 * 当前生效的筛选（来源 / 分类 / 安装 / 作者），并可单独 ✕ 移除。
 * 解决「隐藏状态」反模式——尤其 sourceFilter 持久化后，重启列表莫名变少却无任何可见提示。
 * 由 updateFacetVisibility 末统一调用，覆盖所有筛选变更路径（来源/安装点击、分类/作者 toggle、reset、模式切换）。
 */
export function renderActiveFilters(ctx: ViewContext) {
	const header = q(ctx.contentEl, ".pt-header");
	if (!header) return;
	// 懒创建容器：插在搜索行之后、高级筛选面板之前
	let box = q(ctx.contentEl, ".pt-active-filters");
	if (!box) {
		box = header.createDiv({ cls: "pt-active-filters" });
		const anchor = q(ctx.contentEl, ".pt-advanced");
		if (anchor && anchor !== box) header.insertBefore(box, anchor);
	}
	box.empty();

	// 收集活跃条件（与 updateFacetVisibility 的 hasActive 判定保持一致）
	const chips: { text: string; onClear: () => void }[] = [];

	if (ctx.sourceFilter !== "all") {
		const label = ctx.t(`settings.prefs.sourceFilter.${ctx.sourceFilter}` as I18nKey);
		chips.push({
			text: ctx.t("filter.active.source", { value: label }),
			onClear: () => {
				ctx.sourceFilter = "all";
				ctx.settings.sourceFilter = "all";
				void ctx.saveSettings();
				ctx.contentEl.querySelectorAll(".pt-source-filters .pt-filter").forEach((el) => {
					el.setAttribute("aria-pressed", (el as HTMLElement).dataset.value === "all" ? "true" : "false");
				});
				ctx.updateFacetVisibility();
				ctx.scheduleRender();
			},
		});
	}

	if (ctx.installFilter === "installed") {
		chips.push({
			text: ctx.t("filter.active.installed"),
			onClear: () => {
				ctx.installFilter = "all";
				const t = q(ctx.contentEl, ".pt-toggle-uninstalled");
				if (t) {
					t.setAttribute("aria-pressed", "false");
					t.textContent = "仅显示已安装";
				}
				ctx.updateFacetVisibility();
				ctx.scheduleRender();
			},
		});
	}

	if (ctx.favoriteFilter) {
		chips.push({
			text: ctx.t("filter.active.favorites"),
			onClear: () => {
				ctx.favoriteFilter = false;
				const t = q(ctx.contentEl, ".pt-toggle-favorites");
				if (t) {
					t.setAttribute("aria-pressed", "false");
					t.textContent = "仅看收藏";
				}
				ctx.updateFacetVisibility();
				ctx.scheduleRender();
			},
		});
	}

	for (const cat of ctx.selectedCategories) {
		chips.push({
			text: ctx.t("filter.active.category", { value: cat }),
			onClear: () => {
				const idx = ctx.selectedCategories.indexOf(cat);
				if (idx >= 0) ctx.selectedCategories.splice(idx, 1);
				const chip = q(ctx.contentEl, `.pt-facet-chip[data-cat="${CSS.escape(cat)}"]`);
				if (chip) chip.setAttribute("aria-pressed", "false");
				ctx.updateFacetVisibility();
				ctx.scheduleRender();
			},
		});
	}

	if (ctx.authorFilter) {
		chips.push({
			text: ctx.t("filter.active.author", { value: ctx.authorFilter }),
			onClear: () => {
				ctx.authorFilter = null;
				ctx.updateAuthorBanner();
				ctx.renderAuthorFacet();
				ctx.updateFacetVisibility();
				ctx.scheduleRender();
			},
		});
	}

	if (chips.length === 0) {
		box.setCssStyles({ display: "none" });
		return;
	}
	box.setCssStyles({ display: "" });
	const labelEl = box.createSpan({ cls: "pt-active-filters-label" });
	setIcon(labelEl, "filter");
	labelEl.appendText(ctx.t("filter.active.label"));
	for (const c of chips) {
		const chip = box.createSpan({ cls: "pt-active-chip" });
		// 把 "翻译：从未翻译" 拆成 key/value 两段，视觉层次更清晰
		const sepIdx = c.text.indexOf("：");
		if (sepIdx >= 0) {
			chip.createSpan({ cls: "pt-active-chip-key", text: c.text.slice(0, sepIdx) });
			chip.createSpan({ cls: "pt-active-chip-sep", text: "·" });
			chip.createSpan({ cls: "pt-active-chip-value", text: c.text.slice(sepIdx + 1) });
		} else {
			chip.createSpan({ cls: "pt-active-chip-value", text: c.text });
		}
		const x = chip.createEl("button", {
			cls: "pt-active-chip-clear",
			attr: { type: "button", "aria-label": ctx.t("filter.active.clear"), title: ctx.t("filter.active.clear") },
		});
		setIcon(x, "x");
		x.addEventListener("click", c.onClear);
	}
}

export function announceStatus(ctx: ViewContext, message: string) {

		const el = q(ctx.containerEl, ".pt-sr-only");
		if (el) el.textContent = message;
	
}

export function updateScrollButtons(ctx: ViewContext) {

		const vp = ctx.scrollViewport;
		if (!vp) return;
	// S3 读写分离：一次性读完再写 class，避免「读→写→读」在同帧内多触发一次强制重排。
	// 性能：滚动每帧复用 measureLayout 刷新的 scrollHeight 缓存，避免读 scrollHeight 触发整层强制重排
	// （暖滚动 p50 主因之一）。缓存未建立时（首次渲染前）回退实测，保证逻辑正确。
	const st = vp.scrollTop;
	const ch = vp.clientHeight;
	const sh = ctx.cachedScrollHeight ?? vp.scrollHeight;
		if (ctx.backTopBtn) {
			ctx.backTopBtn.classList.toggle("pt-back-top--visible", st > ch * 1.5);
		}
		if (ctx.scrollBottomBtn) {
			const atBottom = st + ch >= sh - 4;
			ctx.scrollBottomBtn.classList.toggle("pt-scroll-bottom--visible", !atBottom);
		}

}

/**
 * S7: 更新滚动位置指示徽标（「第 x / 共 n」）。
 * 仅长列表（>60 项）滚动时显示，滚停 800ms 自动淡出；读屏器忽略（aria-hidden）。
 */
export function updateScrollPosBadge(ctx: ViewContext) {

		const el = ctx.scrollPosEl;
		const vp = ctx.scrollViewport;
		if (!el || !vp) return;
		const total = ctx.visibleList.length;
		if (total <= 60) {
			el.classList.remove("pt-scroll-pos--visible");
			return;
		}
		// 原生滚动：按固定行高估算当前首行（与网格行距一致）
		const row = Math.floor(vp.scrollTop / ((ctx.defaultRowH + ctx.rowGap) || 1));
		const firstIdx = Math.min(total, row * (ctx.colCount || 1) + 1);
		// 值比较：文本未变则不重写 textContent（避免高频滚动每帧无谓 DOM 写）
		const text = `${firstIdx} / ${total}`;
		if (ctx.lastScrollPosText !== text) {
			ctx.lastScrollPosText = text;
			el.textContent = text;
		}
		el.classList.add("pt-scroll-pos--visible");
		if (ctx.scrollPosTimer) window.clearTimeout(ctx.scrollPosTimer);
		ctx.scrollPosTimer = window.setTimeout(() => {
			ctx.scrollPosTimer = undefined;
			el.classList.remove("pt-scroll-pos--visible");
		}, 800);
	
}

export async function loadAndRender(ctx: ViewContext) {

		const container = ctx.contentEl;
		container.empty();
		container.addClass("pt-view");
		// #5: 移动端触摸适配 —— 给视图根加 pt-mobile 类，供 CSS 放大触控热区（按钮 min-height 44px 等）
		if (isMobileEnvironment()) container.addClass("pt-mobile");

		// 从持久化设置恢复筛选状态
		ctx.sourceFilter = ctx.settings.sourceFilter ?? "all";

		// 头部（折叠式：默认只露搜索，高级控件收起）
		// 注意：不渲染自有 h2 标题——Obsidian 的 tab 已经显示「插件搜索」，
		// 再画一个会和宿主 header 重叠 / 挤压搜索框。
	// 跨工具栏块与下方尾部共享的可变状态（高级面板动画抑制标记 + 补测定时器句柄）
	const toolbarState: ToolbarState = { suppressResizeMeasure: false, advancedAnimTimer: 0 };
	const { searchInput } = buildToolbar(ctx, toolbarState);

		// ARIA live 状态播报区（屏幕阅读器专用，视觉隐藏）
		const ariaLive = container.createDiv({
			cls: "pt-sr-only",
			attr: { "aria-live": "polite", "aria-atomic": "true" },
		});
		ariaLive.setAttribute("role", "status");

		// 插件列表容器（原生滚动视口）
		const listContainer = container.createDiv({ cls: "pt-list pt-list-viewport" });
		ctx.scrollViewport = listContainer;
		// 卡片内容层（正常流 grid，原生滚动 + content-visibility 接管窗口化）
		const cardLayer = listContainer.createDiv({ cls: "pt-list-layer" });
		ctx.scrollCardLayer = cardLayer;
		// S6 虚拟列表 ARIA：屏上只有窗口内卡片，用 list/listitem + posinset/setsize
		// 告知读屏器"这是长列表的第 x/n 项"，而非只有十几项
		cardLayer.setAttribute("role", "list");
		cardLayer.setAttribute("aria-label", "插件列表");

		// UX: 「回到顶部」浮动按钮（滚动超过 1.5 屏时显现）
		const backToTop = container.createEl("button", {
			cls: "pt-back-top",
			attr: { "aria-label": "回到顶部", title: "回到顶部", type: "button" },
		});
		appendSVG(backToTop, `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 15l-6-6-6 6"/></svg>`);
		backToTop.addEventListener("click", () => {
			listContainer.scrollTo({ top: 0, behavior: "smooth" });
		});
		ctx.backTopBtn = backToTop;

		// UX: 「一键置底」浮动按钮（未滚到底部时显现，列表过长时的快捷跳转）
		const scrollBottom = container.createEl("button", {
			cls: "pt-scroll-bottom",
			attr: { "aria-label": "一键置底", title: "一键置底", type: "button" },
		});
		appendSVG(scrollBottom, `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9l6 6 6-6"/></svg>`);
		scrollBottom.addEventListener("click", () => {
			// spacer 撑出整列表总高，滚到 scrollHeight 即最底部（虚拟滚动下仍可靠）
			listContainer.scrollTo({ top: listContainer.scrollHeight, behavior: "smooth" });
		});
		ctx.scrollBottomBtn = scrollBottom;

		// S7: 滚动位置指示徽标（滚动中显示「第 x / 共 n」，滚停 800ms 淡出）
		const scrollPos = container.createDiv({
			cls: "pt-scroll-pos",
			attr: { "aria-hidden": "true" },
		});
		ctx.scrollPosEl = scrollPos;

		// 展开/收起「筛选与统计」时，面板高度连续变化会频繁触发下方列表视口的尺寸回调。
		// 动画期间用该标记抑制虚拟滚动重测（见上方 toggle 处理），结束后再补测一次。

		// 自适应列数 + 动态行高测量（尺寸变化时用 rAF 节流，避免与 scroll 事件冲突）
		ctx.resizeObserver = new ResizeObserver(() => {
			// 面板动画进行中：跳过每帧重测，避免卡顿（动画结束的定时器里会补一次）
			if (toolbarState.suppressResizeMeasure) return;
			if (ctx.measureRAF) return;
			ctx.measureRAF = window.requestAnimationFrame(() => {
				ctx.measureRAF = 0;
				ctx.measureLayout();
				ctx.fillVisibleWindow();
			});
		});
		ctx.resizeObserver.observe(listContainer);

		// 滚动监听：原生滚动由浏览器接管位移，这里只做轻量 UI 同步（节流）。
		// 懒翻译已废弃，滚动不再触发自动翻译（翻译仅由用户点单卡「翻译」按钮）。
		// passive: 不调用 preventDefault，允许浏览器在合成线程平滑滚动（PERF micro）
		listContainer.addEventListener("scroll", () => {
			// #4: 滚动速度采样（ΔscrollTop / Δt），供 PREFETCH_ROWS 速度自适应预取。
			const now = performance.now();
			const top = listContainer.scrollTop;
			if (ctx.lastScrollSampleAt > 0) {
				const dt = now - ctx.lastScrollSampleAt;
				if (dt > 0) {
					const v = Math.abs(top - ctx.lastScrollTopSample) / (dt / 1000);
					// 指数平滑，避免单帧噪声导致预取量抖动
					ctx.scrollVelocity = ctx.scrollVelocity * 0.5 + v * 0.5;
				}
			}
			ctx.lastScrollTopSample = top;
			ctx.lastScrollSampleAt = now;
			if (ctx.scrollRAF) return;
			ctx.scrollRAF = window.requestAnimationFrame(() => {
				ctx.scrollRAF = 0;
				ctx.updateScrollButtons();
				ctx.updateScrollPosBadge();
				// #3 虚拟滚动：滚动时增量换入/换出窗口卡片（DOM 节点数稳定 ≤250）
				ctx.updateWindow();
			});
		}, { passive: true });

		// 卡片操作改为事件委托（仅绑定一次，不逐卡绑定）
		cardLayer.addEventListener("click", (ev) => ctx.onCardClick(ev));

		// 键盘导航：方向键在卡片间移动焦点 + Enter 打开详情（Obsidian 键盘优先习惯）
		cardLayer.addEventListener("keydown", (ev) => ctx.onCardKeydown(ev));

	// ── 首屏策略：打开即加载热门列表（内容即见，不再空态引导） ──
	// stats 由工具栏块创建，尾部复用时重新查询（避免跨越抽取边界持有闭包引用）
	const stats = q(ctx.contentEl, ".pt-stats");
	if (stats) stats.setCssStyles({ display: "none" });
		ctx.showLoadingState(ctx.t("stats.fetching"));
		// UX: 搜索框自动聚焦，省去用户手动点击
		window.setTimeout(() => searchInput.focus({ preventScroll: true }), LAYOUT.FOCUS_DELAY_MS);
		// UX: "/" 快捷键聚焦搜索（GitHub/Notion 通用范式）
		const slashHandler = (e: KeyboardEvent) => {
			if (e.key !== "/" || e.ctrlKey || e.metaKey || e.altKey) return;
			const tag = (e.target as HTMLElement)?.tagName;
			if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
			e.preventDefault();
			searchInput.focus();
		};
		container.addEventListener("keydown", slashHandler);
		ctx.register(() => container.removeEventListener("keydown", slashHandler));
		void ctx.ensureDataLoaded().then((ok) => {
			if (ok) {
				// 默认按下载量降序展示全量列表（若用户未自定义排序偏好）
				if (ctx.sortBy === "relevance") {
					ctx.sortBy = "downloads";
					ctx.settings.sortBy = ctx.sortBy;
					void ctx.saveSettings();
				}
				ctx.renderPluginList();
				ctx.updateStats();
				// 首屏渲染后同步滚动快捷按钮的可见性（首次打开即显示「一键置底」）
				ctx.updateScrollButtons();
			}
		}).catch((e) => logger.warn("[Chinese Plugin Market] 初始化数据加载失败：", e));
	
}


/**
 * 插件卡片渲染。
 *
 * 单个插件卡片的 DOM 构建（译名、信号徽标、操作按钮、对比/收藏入口）。
 */

import { App, Modal, Notice } from "obsidian";
import { type PluginInfo, type Translator } from "./translator";
import { computeSimilar, type SimilarCandidate } from "./recommend/similar";
import { PluginDetailDrawer } from "./detail-drawer";
import type { ViewContext } from "./view-context";
import { q } from "./dom";
import { fetchManifest, fetchReadmeText, fetchMainSignals, generateInsight } from "./plugin-insight";
import type { I18nKey } from "./i18n";
import type { MirrorConfig } from "./mirror";

export function openDetailDrawer(ctx: ViewContext, pluginId: string, triggerCard: HTMLElement | null = null) {
	const info = ctx.plugins.find((p) => p.id === pluginId);
	if (!info) return;
	// 信号门控：用户对插件表现出真实兴趣（打开详情），
	// 把其 online 译文投入晋升队列（非 online 缓存为 no-op，不会污染审核队列）
	ctx.translator.enqueueOnlineTM(pluginId);
	// 互斥：如果在对比模式，先退出
	if (ctx.compareMode) ctx.exitCompareMode();
	const result = ctx.translatedResults[info.id];

	// 打开丝滑优化：相似推荐（computeSimilarFor 对热门分类可能给上千候选打分）
	// 不再阻塞打开帧，先渲染骨架，双 rAF（首帧真正绘制后）再计算回填。
	const fillSimilar = (drawer: PluginDetailDrawer) => {
		window.requestAnimationFrame(() => window.requestAnimationFrame(() => {
			// 若期间用户又跳转/关闭（activeDrawer 已换 / 内容已切换），安全跳过
			if (ctx.activeDrawer !== drawer) return;
			if (drawer.currentPluginId !== info.id) return;
			drawer.setSimilar(ctx.computeSimilarFor(info));
		}));
	};

	// 复用当前详情抽屉（页面模式内跳转，避免反复开关闪烁）
	if (ctx.activeDrawer) {
		ctx.activeDrawer.navigate(pluginId, info, result, []);
		fillSimilar(ctx.activeDrawer);
		return;
	}
	const drawer = new PluginDetailDrawer({
		app: ctx.app,
		plugin: ctx.plugin,
		info,
		result,
		similar: [],
		deferSimilar: true,
		triggerCard,
		openDetail: (pid: string) => ctx.openDetailDrawer(pid),
		toggleFavorite: (pid: string) => ctx.toggleFavorite(pid),
		installedIds: ctx.installedIds,
		container: ctx.contentEl,
		mode: "page",
		onClose: () => { ctx.exitDetailMode(); },
	});
	ctx.activeDrawer = drawer;
	// 隐藏列表，进入详情态
	ctx.enterDetailMode();
	drawer.open();
	fillSimilar(drawer);
}

export function computeSimilarFor(ctx: ViewContext, info: PluginInfo) : SimilarCandidate[] {

		const tagService = ctx.translator.tagService;
		const all = ctx.plugins;
		if (!tagService || !all.length) return [];

		const translatedMap: Record<string, string> = {};
		for (const p of all) {
			const r = ctx.translatedResults[p.id];
			if (r?.translatedName) translatedMap[p.id] = r.translatedName;
		}

		return computeSimilar(
			info.id,
			info.description,
			all,
			tagService,
			translatedMap,
			5,
			ctx.invertedIndex
		);
	
}

export function onCardClick(ctx: ViewContext, ev: MouseEvent) {

		const target = ev.target as HTMLElement;
		const actionEl = target.closest("[data-action]") as HTMLElement | null;
		// 整卡点击打开详情（非按钮区域点击）
		if (!actionEl) {
			const card = target.closest(".pt-card--clickable") as HTMLElement | null;
			const pid = card?.getAttribute("data-plugin-id");
			if (pid) {
				ev.stopPropagation();
				const plugin = ctx.plugins.find((p) => p.id === pid);
				if (plugin) {
					void ctx.saveSettings();
					ctx.openDetailDrawer(pid, card);
				}
			}
			return;
		}
		const card = actionEl.closest(".pt-card") as HTMLElement | null;
		const pid = card?.getAttribute("data-plugin-id");
		if (!pid) return;
		ev.stopPropagation();
		const action = actionEl.getAttribute("data-action");
		const plugin = ctx.plugins.find((p) => p.id === pid);
		if (!plugin) return;
		if (action === "copy") {
			ctx.flashAction(actionEl);
			navigator.clipboard?.writeText(pid).catch(() => {
				new Notice(ctx.t("card.copy.fail"));
			});
			// tooltip 临时切换为「已复制」，1.2s 后还原
			const prevTitle = actionEl.getAttribute("title") || ctx.t("card.copy");
			actionEl.setAttribute("title", ctx.t("card.copy.done"));
			window.setTimeout(() => {
				actionEl.setAttribute("title", prevTitle);
			}, 1200);
		} else if (action === "compare") {
			const pid = card?.getAttribute("data-plugin-id") ?? plugin.id;
			const isOn = ctx.compareSet.has(pid);
			if (isOn) {
				ctx.compareSet.delete(pid);
				new Notice(ctx.t("compare.removed"));
		} else {
			ctx.compareSet.add(pid);
			// 信号门控：加入对比，把其 online 译文投入晋升队列（非 online 缓存为 no-op）
			ctx.translator.enqueueOnlineTM(pid);
			new Notice(ctx.t("compare.added"));
		}
			actionEl.classList.toggle("is-compare-on", !isOn);
			ctx.updateCompareTray();
			if (!isOn) ctx.track("action:compare_add");
			// 持久化：对比集变化即时保存（跨会话不丢失）
			ctx.settings.compare = Array.from(ctx.compareSet);
			void ctx.flushSaveSettings();
		} else if (action === "detail") {
			void ctx.saveSettings();
			ctx.openDetailDrawer(pid, card);
		} else if (action === "insight") {
			openInsightModal(ctx, plugin);
		} else if (action === "market") {
			// 跳转 Obsidian 社区市场
			const url = actionEl.getAttribute("data-url");
			if (url) {
				window.open(url, "_self");
				new Notice(ctx.t("notice.market.opened"));
			}
		} else if (action === "author") {
			// 作者钻取：点卡片作者名 → 只看该作者全部插件（与作者 facet 共用 authorFilter）
			ctx.authorFilter = plugin.author;
			ctx.track("filter:author");
			ctx.searchQuery = "";
			const searchInput = q<HTMLInputElement>(ctx.containerEl, ".pt-search-input");
			if (searchInput) searchInput.value = "";
			ctx.aiSearchResult = null;
			ctx.aiSearchQueryCache = "";
			ctx.renderAuthorFacet();
			ctx.updateFacetVisibility();
			ctx.renderPluginList();
		} else if (action === "favorite") {
			const pid = card?.getAttribute("data-plugin-id") ?? plugin.id;
			const isOn = ctx.favoritesSet.has(pid);
			const newState = ctx.toggleFavorite(pid);
			actionEl.classList.toggle("is-fav-on", newState);
			// 一次性脉冲动画（动画结束后自动移除 class，避免虚拟滚动复用时重播）
			if (newState) {
				actionEl.classList.add("pt-fav-pulse");
				actionEl.addEventListener("animationend", () => actionEl.classList.remove("pt-fav-pulse"), { once: true });
			}
			ctx.flashAction(actionEl);
			new Notice(isOn ? ctx.t("favorite.removed") : ctx.t("favorite.added"));
			if (ctx.sortFavoritesFirst && !newState) {
				// 仅看收藏模式下取消收藏：从列表中移除该卡片（带过渡动画）
				const card = actionEl.closest(".pt-card") as HTMLElement | null;
				if (card) {
					card.setCssStyles({ transition: "opacity 200ms ease, transform 200ms ease", opacity: "0", transform: "scale(0.95)" });
					window.setTimeout(() => {
						ctx.renderPluginList(true);
					}, 200);
				} else {
					ctx.renderPluginList(true);
				}
			} else {
				ctx.refreshCardState(pid);
			}
		}
	
}

export function toggleFavorite(ctx: ViewContext, pid: string) : boolean {

		const isOn = ctx.favoritesSet.has(pid);
		if (isOn) ctx.favoritesSet.delete(pid);
		else {
			ctx.favoritesSet.add(pid);
			// 信号门控：收藏此插件，把其 online 译文投入晋升队列（非 online 缓存为 no-op）
			ctx.translator.enqueueOnlineTM(pid);
		}
		ctx.settings.favorites = Array.from(ctx.favoritesSet);
		void ctx.flushSaveSettings();
		return !isOn;
	
}

export function onCardKeydown(ctx: ViewContext, ev: KeyboardEvent) {

		const colCount = ctx.colCount || 1;
		const total = ctx.visibleList.length;
		if (total === 0) return;

		// 仅在方向键 / 翻页键 / Enter / Tab 需要拦截时处理，其余放行
		const key = ev.key;
		if (key !== "ArrowDown" && key !== "ArrowUp" && key !== "ArrowRight" &&
			key !== "ArrowLeft" && key !== "Enter" && key !== "Tab" &&
			key !== "PageDown" && key !== "PageUp" && key !== "Home" && key !== "End") return;

		// Tab：允许在卡片内部 focusable 元素间切换
		if (key === "Tab") return;

		ev.preventDefault();
		ev.stopPropagation();

		// Enter：打开当前聚焦卡片的详情
		if (key === "Enter") {
			if (ctx.focusedCardIdx >= 0 && ctx.focusedCardIdx < total) {
				const plugin = ctx.visibleList[ctx.focusedCardIdx];
				const layer = ctx.scrollCardLayer;
				const focusedCard = layer
					? q(layer, `.pt-card[data-idx="${ctx.focusedCardIdx}"]`)
					: null;
				ctx.openDetailDrawer(plugin.id, focusedCard);
			}
			return;
		}

		// 初始化/恢复聚焦
		if (ctx.focusedCardIdx < 0) {
			ctx.focusedCardIdx = 0;
		} else {
			// 方向键移动：在网格中漫游；翻页键按视口行数跳（S6）
			if (key === "ArrowDown") {
				ctx.focusedCardIdx = Math.min(ctx.focusedCardIdx + colCount, total - 1);
			} else if (key === "ArrowUp") {
				ctx.focusedCardIdx = Math.max(ctx.focusedCardIdx - colCount, 0);
			} else if (key === "ArrowRight") {
				ctx.focusedCardIdx = Math.min(ctx.focusedCardIdx + 1, total - 1);
			} else if (key === "ArrowLeft") {
				ctx.focusedCardIdx = Math.max(ctx.focusedCardIdx - 1, 0);
			} else if (key === "PageDown" || key === "PageUp") {
				const vpH = ctx.scrollViewport?.clientHeight || 600;
				const rowH = (ctx.defaultRowH + ctx.rowGap) || 1;
				const jump = Math.max(1, Math.floor(vpH / rowH)) * colCount;
				ctx.focusedCardIdx = key === "PageDown"
					? Math.min(ctx.focusedCardIdx + jump, total - 1)
					: Math.max(ctx.focusedCardIdx - jump, 0);
			} else if (key === "Home") {
				ctx.focusedCardIdx = 0;
			} else if (key === "End") {
				ctx.focusedCardIdx = total - 1;
			}
		}

		ctx.focusCardByIdx(ctx.focusedCardIdx);
	
}

/**
 * 聚焦第 idx 张卡片（S6）。
 * 虚拟滚动下目标卡可能不在渲染窗口内：先把该行滚进视口触发 renderWindow，
 * 下一帧再聚焦真实 DOM——这是 PageDown/Home/End 大跨度跳转可用的关键。
 */
export function focusCardByIdx(ctx: ViewContext, idx: number) {

		const layer = ctx.scrollCardLayer;
		if (!layer) return;
		layer.querySelectorAll(".pt-card--focused").forEach((el) => {
			el.classList.remove("pt-card--focused");
		});

		const doFocus = () => {
			const card = q(layer, `.pt-card[data-idx="${idx}"]`);
			if (card) {
				card.classList.add("pt-card--focused");
				card.focus({ preventScroll: true });
				card.scrollIntoView({ block: "nearest" });
			}
		};

		// 架构重构：全部卡片常驻 DOM（原生滚动），目标卡必在 DOM，直接聚焦并滚入视口。
		doFocus();
	
}

export function flashAction(_ctx: ViewContext, btn: HTMLElement) {

		btn.addClass("pt-icon-btn--done");
		window.setTimeout(() => {
			btn.removeClass("pt-icon-btn--done");
		}, 1200);
	
}

/**
 * 一键了解插件功能：基于仓库 manifest 元数据（非 README）让 AI 生成中文概述。
 * 有缓存则直接展示；无缓存则抓取 manifest + 调 LLM + 缓存落盘。
 *
 * 接收轻量 InsightHost 而非完整 ViewContext，使详情抽屉（无 ViewContext）也能复用。
 */
export interface InsightHost {
	app: App;
	translator: Translator;
	t: (key: I18nKey, vars?: Record<string, string | number>) => string;
	mirrorConfig: () => MirrorConfig;
	saveTranslatorData: () => void;
}

export function openInsightModal(host: InsightHost, plugin: PluginInfo) {
	new InsightModal(host, plugin).open();
}

class InsightModal extends Modal {
	private host: InsightHost;
	private plugin: PluginInfo;

	constructor(host: InsightHost, plugin: PluginInfo) {
		super(host.app);
		this.host = host;
		this.plugin = plugin;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pt-insight-modal");
		const t = this.host.t;

		contentEl.createDiv({ cls: "pt-insight-title", text: this.plugin.name });
		contentEl.createDiv({ cls: "pt-insight-sub", text: t("insight.descHint") });

		const body = contentEl.createDiv({ cls: "pt-insight-body" });
		const rendered = this.host.translator.getInsight(this.plugin.id);
		if (rendered) {
			body.textContent = rendered;
		} else {
			void this.generate(body);
		}
	}

	private async generate(body: HTMLElement) {
		const t = this.host.t;
		const translator = this.host.translator;
		if (!translator.aiConfig?.apiKey) {
			body.textContent = this.plugin.description || t("insight.noContent");
			body.createDiv({ cls: "pt-insight-warn", text: t("insight.noAI") });
			return;
		}
		const loading = body.createDiv({ cls: "pt-insight-loading", text: t("insight.loading") });
		try {
			const mirror = this.host.mirrorConfig();
			// 先拉 manifest（main.js 入口依赖其中的 main 字段），再并行拉 README + main.js 信号
			const manifest = await fetchManifest(this.plugin.repo, mirror);
			const [readme, mainSignals] = await Promise.all([
				fetchReadmeText(this.plugin.repo, mirror),
				fetchMainSignals(this.plugin.repo, manifest.main, mirror),
			]);
			const text = await generateInsight(translator.llm, this.plugin, manifest, {
				readme,
				mainSignals,
			});
			loading.remove();
			body.textContent = text;
			translator.setInsight(this.plugin.id, text);
			this.host.saveTranslatorData();
		} catch (e) {
			loading.remove();
			// 降级：回退到官方描述
			body.textContent = this.plugin.description || t("insight.noContent");
			const msg = e instanceof Error ? e.message : String(e);
			body.createDiv({ cls: "pt-insight-warn", text: `${t("insight.failed")}：${msg}` });
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}

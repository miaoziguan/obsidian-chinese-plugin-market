/**
 * 数据获取与状态。
 *
 * 拉取社区插件列表、stats 合并、分页/增量加载与视图级缓存状态管理。
 */

import { Notice, requestUrl } from "obsidian";
import { logger } from "@shared/logger";
import { cleanChineseSpaces, isListStale, computePluginDelta } from "@shared/utils";
import { type PluginInfo, type TranslateResult } from "@domain/catalog/translator";
import { resolveUrl, classifyNetworkError, type MirrorConfig } from "@domain/catalog/mirror";
import { fetchPluginStats, PLUGIN_STATS_URL } from "@domain/catalog/stats";
import { formatRelativeTime, type I18nKey } from "@shared/i18n";
import { computeCoverage } from "@translation/lexicon/dictionary";
import { createStrong, q, toHTMLElement } from "@ui/dom/dom";
import { buildSearchBlob } from "@domain/filter/filter";
import { renderFacetChips } from "@ui/components/facet-chips";
import { groupAuthorsByName } from "@translation/lexicon/pinyin-init";
import { setListState } from "@ui/dom/list-state";
import { isAIMode } from "@domain/search/search-mode";

import type { ViewContext } from "@ui/view/view-context";
import { LAYOUT, PLUGINS_URL } from "@shared/constants";
import { fetchManifest } from "@domain/compare/plugin-insight";
import { asAppInternals } from "@data/platform/obsidian-internals";

// 插件 id → PluginInfo 查表缓存：消除 refreshCardTranslation 内 ctx.plugins.find 的 O(n) 线性扫描
// （翻译 5617 张卡时，每次 find 都扫全表 → O(n²) ≈ 3200 万次扫描）。
// 挂在 ctx（per-view）上，以 pluginsRev（数据被替换/合并时自增的版本号）为失效键，
// 避免依赖数组引用身份——原地 sort/splice 不替换引用会导致引用判断失效、缓存陈旧。
function getPluginMap(ctx: ViewContext): Map<string, PluginInfo> {
	if (ctx.pluginMapSrc !== ctx.pluginsRev || !ctx.pluginMap) {
		ctx.pluginMap = new Map(ctx.plugins.map((p) => [p.id, p]));
		ctx.pluginMapSrc = ctx.pluginsRev;
	}
	return ctx.pluginMap;
}

/**
 * 卸载时清理当前视图的插件查表缓存（含 5617 条映射，per-view）。
 * 该缓存以 ctx.plugins 引用为键，视图销毁后若不清会滞留大对象，
 * 下次打开新视图设置 ctx.plugins 时会自动重建。
 */
export function disposeViewDataCache(ctx: ViewContext): void {
	ctx.pluginMap = null;
	ctx.pluginMapSrc = null;
}

export function applySearchInput(ctx: ViewContext) {

		const input = toHTMLElement(
			ctx.contentEl.querySelector(".pt-search-input"),
			HTMLInputElement
		);
		if (!input) return;
		// 同步清除按钮可见性（与即时 input 事件一致）
		const clearBtn = toHTMLElement(ctx.contentEl.querySelector(".pt-search-clear"));
		if (clearBtn) {
			clearBtn.setCssStyles({ display: input.value.length > 0 ? "" : "none" });
		}
		const value = input.value.trim().toLowerCase();
		ctx.searchQuery = value;
		if (!value) {
			ctx.aiSearchResult = null;
			ctx.aiSearchQueryCache = "";
			// 空查询 → 回到全量列表（rAF 延迟，输入路径不阻塞）
			ctx.scheduleRender();
			return;
		}
		if (!isAIMode(ctx)) {
			ctx.aiSearchResult = null;
			ctx.aiSearchQueryCache = "";
		} else {
			// AI 语义模式：输入过程中保留上一次检索结果（不再每次按键清空列表），
			// 仅提示「按 Enter 重新检索」，使两种模式的输入体验不再割裂。
			ctx.showAIPendingHint();
			return;
		}
		void ctx.ensureDataLoaded().then((ok) => {
			if (ok) ctx.scheduleRender();
		}).catch((e) => logger.warn("[Chinese Plugin Market] 搜索时数据加载失败：", e));
	
}

/** 根据 plugin.tmProgress 刷新加载提示文案，展示 TM 回灌实时进度。 */
function updateTMProgressHint(ctx: ViewContext, hint: HTMLElement | null) {
	if (!hint) return;
	const p = ctx.plugin.tmProgress;
	if (!p) {
		hint.textContent = ctx.t("loading.translating");
		return;
	}
	if (p.phase === "done") {
		hint.textContent = ctx.t("loading.tm.done", { total: String(p.total) });
		return;
	}
	if (p.phase === "resolving") {
		hint.textContent = ctx.t("loading.tm.resolving");
		return;
	}
	hint.textContent = ctx.t(`loading.tm.${p.phase}` as I18nKey, {
		current: String(p.current),
		total: String(p.total),
	});
}

export async function ensureDataLoaded(ctx: ViewContext) : Promise<boolean> {

		if (ctx.dataLoaded) {
			// 会话内 TTL 自动失效：列表快照超期则静默重拉（不清空已渲染结果，避免闪烁）。
			// 用户每次搜索都能逐步看到新上架插件，无需重启 Obsidian。
			if (isListStale(ctx.lastListFetchAt, Date.now(), LAYOUT.LIST_TTL_MS)) {
				ctx.dataLoaded = false;
			} else {
				return true;
			}
		}
		if (ctx.dataLoading) {
			// 正在加载中：等待其完成（轮询标志）
			await new Promise<void>((resolve) => {
				const tick = () => {
					if (ctx.dataLoaded || !ctx.dataLoading) resolve();
					else window.setTimeout(tick, 60);
				};
				tick();
			});
			return ctx.dataLoaded;
		}

		ctx.dataLoading = true;
		const stats = q(ctx.containerEl, ".pt-stats");
		if (stats) {
			stats.setCssStyles({ display: "" });
			stats.empty();
			stats.createSpan({ cls: "pt-stat", text: ctx.t("app.loading") + "..." });
		}
		// 用户体验：首搜拉取 1 万条 + 逐条翻译可能耗时数秒，
		// 必须把进度直接渲染到列表区（不要藏在折叠的统计区），否则用户以为卡死。
		ctx.showLoadingState(ctx.t("stats.fetching"));
		// UX: 分阶段进度文案，减少等待焦虑
		const progressHint = ctx.scrollCardLayer
			? q(ctx.scrollCardLayer, ".pt-empty-hint")
			: null;
		try {
			// 首屏默认走 jsDelivr，但仍可能因网络/版本受限失败。
			// 失败时按优先级自动探测其它镜像（jsDelivr→ghproxy→github），命中即用。
			let data = await ctx.fetchPlugins();
			// 拉取成功后缓存到本地（离线重启时秒开，不受网络影响）
			// 性能：写独立文件而非内嵌 data.json（1.6MB 大对象曾拖慢每一次防抖保存）
		void ctx.savePluginListCache(data);
		ctx.plugins = data;
		ctx.buildAuthorFacet();
		// 拉取成功：更新列表拉取时间戳（用于 TTL 判断）。
		// plugin 级字段在 translator-view 的 ensureDataLoaded 落盘钩子里回写，
		// 这里只更新 ctx 内存值；避免直接依赖 plugin 完整形状（DrawerHostPlugin 最小端口）。
		ctx.lastListFetchAt = Date.now();
	
			ctx.applyAIConfig();
			// UX: 拉取完成，进入翻译阶段
			if (progressHint) progressHint.textContent = ctx.t("loading.translating");
			// 等待 vault 翻译记忆回灌完成（scanVaultTM→tmApproved），
			// 否则下面的 computeCoverage / mergeOffline 会在 tmApproved 为空时兜底，
			// 命中不到已采纳译名（表现为「卡片没加载库里的翻译数据」）。
			// 同时实时轮询 tmProgress 刷新加载提示（即使回灌在视图打开前已完成，
			// 也保留一段最小可见时长，让用户看到数据处理动态而非一闪而过）。
			// 200ms 足够让人眼感知「在处理」，又不会让实际已完成的回灌空等多余时间。
			const minVisibleUntil = Date.now() + 200;
			const tmProgressTimer = window.setInterval(() => {
				updateTMProgressHint(ctx, progressHint);
			}, 100);
			try {
				// 安全阀：即便 tmApprovedReady 因底层 IO 卡死未 resolve，也最多等 15s，
				// 超时即降级继续（无 vault 译名兜底），杜绝首屏永久停留在加载页。
				await Promise.race([
					ctx.plugin.tmApprovedReady,
					new Promise<void>((r) => window.setTimeout(r, 15_000)),
				]);
				const waitMore = minVisibleUntil - Date.now();
				if (waitMore > 0) await new Promise((r) => window.setTimeout(r, waitMore));
			} finally {
				window.clearInterval(tmProgressTimer);
			}
			if (progressHint) progressHint.textContent = ctx.t("loading.translating");
			// 计算并记录覆盖率快照（趋势追踪：跨版本对比）。
			// 已采纳译名（tmApproved，含原批量词典沉淀的 vault 笔记）作为开箱即用覆盖统计来源。
			const td = ctx.translator.getData();
			const covStat = computeCoverage(new Set(data.map((p) => p.id)), ctx.translator.tmApproved, td.cache);
			ctx.translator.recordCoverage(covStat, ctx.manifest.version);
			ctx.saveTranslatorData();

			// 同步合并已缓存的 stats（首屏不空白）并快照已安装状态。
			// 等 cachedStats 就绪（onload 异步加载可能慢于视图打开），避免竞态下
			// statsMap 为空导致 downloads/updated 未写入、进而「更新」维度筛空。
			// 最多等 8s；超时仍空则主动重新从磁盘读一次 stats 缓存做最后兜底（不阻断首屏）。
			const deadline = Date.now() + 8000;
			while (!ctx.cachedStats && Date.now() < deadline) {
				await new Promise((r) => window.setTimeout(r, 50));
			}
			if (!ctx.cachedStats) {
				try {
					const reloaded = await ctx.loadStatsCache();
					if (reloaded) ctx.cachedStats = reloaded;
				} catch { /* 忽略，交给后续 fetchStatsAndMerge 兜底 */ }
			}
			ctx.mergeStatsFromCache();
			ctx.snapshotInstalled();

			// 懒翻译（产品改进 #9）：首搜只【同步合并离线命中】立即出结果（毫秒级），
			// 未命中项先给原文兜底渲染，真正的在线翻译推迟到「当前结果集可见时」按需进行。
			const { results: offline } = ctx.translator.mergeOffline(data);
			ctx.translatedResults = offline;
			// 离线命中（bulk/user）已写入 cache，落盘一次供下次秒开
			ctx.saveTranslatorData();

		// 新增插件翻译增量感知：本地 diff「本次新冒出的插件」并提示（产品改进 #16）
		ctx.reportNewPluginDelta(data, ctx.translatedResults);
		// 把刚更新的「已见插件」集合落盘，跨会话重启后增量提示仍准确
		ctx.saveTranslatorData();

		if (stats) {
			stats.empty();
			const s1 = stats.createSpan({ cls: "pt-stat" });
			s1.append(ctx.t("stats.plugins") + " ", createStrong(String(data.length)));
			if (td.cache && Object.keys(td.cache).length > 0) {
				const s2 = stats.createSpan({ cls: "pt-stat" });
				s2.append(ctx.t("stats.cache") + " ", createStrong(
					String(Object.keys(td.cache).length)
				));
			}
		}

			ctx.dataLoaded = true;
			// 记录本次成功拉取时间，供 TTL 自动失效判断（保证看到新上架插件）
			ctx.lastListFetchAt = Date.now();
			// A+B 预建：若用户已选「本地 embedding」且尚未建索引，数据就绪后后台自动预建一次
			// （仅对显式选了本地语义的用户生效，避免给默认 keyword/AI 用户强塞 110MB 模型）
			if (ctx.settings.embeddingSource === "local") {
				void ctx.buildLocalIndex(false).catch(() => {});
				// 预热本地模型：即使索引已从 SQLite 加载（buildLocalIndex 幂等跳过），
				// 也提前加载模型，让首次搜索免冷启动
				ctx.warmupLocalEmbedding();
			}
			ctx.updateRefreshTooltip();
			// 预计算搜索索引（小写 blob），供后续过滤复用
			ctx.buildSearchIndex();
		// 数据已就绪：重渲染作者 facet 并按当前模式刷新显隐
		ctx.renderAuthorFacet();
		ctx.updateFacetVisibility();

		// 数据已就绪，立即渲染列表（含官方推荐 featured 区），不依赖后续 stats 网络请求
		ctx.scheduleRender();

		// 异步非阻塞刷新最新 stats（失败记录日志，不阻断主列表；回来再 render 一次合并）
		void ctx.fetchStatsAndMerge()
			.then(() => ctx.scheduleRender())
			.catch((e2) => logger.warn("[Chinese Plugin Market] 异步刷新 stats 失败：", e2));

		return true;
		} catch (e: unknown) {
			// 网络失败时尝试从本地缓存恢复（离线应急，不阻断使用）
			const cachedData = await ctx.tryLoadCachedPluginList();
			if (cachedData && cachedData.length > 0) {
				ctx.plugins = cachedData;
				ctx.buildAuthorFacet();
			ctx.applyAIConfig();
			if (progressHint) progressHint.textContent = "（使用本地缓存）";
			logger.warn("[Chinese Plugin Market] 网络不可用，已从本地缓存恢复插件列表（%d 个）。", cachedData.length);
			// stale 优雅降级提示（对齐 better-store）：告知用户当前是缓存数据而非最新，
			// 避免「列表为什么不更新」的困惑。有上次拉取时间则一并展示相对时间。
			const staleAt = ctx.lastListFetchAt;
			const staleHint = staleAt > 0
				? `（${formatRelativeTime(staleAt, Date.now(), ctx.t)}）`
				: "";
			new Notice(`已使用本地缓存列表${staleHint}，网络恢复后自动刷新`);
			// 等待 vault 翻译记忆回灌完成（同在线路径，避免 tmApproved 为空时兜底）
			const minVisibleUntilOffline = Date.now() + 200;
			const tmProgressTimerOffline = window.setInterval(() => {
				updateTMProgressHint(ctx, progressHint);
			}, 100);
			try {
				await ctx.plugin.tmApprovedReady;
				const waitMoreOffline = minVisibleUntilOffline - Date.now();
				if (waitMoreOffline > 0) await new Promise((r) => window.setTimeout(r, waitMoreOffline));
			} finally {
				window.clearInterval(tmProgressTimerOffline);
			}
			if (progressHint) progressHint.textContent = "（使用本地缓存）";
		const td = ctx.translator.getData();
			const covStat = computeCoverage(new Set(cachedData.map((p: PluginInfo) => p.id)), ctx.translator.tmApproved, td.cache);
				ctx.translator.recordCoverage(covStat, ctx.manifest.version);
				ctx.saveTranslatorData();
				ctx.mergeStatsFromCache();
				ctx.snapshotInstalled();
				const { results: offline } = ctx.translator.mergeOffline(cachedData);
				ctx.translatedResults = offline;
				ctx.saveTranslatorData();
				ctx.reportNewPluginDelta(cachedData, ctx.translatedResults);
				ctx.saveTranslatorData();
			ctx.dataLoaded = true;
			ctx.buildSearchIndex();
			ctx.renderAuthorFacet();
			ctx.updateFacetVisibility();
			// 立即渲染（不依赖 stats 网络请求）
			ctx.scheduleRender();
			void ctx.fetchStatsAndMerge()
				.then(() => ctx.scheduleRender())
				.catch((e2) => logger.warn("[Chinese Plugin Market] 异步刷新 stats 失败：", e2));
			return true;
			}

			// 无缓存可用 → 显示错误
			if (ctx.scrollCardLayer) {
				ctx.scrollCardLayer.empty();
				ctx.cardById.clear(); // 清层后持久化卡片索引失效
				ctx.windowStart = -1; ctx.windowEnd = -1; // 清层后窗口守卫失效，防下次误跳过
				setListState(ctx, "error");
				const err = ctx.scrollCardLayer.createDiv({ cls: "pt-error" });
				err.createDiv({ cls: "pt-empty-title", text: ctx.t("error.title") });
				const info = classifyNetworkError(e);
				err.createDiv({
					cls: "pt-empty-hint",
					text: `${ctx.t("error.fetch")}${info.message}`,
				});
				// 提供明确的可恢复入口：重试按钮 + 回搜索引导
				const actions = err.createDiv({ cls: "pt-error-actions" });
				const retryBtn = actions.createEl("button", {
					cls: "pt-guide-chip pt-error-retry",
					text: ctx.t("error.retry"),
				});
				retryBtn.addEventListener("click", () => {
					// 重置加载锁，复用当前搜索词重新发起
					ctx.dataLoaded = false;
					ctx.dataLoading = false;
					void ctx.ensureDataLoaded().then((ok) => {
						if (ok) ctx.scheduleRender();
					}).catch((e) => logger.warn("[Chinese Plugin Market] 重试数据加载失败：", e));
				});
				const guideBtn = actions.createEl("button", {
					cls: "pt-guide-chip pt-error-guide",
					text: ctx.t("error.guide"),
				});
				guideBtn.addEventListener("click", () => {
					ctx.dataLoaded = false;
					ctx.dataLoading = false;
					// Bug fix: 加载失败后 dataLoaded=false 且 plugins 为空，renderPluginList 会提前 return
					// 导致点击无反应；改为直接渲染搜索引导（含示例词，点击可重试加载）。
					ctx.showSearchGuide();
				});
			}
			return false;
		} finally {
			ctx.dataLoading = false;
		}
	
}

export async function fetchPlugins(ctx: ViewContext): Promise<PluginInfo[]> {
	const url = resolveUrl(PLUGINS_URL, ctx.mirrorConfig());
	const response = (await Promise.race([
		requestUrl({ url, method: "GET" }),
		new Promise<never>((_, reject) =>
			window.setTimeout(() => reject(new Error("timeout")), 4000)
		),
	])) as { json: unknown };
	const arr = response.json as PluginInfo[];
	// 注入清单数组下标：官方把新插件追加到尾部，下标越大越新；
	// 「最新发布」排序据此倒序（与官方「New」标签一致）。
	return arr.map((p, i) => ({ ...p, listIndex: i }));
}

export async function refreshData(ctx: ViewContext) : Promise<void> {

		// Bug fix: 初始加载（ensureDataLoaded）未完成时点刷新会并发两个拉取，
		// 二者都写 ctx.plugins/translatedResults 造成竞态，这里直接忽略。
		if (!ctx.refreshBtn || ctx.refreshBtn.disabled || ctx.dataLoading) return;
		ctx.refreshBtn.disabled = true;
		ctx.refreshBtn.addClass("pt-refreshing");
		try {
			// 手动刷新按当前设置的数据源直接拉取，不再做镜像容错探测
			const data = await ctx.fetchPlugins();
			ctx.plugins = data;
			ctx.buildAuthorFacet();
	
			ctx.applyAIConfig();
			const td = ctx.translator.getData();
			const covStat = computeCoverage(
				new Set(data.map((p) => p.id)),
				ctx.translator.tmApproved,
				td.cache
			);
			ctx.translator.recordCoverage(covStat, ctx.manifest.version);
			ctx.saveTranslatorData();

			ctx.mergeStatsFromCache();
			ctx.snapshotInstalled();
			const { results: offline } = ctx.translator.mergeOffline(data);
			ctx.translatedResults = offline;
			ctx.saveTranslatorData();

			// 新增插件翻译增量感知：本地 diff「本次新冒出的插件」并提示（产品改进 #16）
		ctx.reportNewPluginDelta(data, ctx.translatedResults);
		// 把刚更新的「已见插件」集合落盘，跨会话重启后增量提示仍准确
		ctx.saveTranslatorData();

		ctx.dataLoaded = true;
			ctx.lastListFetchAt = Date.now();
			ctx.updateRefreshTooltip();
			ctx.buildSearchIndex();
			// 数据已就绪：重渲染作者 facet 并按当前模式刷新显隐
			ctx.renderAuthorFacet();
			ctx.updateFacetVisibility();

			// 异步刷新最新 stats（下载量/更新时间），失败记录日志
			void ctx.fetchStatsAndMerge()
				.then(() => ctx.scheduleRender())
				.catch((e) => logger.warn("[Chinese Plugin Market] 异步刷新 stats 失败：", e));

			ctx.scheduleRender();
			new Notice(ctx.t("action.refresh.done"));
		} catch (e: unknown) {
			const info = classifyNetworkError(e);
			new Notice(`${ctx.t("action.refresh")}：${info.message}`);
			// 失败：保留当前已加载数据，仅复位锁以便下次重试
			ctx.dataLoaded = ctx.plugins.length > 0;
		} finally {
			if (ctx.refreshBtn) {
				ctx.refreshBtn.disabled = false;
				ctx.refreshBtn.removeClass("pt-refreshing");
			}
		}
	
}

export function updateRefreshTooltip(ctx: ViewContext) {

		if (!ctx.refreshBtn) return;
		const base = ctx.t("action.refresh");
		if (!ctx.lastListFetchAt) {
			ctx.refreshBtn.setAttribute("title", base);
			return;
		}
		ctx.refreshBtn.setAttribute(
			"title",
			`${base} · ${ctx.t("stats.updatedAt")} ${ctx.relativeTime(ctx.lastListFetchAt)}`
		);
	
}

export function relativeTime(ctx: ViewContext, ts: number) : string {

		return formatRelativeTime(ts, Date.now(), ctx.t);
	
}

export function reportNewPluginDelta(ctx: ViewContext, current: PluginInfo[], results: Record<string, TranslateResult>) {

		const currentIds = new Set(current.map((p) => p.id));
		// 集合 diff 委托给 utils.ts 的纯函数（Notice 文案拼装与 seen 集合更新留在本方法）
		const delta = computePluginDelta(
			currentIds,
			ctx.seenPluginIds,
			(id) => results[id]?.source ?? "original"
		);
		// 更新 seen 集合为本轮全集（差量已提取，下次以本轮为基线）
		ctx.seenPluginIds = currentIds;
		// 记录新插件首次见时间戳（供卡片「新」标记窗口判断）；已有 id 保持原值不变
		const now = Date.now();
		const fsMap = ctx.firstSeenMap;
		for (const id of currentIds) {
			if (!fsMap.has(id)) fsMap.set(id, delta.newIds.includes(id) ? now : 0);
		}

		// 首次加载或无新增：不弹增量提示
		if (delta.isFirstLoad || delta.newIds.length === 0) return;

		const parts = [
			ctx.t("refresh.newPlugins", { n: String(delta.newIds.length) }),
		];
		if (delta.translated > 0) parts.push(ctx.t("refresh.newTranslated", { n: String(delta.translated) }));
		if (delta.untranslated > 0) parts.push(ctx.t("refresh.newUntranslated", { n: String(delta.untranslated) }));
		new Notice(parts.join("，"));
	
}

export function mirrorConfig(ctx: ViewContext) : MirrorConfig {

		return {
			source: ctx.settings.mirrorSource,
			customBase: ctx.settings.mirrorCustomBase,
		};
	
}

export async function fetchStatsAndMerge(ctx: ViewContext) : Promise<void> {

		// 先同步合并磁盘缓存（不依赖网络）：保证 downloads/updated 立即可用，
		// 即便后续网络拉取失败也不会让「更新」等维度因 updated 缺失而筛空。
		ctx.mergeStatsFromCache();
		try {
			const url = resolveUrl(PLUGIN_STATS_URL, ctx.mirrorConfig());
			const map = await fetchPluginStats(url);
			ctx.statsMap = map;
			ctx.mergeStatsIntoPlugins();
			void ctx.saveStatsCache(map);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 拉取 stats 失败，复用缓存/旧值：", e);
		}

}

export function mergeStatsIntoPlugins(ctx: ViewContext) {

		for (const p of ctx.plugins) {
			const s = ctx.statsMap.get(p.id);
			if (s) {
				p.downloads = s.downloads;
				if (s.updated != null) p.updated = s.updated;
			}
		}
		// 下载量 / 更新时间被就地更新，智能信号（基于 downloads/updated）需失效重算
		ctx.pluginsRev++;
	
}

export function mergeStatsFromCache(ctx: ViewContext) {

		if (ctx.cachedStats) {
			ctx.statsMap = ctx.cachedStats;
		}
		ctx.mergeStatsIntoPlugins();
	
}

export function snapshotInstalled(ctx: ViewContext) {

		try {
			const plugins = asAppInternals(ctx.app).plugins;
			if (!plugins) return;
			if (plugins.manifests) {
				const next = new Set(Object.keys(plugins.manifests));
				// 收集已装插件本地版本号（供「可更新」检测对比官方最新版）
				const versions = new Map<string, string>();
				for (const [id, m] of Object.entries(plugins.manifests)) {
					if (m?.version) versions.set(id, m.version);
				}
				ctx.installedVersions = versions;
				const nextEnabled =
					plugins.enabledPlugins && typeof plugins.enabledPlugins.forEach === "function"
						? new Set(plugins.enabledPlugins as Set<string>)
						: ctx.enabledIds;
				// H2：安装/启用集合内容变化会改变「仅已安装」/「仅已启动」/「仅已安装未启动」筛选的匹配集，
				// 前缀缓存只减不增，必须失效，否则新装/新启插件在带搜索词时不出现。
				// 精化：installedIds/enabledIds 仅参与对应 installFilter 的成员判定
				// （搜索 blob 不含安装态，排序不走缓存），当前筛选为 "all" 时
				// 集合变化不影响缓存正确性，跳过 reset 保留前缀复用。
				if (
					ctx.installFilter === "installed" &&
					(next.size !== ctx.installedIds.size ||
						[...next].some((id) => !ctx.installedIds.has(id)))
				) {
					ctx.filterCache.reset();
				}
				const enabledChanged =
					nextEnabled.size !== ctx.enabledIds.size ||
					[...nextEnabled].some((id) => !ctx.enabledIds.has(id));
				if (ctx.installFilter === "enabled" && enabledChanged) {
					ctx.filterCache.reset();
				}
				if (ctx.installFilter === "installedNotEnabled" && (enabledChanged || next.size !== ctx.installedIds.size)) {
					ctx.filterCache.reset();
				}
				ctx.installedIds = next;
				ctx.enabledIds = nextEnabled;
				}
			} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取已安装插件失败：", e);
			}

			}

export function buildSearchIndex(ctx: ViewContext, ids?: Set<string>) {

		// 增量模式：仅更新「本次译出」的条目（ids 非空时），避免每次落盘都全量重建 5617 条 blob。
		if (ids && ids.size > 0) {
			const map = getPluginMap(ctx);
			for (const id of ids) {
				const p = map.get(id);
				if (p) ctx.searchIndex.set(id, buildSearchBlob(p, ctx.translatedResults[id]));
			}
			return;
		}
		ctx.searchIndex.clear();
		for (const p of ctx.plugins) {
			ctx.searchIndex.set(p.id, buildSearchBlob(p, ctx.translatedResults[p.id]));
		}

}

export function buildAuthorFacet(ctx: ViewContext) {

		// 插件集合刚被替换（数据重载 / 缓存加载 / 手动刷新），标记智能信号缓存失效
		ctx.pluginsRev++;
		const counts = new Map<string, number>();
		for (const p of ctx.plugins) {
			counts.set(p.author, (counts.get(p.author) ?? 0) + 1);
		}
		const multi = Array.from(counts.entries())
			.filter(([, c]) => c >= 2)
			.map(([name, count]) => ({ name, count }));
		ctx.authorFacetList = groupAuthorsByName(multi);
	
}

/**
 * 比较两个 semver 版本号（major.minor.patch，忽略前缀 v）。
 * @returns 负数 = a<b（a 旧），0 = 相等，正数 = a>b（a 新）
 */
function compareVersion(a: string, b: string): number {
	const pa = a.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
	const pb = b.replace(/^v/i, "").split(".").map((x) => parseInt(x, 10) || 0);
	for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
		const da = pa[i] ?? 0;
		const db = pb[i] ?? 0;
		if (da !== db) return da - db;
	}
	return 0;
}

// 防重入锁：视图生命周期内只跑一次（已装插件数量少，结果内存缓存即可，不落盘）
let outdatedRefreshing = false;

/**
 * 检测「可更新」：对【已安装】插件，拉官方 manifest 取最新 version，与本地对比。
 * 只对已装插件拉取（通常几十个），成本低；官方 community-plugins.json 不含 version 字段，
 * 故逐个 fetchManifest（带镜像容错 + 并发控制 + 单插件失败容错）。
 *
 * 完成后填充 ctx.outdatedIds / ctx.outdatedInfo，并触发可见窗口重渲染（不回顶）。
 */
export async function refreshOutdated(ctx: ViewContext): Promise<void> {
	if (outdatedRefreshing) return;
	if (!ctx.installedVersions || ctx.installedVersions.size === 0) return;
	outdatedRefreshing = true;
	try {
		// 构建 id → repo 映射（仅已装且官方列表有记录的插件）
		const repoOf = new Map<string, string>();
		for (const p of ctx.plugins) {
			if (ctx.installedVersions.has(p.id) && p.repo) repoOf.set(p.id, p.repo);
		}
		if (repoOf.size === 0) return;

		const mirror = ctx.mirrorConfig();
		const CONCURRENCY = 6;
		const ids = [...repoOf.keys()];
		let cursor = 0;
		const worker = async () => {
			while (cursor < ids.length) {
				const id = ids[cursor++];
				const local = ctx.installedVersions.get(id) ?? "";
				try {
					const manifest = await fetchManifest(repoOf.get(id), mirror);
					if (manifest.version && compareVersion(manifest.version, local) > 0) {
						ctx.outdatedIds.add(id);
						ctx.outdatedInfo.set(id, { local, latest: manifest.version });
					}
				} catch {
					/* 单插件失败容错：跳过，不影响整体 */
				}
			}
		};
		const workers = Array.from({ length: Math.min(CONCURRENCY, ids.length) }, () => worker());
		await Promise.all(workers);

		// 重渲染可见窗口（仅更新徽标，不回顶，避免列表跳动）
		if (ctx.outdatedIds.size > 0) ctx.scheduleRender();
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 检测可更新插件失败：", e);
	} finally {
		outdatedRefreshing = false;
	}
}

export function renderAuthorFacet(ctx: ViewContext) {

	if (!ctx.authorFacetEl) return;
	const selected = ctx.authorFilter ? [ctx.authorFilter] : [];
	ctx.authorFacetEl.empty();

	// 单层字母索引（A-Z + #），纯文本形态，与同级内容左对齐。
	// 只有存在作者的字母才显示，避免空字母占位。
	const letterSet = new Set(ctx.authorFacetList.map((g) => g.letter));
	const baseLetters = [
		"A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "K", "L", "M",
		"N", "O", "P", "Q", "R", "S", "T", "U", "V", "W", "X", "Y", "Z", "#",
	];
	const letters = baseLetters.filter((l) => letterSet.has(l));
	if (letters.length === 0) return;

	const strip = ctx.authorFacetEl.createDiv({ cls: "pt-facet-letter-strip" });
	for (const letter of letters) {
		const isActive = ctx.activeAuthorLetter === letter;
		const el = strip.createEl("button", {
			cls: "pt-facet-letter-btn" + (isActive ? " is-active" : ""),
			text: letter,
		});
		el.addEventListener("click", () => {
			ctx.activeAuthorLetter = ctx.activeAuthorLetter === letter ? null : letter;
			ctx.renderAuthorFacet();
		});
	}


	// 展开选中字母组的作者 chips（与字母索引同一左缘，不加缩进）
	if (ctx.activeAuthorLetter) {
		const group = ctx.authorFacetList.find((g) => g.letter === ctx.activeAuthorLetter);
		if (group) {
			const row = ctx.authorFacetEl.createDiv({ cls: "pt-facet-chips" });
			renderFacetChips(
				row,
				group.authors,
				selected,
				(a) => {
					ctx.toggleAuthorFilter(a);
				},
				{
					maxVisible: 12,
					expanded: ctx.authorExpanded,
					onToggleExpand: () => {
						ctx.authorExpanded = !ctx.authorExpanded;
						ctx.renderAuthorFacet();
					},
				}
			);
		}
	}

	
}

export function toggleAuthorFilter(ctx: ViewContext, author: string) {

		ctx.authorFilter = ctx.authorFilter === author ? null : author;
		ctx.renderAuthorFacet();
		ctx.updateFacetVisibility();
		ctx.scheduleRender(true);

		}

		export function updateAiTranslateButton(ctx: ViewContext) {

		const btn = ctx.aiTranslateBtnEl;
		if (!btn) return;

		// 未译计数：用 for 循环累加，避免 .filter() 每次渲染都新建一个 5617 元素的临时数组。
		// （此处不宜做缓存：计数会随每张卡译出而持续变化，缓存需随每次翻译失效=照样重算，
		// 唯一可省的是 .filter 的临时数组分配，循环计数即可规避。）
		let untranslatedCount = 0;
		for (const p of ctx.visibleList) {
			if (!ctx.isTranslated(p)) untranslatedCount++;
		}

		// 重置「有待翻译」的高亮态，后续按当前情形重新判定
		btn.classList.remove("pt-ai-icon-btn--ready");

		if (ctx.sourceFilter === "original") {
			// 已处于「未翻译」筛选态：按钮作为该态的重跑入口（常态化显示 + 高亮态）
			btn.setCssStyles({ display: "", opacity: "1" });
			btn.classList.add("pt-ai-icon-btn--ready");
			if (ctx.aiTranslateRunning) {
				btn.disabled = true;
				btn.title = ctx.t("ai.translate.running");
				return;
			}
			const s = ctx.settings;
			const hasKey = s.aiSearchEnabled && !!s.aiSearchApiKey;
			// 无论是否配置 AI Key 都启用：有 Key 优先用 AI，无 Key 自动降级到免费引擎混合翻译。
			btn.disabled = false;
			btn.title = hasKey ? ctx.t("ai.translate.rerun") : ctx.t("ai.translate.free");
		} else if (untranslatedCount > 0) {
			// 有待翻译：按钮常态化显示 + 染主题色，暗示「有事可做」
			btn.setCssStyles({ display: "", opacity: "1" });
			btn.classList.add("pt-ai-icon-btn--ready");
			btn.disabled = false;
			btn.title = ctx.t("ai.translate.hint", { n: String(untranslatedCount) });
		} else {
			// 全部已翻译：按钮仍常驻显示，但置灰禁用，避免有效插件消失带来的定位困扰
			btn.setCssStyles({ display: "", opacity: "1" });
			btn.disabled = true;
			btn.title = ctx.t("ai.translate.none");
		}

}

export async function aiTranslateAllPending(ctx: ViewContext) {

		const s = ctx.settings;
		// 不再强制要求 AI Key：有 Key 时优先用 AI 翻译，未配置则自动降级到
		// Google/MyMemory/腾讯免费引擎混合翻译（底层 translatePluginOnce 按优先级链处理）。
		if (ctx.aiTranslateRunning) {
			logger.debug("[Chinese Plugin Market] 智能混合翻译：正在运行中，跳过本次点击");
			return;
		}
		const data = ctx.translator.getData();
		const pending = ctx.visibleList.filter((p) => !ctx.isTranslated(p));
		logger.debug(`[Chinese Plugin Market] 智能混合翻译：visibleList=${ctx.visibleList.length} · pending=${pending.length} · aiEnabled=${s.aiSearchEnabled} · hasKey=${!!s.aiSearchApiKey}`);
		if (pending.length === 0) {
			ctx.setAIProgressDone(0);
			return;
		}
		ctx.aiTranslateRunning = true;
		ctx.updateAiTranslateButton();
		if (ctx.aiProgressEl) {
			ctx.aiProgressEl.setCssStyles({ display: "" });
			ctx.aiProgressEl.setText(
				ctx.t("ai.translate.progress", { done: "0", total: String(pending.length) })
			);
		}
		// 已刷新过的卡片去重，避免重复闪烁
		const handled = new Set<string>();
		// 批量翻译时逐卡高频 onProgress 会触发 refreshDone 全量遍历 visibleList（O(N)），
		// 5617 卡全量时 O(N²) 且每次都 updateStats 重建 DOM → 卡顿。
		// 优化：进度条单独高频更新（轻量）；卡片回填用「每 FLUSH_EVERY 个 + rAF 合并」节流，
		// finally 兜底全刷，保证不漏。
		let lastFlushedDone = 0;
		let refreshRAF: number | null = null;
		let rafQueued = false;
		const FLUSH_EVERY = 5;
		const doRefresh = () => {
			refreshRAF = null;
			rafQueued = false;
			for (const p of ctx.visibleList) {
				if (handled.has(p.id)) continue;
				const r = data.cache[p.id];
				if (r && r.source !== "original") {
					handled.add(p.id);
					ctx.translatedResults[p.id] = r;
					void ctx.refreshCardTranslation(p.id, r);
					// 本次会话主动翻译计数（懒翻译已移除，历史缓存命中不计入；这里 batch 翻的全是新的）
					ctx.translatedThisSession++;
				}
			}
			ctx.updateStats();
		};
		const scheduleRefresh = () => {
			if (rafQueued) return;
			rafQueued = true;
			refreshRAF = window.requestAnimationFrame(doRefresh);
		};
		try {
			await ctx.translator.translateBatchIncremental(
				ctx.visibleList,
				(done: number, total: number) => {
					if (done - lastFlushedDone >= FLUSH_EVERY) {
						lastFlushedDone = done;
						scheduleRefresh();
					}
					if (ctx.aiProgressEl) {
						ctx.aiProgressEl.setText(
							ctx.t("ai.translate.progress", { done: String(done), total: String(total) })
						);
					}
				}
			);
			logger.debug("[Chinese Plugin Market] 智能混合翻译：translateBatchIncremental 完成");
		} catch (e: unknown) {
			logger.error("[Chinese Plugin Market] 智能混合翻译：异常", e);
	} finally {
		ctx.aiTranslateRunning = false;
		if (refreshRAF !== null) window.cancelAnimationFrame(refreshRAF);
		doRefresh();
		ctx.buildSearchIndex();
		// 立即落盘（无防抖）：确保本次翻译结果（含 TM 已采纳 vault 笔记）在按钮流程结束时
		// 立刻写出，不依赖 800ms 防抖定时器——否则重载插件时定时器未触发会导致数据静默丢失，
		// 下次启动大量插件回到英文（本次实测 CJ vault 的 tmApproved/cache 均为 0 即此因）。
		await ctx.flushTranslatorData();
		ctx.setAIProgressDone(handled.size);
		ctx.updateAiTranslateButton();
	}
	
}

export function setAIProgressDone(ctx: ViewContext, n: number) {

		const el = ctx.aiProgressEl;
		if (!el) return;
		if (n === 0) {
			el.setCssStyles({ display: "none" });
			return;
		}
		el.setText(ctx.t("ai.translate.done", { n: String(n) }));
		ctx.announceStatus(ctx.t("ai.translate.done", { n: String(n) }));
		el.addClass("pt-ai-progress--done");
		window.setTimeout(() => {
			if (el) {
				el.setCssStyles({ display: "none" });
				el.removeClass("pt-ai-progress--done");
			}
		}, 4000);
	
}

export function refreshCardTranslation(ctx: ViewContext, id: string, result: TranslateResult) {

		// 架构重构：卡片固定高度，译文就地更新不改变行高，无需滚动冻结。
		const layer = ctx.scrollCardLayer;
		if (!layer) return;
		const card = toHTMLElement(
			layer.querySelector(`.pt-card[data-plugin-id="${CSS.escape(id)}"]`)
		);
		if (!card) return;
		const plugin = getPluginMap(ctx).get(id);
		if (!plugin) return;
			const nameEl = q(card, ".pt-card-name");
			const descEl = q(card, ".pt-card-desc");
		if (nameEl) nameEl.setText(cleanChineseSpaces(result.translatedName));
		if (descEl) {
			descEl.setText(cleanChineseSpaces(result.translatedDesc));
			descEl.classList.remove("pt-desc-pending"); // S4：译文到位，撤掉微光占位态
		}
		// 副标：在线翻译完成后同步状态，使其从「未翻译」翻转为「在线翻译」
		const subEl = q(card, ".pt-card-original-name");
		if (subEl) {
			if (result.source === "original") {
				subEl.textContent = ctx.t("card.original.hint");
				subEl.className = "pt-card-original-name pt-card-untranslated-hint";
			} else {
				subEl.textContent = plugin.name;
				subEl.className = "pt-card-original-name";
			}
		}
	
}


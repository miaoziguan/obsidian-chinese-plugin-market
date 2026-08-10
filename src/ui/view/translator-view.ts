/**
 * 主视图 ChinesePluginMarketView（Obsidian ItemView 子类）。
 *
 * 视图生命周期与容器搭建，并把渲染/数据/卡片/工具栏职责委托给
 * view-render / view-data / view-cards / view-chrome 等模块。
 */

import {
	ItemView,
	WorkspaceLeaf,
	Platform,
} from "obsidian";
import { toHTMLElement } from "@ui/dom/dom";
import { Translator, type PluginInfo, type TranslateResult, type AISearchResult } from "@domain/catalog/translator";
import { type MirrorSource } from "@domain/catalog/mirror";
import { type PluginStat } from "@domain/catalog/stats";
import { type SortBy } from "@domain/filter/sort";
import {
	FilterCache,
	type SearchMode,
	type SourceFilter,
	type InstallFilter,
} from "@domain/filter/filter";
import { makeT, type I18nKey } from "@shared/i18n";
import { type CardRenderContext } from "@ui/components/card-render";
import type { PluginDetailDrawer } from "@ui/components/detail-drawer";
import { type SignalId } from "@domain/filter/smart-signal";
import { type ListState } from "@ui/dom/list-state";
import { TrendingEngine } from "@domain/recommend/trending";
import { InvertedIndex } from "@domain/recommend/similar";
import { type AuthorGroup } from "@translation/lexicon/pinyin-init";

import type ChinesePluginMarketPlugin from "@app/plugin";
// ──────────────────────────────────────────
// 常量
// ──────────────────────────────────────────

// 全局常量（VIEW_TYPE / LAYOUT / SEARCH_MODES / PLUGINS_URL）已收敛至 ./constants，
// 作为唯一来源，避免 view 模块跨文件引用本中枢模块的常量（审计 P2-4）。
import { VIEW_TYPE, LAYOUT } from "@shared/constants";
import { cancelIdle } from "@shared/platform";

export interface ChinesePluginMarketSettings {
	useMyMemory: boolean;
	secretId: string;
	secretKey: string;
	region: string;
	sourceFilter: SourceFilter;
	// AI 智能搜索
	aiSearchEnabled: boolean;
	aiSearchBaseURL: string;
	aiSearchApiKey: string;
	aiSearchModel: string;
	aiSearchShowReason: boolean;
	// Embedding 向量召回（阶段 2 + 2.5）
	embeddingSource: "keyword" | "api" | "local";
	embeddingBaseURL: string;
	embeddingApiKey: string;
	embeddingModel: string;
	// 本地模型（阶段 2.5）
	embeddingLocalModel: string;
	embeddingLocalWasmPaths: string;
	// 数据源镜像（产品改进 #10）
	mirrorSource: MirrorSource;
	mirrorCustomBase: string;
	// 自托管翻译源（DeepLX / LibreTranslate 等本地服务，零成本、质量优先；不填则不启用）
	selfHostedTranslators: { type: "deeplx" | "libretranslate"; baseUrl: string }[];
	// 结果排序（产品改进 #5）
	sortBy: SortBy;
	// 个人收藏集：用户主动收藏的插件 id（持久化，随使用时间复利）
	favorites: string[];
	/** 选品对比集：用户暂存比对清单的插件 id（跨会话持久化） */
	compare: string[];
}

export const DEFAULT_SETTINGS: ChinesePluginMarketSettings = {
	useMyMemory: true,
	secretId: "",
	secretKey: "",
	region: "ap-guangzhou",
	sourceFilter: "all",
	aiSearchEnabled: false,
	aiSearchBaseURL: "https://api.deepseek.com",
	aiSearchApiKey: "",
	aiSearchModel: "deepseek-chat",
	aiSearchShowReason: false,
	embeddingSource: "local", // 默认走本地向量（bge-small-zh-v1.5 + WebGPU，vault-curate 同款方案）
	embeddingBaseURL: "https://api.openai.com",
	embeddingApiKey: "",
	embeddingModel: "text-embedding-3-small",
	embeddingLocalModel: "Xenova/bge-small-zh-v1.5",
	embeddingLocalWasmPaths: "",
	mirrorSource: "github", // 默认走 GitHub 原始源；不再自动探测/切换其它镜像
	mirrorCustomBase: "",
	selfHostedTranslators: [], // 默认无自托管翻译源，行为完全不变
	sortBy: "relevance",
	favorites: [],
	compare: [],
};

/**
 * 平台感知的默认设置工厂（#6：移动端语义搜索降级）。
 * 桌面端沿用 DEFAULT_SETTINGS（embeddingSource = "local"）；
 * 移动端默认 "keyword"（零 WASM），避免 26MB ONNX WASM 弱网下载慢 +
 * 模型加载/推理吃内存拖垮整个 Obsidian，甚至 4 分钟 worker 初始化超时致语义搜索失效。
 * 用户仍可在设置页手动切到 local（自担风险）。
 */
export function getDefaultSettings(): ChinesePluginMarketSettings {
	// 测试/非常规环境下 Platform 可能未定义或访问抛错，统一按桌面端默认处理（embeddingSource = "local"）。
	let isMobile = false;
	try {
		isMobile = typeof Platform !== "undefined" && Platform.isMobile === true;
	} catch {
		isMobile = false;
	}
	return isMobile
		? { ...DEFAULT_SETTINGS, embeddingSource: "keyword" }
		: { ...DEFAULT_SETTINGS };
}

// ──────────────────────────────────────────
// 翻译视图
// ──────────────────────────────────────────


import { loadAndRender, updateGuidance, updateFacetVisibility, showSearchGuide, showAIPendingHint, showAIConfigGuide, showLoadingState, updateStats, applyAIConfig, announceStatus, updateScrollButtons, updateScrollPosBadge } from "@ui/view/view-chrome";
import { ensureDataLoaded, fetchPlugins, refreshData, updateRefreshTooltip, relativeTime, reportNewPluginDelta, mirrorConfig, fetchStatsAndMerge, mergeStatsIntoPlugins, mergeStatsFromCache, snapshotInstalled, buildSearchIndex, buildAuthorFacet, renderAuthorFacet, toggleAuthorFilter, updateAuthorBanner, applySearchInput, aiTranslateAllPending, setAIProgressDone, refreshCardTranslation, updateAiTranslateButton, disposeViewDataCache } from "@ui/view/view-data";
import { runAISearch } from "@ui/view/view-ai-search";
import { renderPluginList, recomputeSmartSignalsIfNeeded, runFilterPipeline, updateListChrome, invalidateAndRender, postRenderSync, refreshCardState, measureLayout, measureLayoutIfNeeded, scheduleRender, renderWindow, fillVisibleWindow, updateWindow, disposeRenderTimers } from "@ui/view/view-render";
import { startInstalledWatch } from "@ui/view/installed-watch";
import { onCardClick, toggleFavorite, onCardKeydown, focusCardByIdx, flashAction, computeSimilarFor, openDetailDrawer as _openDetailDrawer } from "@ui/view/view-cards";
import { renderFeaturedSection, ensureFeaturedSection, hideFeaturedSection } from "@ui/view/view-featured";
import { createViewContext, type ViewContext } from "@ui/view/view-context";
import { updateCompareTray, openCompareModal, enterCompareMode, exitCompareMode } from "@ui/view/view-compare";
import { disposeComparePage } from "@ui/components/compare-view";

export class ChinesePluginMarketView extends ItemView {
	public translator: Translator;
	public plugin: ChinesePluginMarketPlugin;
	public plugins: PluginInfo[] = [];
	public translatedResults: Record<string, TranslateResult> = {};
	public searchQuery = "";
	/** facet 行重渲染回调（由 view-toolbar 装配时经 ctx 写入；装配前为 no-op） */
	public refreshFacets: () => void = () => {};
  /** 对比模式标记（对比模式下替换列表内容为对比页面） */
  public compareMode = false;
  /** 当前打开的详情抽屉（与对比模式互斥，同时只能存在一个） */
	public activeDrawer: PluginDetailDrawer | null = null;
	/** 数据是否已加载（产品定位：默认不加载，首次搜索时才拉取+翻译） */
	public dataLoaded = false;
	/** 数据加载进行中，避免重复触发 */
	public dataLoading = false;
	/** 上次成功拉取社区插件列表的时间戳（ms），用于 TTL 自动失效判断是否需重拉 */
	public lastListFetchAt = 0;
	/** 手动刷新按钮引用（用于刷新中置灰 + tooltip 更新上次更新时间） */
	public refreshBtn: HTMLButtonElement | null = null;
	/** 列表区单一状态机（guide/loading/error/aiPending/aiConfig/list）。计数可见性由状态派生。 */
	public listState: ListState = "guide";
	/** 渲染排期专用 rAF 标志，与 scrollRAF 分离，避免两者互相丢弃对方的帧 */
	public renderRAF = 0;
	public descRAF = 0; // 与 scheduleRender 分离，防止描述展开回调被吞
	/** 视图已卸载标记：卸载后置 true，异步路径据此尽早退出（见 onClose） */
	public disposed = false;
	/** 已安装状态监听的清理函数（#14：fs.watch 桌面 / 轮询移动），onClose 时调用 */
	public installedWatchDispose: (() => void) | null = null;
	/** 结果计数元素引用（常驻工具栏内，搜索后显示「找到 N 个插件」） */
	public resultCountEl: HTMLElement | null = null;
	/** 「AI 一键翻译」按钮与进度元素（仅筛选「未翻译」时显示，聚焦 AI 战略） */
	public aiTranslateBtnEl: HTMLButtonElement | null = null;
	public aiProgressEl: HTMLElement | null = null;
	public aiTranslateRunning = false;
	/** 本次会话用户主动触发的翻译计数（历史缓存命中不计入）。见 ViewContext.translatedThisSession */
	public translatedThisSession = 0;

	/** AI 搜索状态 */
	public aiSearchResult: AISearchResult | null = null;
	public aiSearchPending = false;
	public aiSearchQueryCache = "";
	/** 最近一次 AI 搜索结果缓存（3a：跨模式切换复用，避免切回 AI 模式即丢失需重新 Enter） */
	public lastAiSearchResult: AISearchResult | null = null;
	public lastAiSearchQuery = "";

	/** 当前搜索模式 */
	public searchMode: SearchMode = "keyword";

	/** 界面文案函数，返回中文文案 */
	public readonly t: (key: I18nKey, vars?: import("@shared/i18n").I18nVars) => string = makeT();

	/** 判断插件是否有任何译文（本次会话或历史落盘）。
	 *  用于"从未翻译"筛选：排除所有已有译文的插件，只显示真正从未被翻译过的。 */
	public isTranslated(plugin: PluginInfo): boolean {
		// 1) 本次会话已翻译
		if ((this.translatedResults[plugin.id]?.source ?? "original") !== "original") return true;
		// 2) 历史落盘译文（cache 非 original / TM 已采纳 / AI 固化资产）
		return this.translator.hasAnyTranslation(plugin.id, plugin);
	}

	// ── 视图滚动状态（原生滚动 + content-visibility 窗口化懒填充）──
	public scrollViewport: HTMLElement | null = null;
	public scrollCardLayer: HTMLElement | null = null;
	// 两个滚动快捷按钮（回到顶部 / 一键置底），存字段供类方法统一同步可见性
	public backTopBtn: HTMLButtonElement | null = null;
	public scrollBottomBtn: HTMLButtonElement | null = null;
	public visibleList: PluginInfo[] = []; // 过滤+排序后的完整列表（不创建 DOM）
	// 选品对比：内存态选中集合（不持久化）；对比集数量不限
	public compareSet: Set<string> = new Set();
	// 个人收藏集：持久化到 settings.favorites，开视图时水合为 Set 供 O(1) 判定
	public favoritesSet: Set<string> = new Set();
	// 「仅看收藏」筛选开关（工具栏 toggle，不持久化）
	public sortFavoritesFirst = false;
	public compareTrayEl: HTMLElement | null = null;
	public scrollRAF = 0;
	/** 滚动速度采样（像素/秒）：由滚动监听按 ΔscrollTop/Δt 实时估算，供 PREFETCH_ROWS 速度自适应 */
	public scrollVelocity = 0;
	/** 速度采样基线（上一次 scroll 事件的 scrollTop 与 timestamp） */
	public lastScrollTopSample = 0;
	public lastScrollSampleAt = 0;
	/** requestIdleCallback 句柄：fillVisibleWindow 超量分帧填充的挂起任务，卸载时取消避免幽灵写盘 */
	public fillIdleHandle: number | null = null;
	public measureRAF = 0; // 与 scrollRAF 分离，避免 ResizeObserver 与 scroll 互相丢弃对方帧
	public colCount = 0; // 当前可见列数，由测量得到并同步给 grid
	// ── 固定网格行高缓存（per-view 实例字段）──
	/** 固定网格行高缓存（卡片高 + 行距），供滚动时可见窗口计算复用，避免每帧 getComputedStyle 回流 */
	public cachedRowH = 0;
	/** 布局参数是否失效：尺寸/列数变化后置 true，measureLayout 仅在脏时重新测量 */
	public layoutDirty = true;
	/** scrollHeight 缓存：内容/列数不变时为常量，updateScrollButtons 每帧复用避免强制重排；失效时为 null 回退实测 */
	public cachedScrollHeight: number | null = null;
	/** 插件 id→PluginInfo 查表缓存（per-view，消除 refreshCardTranslation 内 O(n) 线性扫描） */
	public pluginMap: Map<string, PluginInfo> | null = null;
	/** pluginMap 的失效键（以 pluginsRev 版本号为键，数据被替换/合并时失效重建） */
	public pluginMapSrc: number | null = null;
	public defaultRowH: number = LAYOUT.DEFAULT_ROW_H; // 固定卡片行高的 fallback 值（实测前/兜底）
	public rowGap: number = LAYOUT.DEFAULT_ROW_GAP; // 卡片行间距（来自 CSS grid gap），运行时由实测值覆盖
	public resizeObserver: ResizeObserver | null = null;
	public debounceTimer: number | undefined;
	/** 虚拟滚动卡片元素池：滚出窗口的卡片入池，滚入时原地更新内容复用，省掉重复建节点 / SVG 重解析 */
	public cardPool: HTMLElement[] = [];
	/** 窗口外未填充内容的卡片集合：renderWindow 窗口化懒填充时登记，进入视口由 fillVisibleWindow 填充 */
	public pendingCards: Set<HTMLElement> = new Set();
	/** 卡片骨架构建上下文（仅用 t + onDescToggle），常驻供池化元素复用 */
	public cardPoolCtx: CardRenderContext | null = null;
	/** 插件 id → 卡片 DOM 的持久化索引：renderWindow 增量复用，避免每次搜索词变化全量 querySelectorAll（O(N)） */
	public cardById: Map<string, HTMLElement> = new Map();
	/** 列表身份签名（S2）：mode+query+id 序列一致时走原地刷新，不清 DOM、不回顶、不丢行高缓存 */
	public lastListSignature = "";
	/** #3 虚拟滚动：当前已渲染窗口 [windowStart, windowEnd)，滚动时若未越界则跳过重排 */
	public windowStart = 0;
	public windowEnd = 0;
	/** 滚动位置指示徽标（S7）：滚动中显示「第 x / 共 n」，滚停淡出 */
	public scrollPosEl: HTMLElement | null = null;
	public scrollPosTimer: number | undefined;
	/** 滚动位置徽标上次写入文本（避免每帧无变化重写 textContent） */
	public lastScrollPosText = "";

	// ── 搜索索引（小写化 Blob 预计算 + 前缀增量缓存） ──
	public searchIndex: Map<string, string> = new Map(); // pluginId → 小写化搜索串
	// 前缀增量缓存（由 FilterCache 封装，减少视图层字段散落）
	public filterCache = new FilterCache();

	// ── 插件统计（下载量/更新时间，产品改进 #1 #6）──
	public statsMap: Map<string, PluginStat> = new Map();

	// ── 已安装/已启用状态（产品改进 #7）──
	public installedIds: Set<string> = new Set();
	public enabledIds: Set<string> = new Set();

	// ── 结果排序（产品改进 #5）。初值来自持久化设置，UI 切换即时生效并保存。──
	public sortBy: SortBy = "relevance";

	constructor(leaf: WorkspaceLeaf, plugin: ChinesePluginMarketPlugin) {
		super(leaf);
		this.plugin = plugin;
		this.translator = plugin.translator;
		// 恢复持久化的来源筛选与排序偏好（产品改进 #5）
		this.sourceFilter = plugin.settings.sourceFilter;
		this.sortBy = plugin.settings.sortBy;
		// 水合收藏集（从持久化 settings.favorites 恢复为 Set）
		this.favoritesSet = new Set(plugin.settings.favorites);
		// 水合对比集（从持久化 settings.compare 恢复为 Set，跨会话保留）
		this.compareSet = new Set(plugin.settings.compare);
		// 跨会话恢复列表拉取时间：避免 lastListFetchAt 重启归零导致 isListStale(0,now,6h)
		// 恒真 → 每次启动都强制重拉列表 + 重译可见项（修复「每次重启都要重新加载翻译」）
		this.lastListFetchAt = plugin.lastListFetchAt;
	}

	getViewType(): string {
		return VIEW_TYPE;
	}

	/** ViewContext 懒加载缓存（P3 审计发现 8：替代 bind 模板） */
	private __ctx?: ViewContext;
	private get _ctx(): ViewContext {
		if (!this.__ctx) this.__ctx = createViewContext(this);
		return this.__ctx;
	}

	getDisplayText(): string {
		return "插件搜索";
	}

	getIcon(): string {
		return "languages";
	}

	async onOpen() {
		// 标记所属 leaf（替代 :has 选择器），供 CSS 隐藏该 leaf 的 view-header
		this.containerEl.closest?.(".workspace-leaf-content")?.addClass("pt-pt-view-leaf");
		// 卡片池化骨架构建上下文：类型需满足 CardRenderContext（骨架只用 t + onDescToggle，其余为占位）。
		// 集合字段用 getter 透传：installedIds/enabledIds 在数据刷新时会被整体替换（新 Set），
		// 值拷贝快照会让池化新卡引用陈旧集合（L2 埋雷）。
		// eslint-disable-next-line @typescript-eslint/no-this-alias -- 池化骨架的卡片渲染上下文需用 getter 透传 this，闭包内无法用箭头函数替代（getter 依赖实例字段随刷新整体替换）
		const self = this;
		this.cardPoolCtx = {
			t: this.t,
			get installedIds() { return self.installedIds; },
			get enabledIds() { return self.enabledIds; },
			get aiSearchResult() { return self.aiSearchResult; },
			// 卡片高度已固定（CSS contain + 锁高），描述展开不再改变布局，无需重绘
			onDescToggle: () => {},
			// 「🍎 系统翻译」成功 → 落库沉淀（cache + tmApproved），下次直接命中复用
			onSysTranslatePersist: (pid, name, desc) => {
				self.translator.persistSystemTranslation(pid, name, desc);
				self.plugin.saveTranslatorData();
			},
		};
		await this.loadAndRender();
		// #14：启动已安装状态实时同步（桌面 fs.watch / 移动轮询），视图关闭时释放
		this.installedWatchDispose = startInstalledWatch(this._ctx);
		// T4(#7): 注册分类标签加载完成回调，刷新 facet（标签可能晚于首屏就绪）；
		// 若打开视图时标签已就绪（竞态：加载早于视图打开），立即补刷一次。
		this.plugin.onPluginTagsLoaded = () => {
			if (this.disposed) return; // 视图已关闭：不再向已销毁的 DOM 写入
			this._ctx?.refreshFacets?.();
		};
		if (this.plugin.translator.tagService.getAllCategories().length > 0) {
			this._ctx?.refreshFacets?.();
		}
	}

	async onClose() {
		// 标记视图已卸载：所有后续异步路径（翻译、落盘定时器）据此尽早退出，避免幽灵写盘
		this.disposed = true;
		this.compareMode = false;
		// 解绑标签加载回调：plugin 是单例，留着会一直持有本视图闭包（内存泄漏 + 幽灵刷新）
		if (this.plugin.onPluginTagsLoaded) this.plugin.onPluginTagsLoaded = null;
		// 卸载对比页生命周期资源（document click 监听器 / in-flight AI 请求），
		// 视图直接关闭时 exitCompareMode 不会被走到
		{
			const cc = toHTMLElement(this.contentEl.querySelector(".pt-compare-container"));
			if (cc) disposeComparePage(cc);
		}
		// 关闭详情 Drawer
		this.activeDrawer?.close();
		this.activeDrawer = null;
		this.resizeObserver?.disconnect();
		this.resizeObserver = null;
		if (this.scrollRAF) {
			window.cancelAnimationFrame(this.scrollRAF);
			this.scrollRAF = 0;
		}
		if (this.renderRAF) {
			window.cancelAnimationFrame(this.renderRAF);
			this.renderRAF = 0;
		}
		if (this.measureRAF) {
			window.cancelAnimationFrame(this.measureRAF);
			this.measureRAF = 0;
		}
		if (this.debounceTimer) {
			window.clearTimeout(this.debounceTimer);
			this.debounceTimer = undefined;
		}
		// #14：释放已安装状态监听（关闭 fs.watch / 清除轮询定时器）
		if (this.installedWatchDispose) {
			this.installedWatchDispose();
			this.installedWatchDispose = null;
		}
		// Bug fix: 清理懒翻译定时器，避免视图销毁后仍触发网络请求
		if (this.translateVisibleTimer) {
			window.clearTimeout(this.translateVisibleTimer);
			this.translateVisibleTimer = undefined;
		}
		// S7: 清理滚动位置徽标定时器
		if (this.scrollPosTimer) {
			window.clearTimeout(this.scrollPosTimer);
			this.scrollPosTimer = undefined;
		}
		// #4: 取消挂起的空闲分帧填充任务，避免对已销毁 DOM 写盘
		if (this.fillIdleHandle !== null) {
			cancelIdle(this.fillIdleHandle);
			this.fillIdleHandle = null;
		}
		this.scrollVelocity = 0;
		this.scrollPosEl = null;
		// 释放卡片池（游离 DOM 引用），避免视图销毁后内存滞留
		this.cardPool = [];
		this.cardById.clear();
		this.cardPoolCtx = null;
		// 选品对比：视图关闭时彻底重置（内存 + 硬盘），下次打开不再保留上次选择
		this.compareSet.clear();
		if (this.plugin.settings.compare.length > 0) {
			this.plugin.settings.compare = [];
			void this.plugin.flushSaveSettings();
		}
		this.removeCompareTray();
		// 清理当前视图的渲染状态（防抖落盘定时器 / 脏索引集合 / 行高缓存）与翻译查表缓存，
		// 避免视图销毁后残留定时器对死 ctx 写盘、或滞留 5617 条插件映射
		if (this._ctx) {
			disposeRenderTimers(this._ctx);
			disposeViewDataCache(this._ctx);
		}
	}

	// ───────── 选品对比（产品改进：插件对比） ─────────
public updateCompareTray = () => updateCompareTray(this._ctx);

	public removeCompareTray() {
		if (this.compareTrayEl) {
			this.compareTrayEl.remove();
			this.compareTrayEl = null;
		}
	}

	public refreshCompareHighlights() {
		const cards = this.contentEl.querySelectorAll(".pt-card-compare");
		cards.forEach((el) => {
			const card = toHTMLElement(el.closest(".pt-card"));
			const pid = card?.getAttribute("data-plugin-id");
			el.classList.toggle("is-compare-on", !!pid && this.compareSet.has(pid));
		});
	}
public openCompareModal = () => openCompareModal(this._ctx);

	/** 切换到对比模式（替代 Modal，使用视图内全宽布局） */
public enterCompareMode = () => enterCompareMode(this._ctx);

	/** 退出对比模式，恢复列表视图 */
public exitCompareMode = () => exitCompareMode(this._ctx);

	/** 当前来源筛选（"all" 表示全部） */
	public sourceFilter: SourceFilter = "all";
	/** 安装状态筛选（"all" / "uninstalled"，产品改进 #7） */
	public installFilter: InstallFilter = "all";
	/** 仅看收藏：只展示 favoritesSet 内的插件（独立于 sortFavoritesFirst 的「优先置顶」） */
	public favoriteFilter = false;
	/** AI/关键字模式：当前选中的分类 facet（空数组表示不筛选，零回归） */
	public selectedCategories: string[] = [];
	/** 作者维度：当前按作者精确筛选（null 表示不过滤）。卡片作者钻取与作者 facet 共用此状态 */
	public authorFilter: string | null = null;
	/** 作者维度：作品数≥2 的多插件作者列表（facet 快捷筛选；长尾单插件作者走卡片钻取/搜索） */
	public authorFacetList: AuthorGroup[] = [];
	/** 作者 → 作品数（全量统计，供 author banner 显示作者真实作品数，不受当前筛选影响） */
	public authorCounts: Map<string, number> = new Map();
	/** 作者字母筛选：选中的首字母（null = 不展开任何组，只显示字母条） */
	public activeAuthorLetter: string | null = null;
	/** 作者 facet 展开态（字母组作者 > maxVisible 时「更多 ▾/收起 ▴」状态） */
	public authorExpanded = false;
	/** 作者 facet 相关 DOM 引用（数据加载后重渲染 + 按模式显隐） */
	public facetContainerEl: HTMLElement | null = null;
	public catRowEl: HTMLElement | null = null;
	public authorRowEl: HTMLElement | null = null;
	/** 搜索模式引导行（无查询时显示当前模式的一句话提示） */
	public guidanceEl: HTMLElement | null = null;
	/** 离线智能信号缓存（插件 id → 信号列表），由 renderPluginList 在数据就绪时计算并传给卡片渲染 */
	public smartSignals: Map<string, SignalId[]> = new Map();
	/** 智能信号失效版本：this.plugins 被替换或 stats 就地合并后自增，
	 *  使 computeSmartSignals（全量 O(n log n) 排序）只在数据真正变化时才跑，
	 *  避免在每次按键搜索时被无谓重算（搜索卡顿的主要来源之一）。 */
	public pluginsRev = 0;
	public smartSignalsRev = -1;
	// ── 推荐引擎 ──
	/** 趋势评分引擎，在 recomputeSmartSignalsIfNeeded 时同步更新 */
	public trendingEngine = new TrendingEngine();
	/** 趋势评分缓存 (id → 0-1) */
	public trendingScores = new Map<string, number>();
	/** 综合推荐评分缓存 (id → 0-100) */
	public recommendScores = new Map<string, number>();
	/** 标签倒排索引 */
	public invertedIndex = new InvertedIndex();
	public authorFacetEl: HTMLElement | null = null;
	/** 键盘导航：当前聚焦的卡片在 visibleList 中的索引（-1 表示无聚焦） */
	public focusedCardIdx = -1;
	/** 作者过滤状态 banner（显示「正在查看 XXX 的 N 个插件 | ✕ 清除」） */
	public authorBannerEl: HTMLElement | null = null;

	/** 掩埋点：从本地缓存恢复插件列表（网络不可用时应急） */
	public async tryLoadCachedPluginList(): Promise<PluginInfo[] | null> {
		const cached = await this.plugin.loadPluginListCache();
		return cached && cached.length > 0 ? (cached as PluginInfo[]) : null;
	}

	/**
	 * 打开插件详情页（主视图内整页替换方案 B）。委托给模块函数处理创建/复用。
	 */
	public openDetailDrawer = (pluginId: string, triggerCard: HTMLElement | null) => _openDetailDrawer(this._ctx, pluginId, triggerCard);

	/** 进入详情页模式：隐藏列表（scrollViewport + featured），让详情抽屉整页铺满 */
	public enterDetailMode = () => {
		this.contentEl.addClass("pt-detail-mode");
		if (this.scrollViewport) this.scrollViewport.setCssStyles({ display: "none" });
		const featuredEl = toHTMLElement(this.contentEl.querySelector(".pt-featured"));
		if (featuredEl) featuredEl.setCssStyles({ display: "none" });
	};

	/** 退出详情页模式：恢复列表，清理抽屉引用 */
	public exitDetailMode = () => {
		this.contentEl.removeClass("pt-detail-mode");
		if (this.scrollViewport) {
			this.scrollViewport.setCssStyles({ display: "", visibility: "visible", opacity: "1" });
		}
		const featuredEl = toHTMLElement(this.contentEl.querySelector(".pt-featured"));
		if (featuredEl) featuredEl.setCssStyles({ display: "" });
		this.activeDrawer = null;
		// 关闭丝滑优化：列表 DOM 在详情态只是 display:none 藏着，恢复显示是瞬时的；
		// 强制重渲（过滤管线 + 全量渲染）推迟到下一帧，避免与关闭点击挤同一帧。
		window.requestAnimationFrame(() => {
			// 视图可能在帧间被卸载/再次进入详情态
			if (this.activeDrawer || !this.scrollViewport?.isConnected) return;
			this.renderPluginList(true);
		});
	};

	/**
	 * 计算当前插件（info）的相似推荐（分类+标签+描述混合评分）。
	 * 零网络开销，全部基于本地数据。
	 */
public computeSimilarFor = (info: PluginInfo) => computeSimilarFor(this._ctx, info);
	/** 官方推荐：仅展示推荐清单内插件（高级区「推荐」胶囊切换，false 表示不过滤） */
	public recommendedOnly = false;
	/** 官方推荐：顶部置顶区容器（默认无搜索词时强曝光） */
	public featuredSectionEl: HTMLElement | null = null;
	/** 官方推荐：顶部置顶区的卡片网格容器 */
	public featuredGridEl: HTMLElement | null = null;
	/** 官方推荐：置顶区是否折叠 */
	public featuredCollapsed = false;

	/** 加载数据并渲染 */
	public loadAndRender = () => loadAndRender(this._ctx);

	/**
	 * 搜索引导空态：默认打开视图时展示，提示用户「输入关键词开始搜索」。
	 * 数据与卡片均不渲染，直到首次搜索触发 ensureDataLoaded。
	 */

	/**
	 * 卡片事件委托处理（列表层与「官方推荐」置顶区共用）。
	 * 点击作者名 → 作者钻取；点击对比/详情/复制/仓库/市场 → 对应动作。
	 */
public onCardClick = (ev: MouseEvent) => onCardClick(this._ctx, ev);
public toggleFavorite = (pid: string) => toggleFavorite(this._ctx, pid);

	/**
	 * 键盘导航处理（方向键卡片漫游 + Enter 打开详情 + Tab 进入卡片内部操作）。
	 * 绑定在卡片层（pt-list-layer），与事件委托同层。
	 */
public onCardKeydown = (ev: KeyboardEvent) => onCardKeydown(this._ctx, ev);

public focusCardByIdx = (idx: number) => focusCardByIdx(this._ctx, idx);

	/**
	 * 顶部「官方推荐」置顶区：默认无搜索词、无筛选时强曝光 plugin-recommend.json 中的插件。
	 * 条件不满足（如切到浏览/AI 模式、有搜索词、已开推荐筛选）则隐藏，避免与列表重复曝光。
	 */
public renderFeaturedSection = () => renderFeaturedSection(this._ctx);

	/** 懒创建置顶区 DOM，并插入到滚动列表视口之前（静态区，始终可见，即「置顶」） */
public ensureFeaturedSection = () => ensureFeaturedSection(this._ctx);

	/** 隐藏「官方推荐」置顶区（条件不满足时调用） */
public hideFeaturedSection = () => hideFeaturedSection(this._ctx);

	public showSearchGuide = () => showSearchGuide(this._ctx);

	/**
	 * 统一执行一次搜索输入逻辑（供 debounce 后的 input 事件与示例词 chip 即时点击共用）。
	 * 去首尾空格、空查询回引导、AI 模式等待 Enter、其余模式触发懒加载+渲染。
	 */
public applySearchInput = () => applySearchInput(this._ctx);

	/**
	 * AI 模式「等待 Enter」轻提示：输入期间不触发加载/渲染，
	 * 仅告诉用户按 Enter 才会执行语义搜索，避免误以为已经卡住。
	 */
public showAIPendingHint = () => showAIPendingHint(this._ctx);

	/**
	 * AI 搜索未配置时的内联引导（替代纯 Notice 提示，用户不会看不到就消失）。
	 * 在列表区渲染明确的配置指引，告诉用户去哪里开启。
	 */
public showAIConfigGuide = (reason: "disabled" | "noKey") => showAIConfigGuide(this._ctx, reason);

	/**
	 * 列表区「加载中」空态：首搜拉取+翻译期间直接渲染到 layer，
	 * 让用户看到明确进度（不要藏在折叠的统计区里）。
	 */
public showLoadingState = (message: string) => showLoadingState(this._ctx, message);

	/** 恢复统计行显示并更新内容（首屏加载时 stats 被 display:none 隐藏后需恢复） */
public updateStats = () => updateStats(this._ctx);

	/**
	 * 把 AI 搜索配置同步给翻译引擎用于 AI 翻译（聚焦 AI 战略，一套配置驱动翻译+搜索）。
	 * 未启用 AI 搜索或未配 apiKey 时传 null，翻译走原机翻路径（零回归）。
	 */
public applyAIConfig = () => applyAIConfig(this._ctx);

	/**
	 * 懒加载数据：首次搜索时调用。幂等——已加载或正在加载则直接 resolve。
	 * 负责拉取 community-plugins.json、增量翻译、落盘缓存、重建搜索索引，
	 * 完成后把当前 searchQuery 交给 renderPluginList 渲染结果。
	 */
public ensureDataLoaded = async () => {
		const loaded = await ensureDataLoaded(this._ctx);
		// 拉取成功 → 把 ctx 内存时间戳回写到 plugin 级字段，
		// 随 _saveTranslatorDataImmediate 持久化，修复重启后 lastListFetchAt 归零
		// 导致 isListStale(0,now,6h) 恒真 → 每次启动都重拉 + 重译。
		if (loaded) this.plugin.lastListFetchAt = this.lastListFetchAt;
		return loaded;
	};

	/**
	 * 按当前设置的数据源拉取插件列表：
	 * 不再做镜像容错探测/自动切换，失败直接抛错，由上层渲染错误态。
	 */
public fetchPlugins = () => fetchPlugins(this._ctx);

	/**
	 * 手动刷新：重新拉取最新社区插件列表 + stats，覆盖本地快照。
	 * 用户随时点击「↻」即可看到新上架插件，无需重启 Obsidian（产品改进 #15）。
	 * 刷新期间按钮置灰防重入；失败回退到当前已加载数据并提示。
	 */
public refreshData = () => refreshData(this._ctx);

	/** 把刷新按钮的 tooltip 更新为「上次更新时间」相对描述（产品改进 #15） */
public updateRefreshTooltip = () => updateRefreshTooltip(this._ctx);

	/** 把时间戳格式化为「刚刚 / N 分钟前 / N 小时前 / N 天前」相对描述，弱化缓存滞后感 */
public relativeTime = (ts: number) => relativeTime(this._ctx, ts);

	/**
	 * 本地「新增插件翻译增量」感知（产品改进 #16）。
	 * 每次社区列表更新后，拿当前插件全集与「已见过」集合做 diff：
	 *   - newIds：本次新冒出来的插件（必然不在离线词典 → 走 online 或 original）
	 *   - 其中有多少已被自动在线翻译、多少仍是英文兜底
	 * 用 Notice 告诉用户「本次新增 N 个、已译 M 个、未译 K 个」，
	 * 纯本地集合运算，零网络、零 API 成本。
	 * 调用方负责在拉取新列表并 mergeOffline 后调用；seenPluginIds 在此被更新。
	 */
public reportNewPluginDelta = (current: PluginInfo[], results: Record<string, TranslateResult>) => reportNewPluginDelta(this._ctx, current, results);

	/** 当前镜像配置（从 settings 读取） */
public mirrorConfig = () => mirrorConfig(this._ctx);

	/**
	 * 拉取 stats（失败静默，不阻断主列表），写回 this.plugins 与 statsMap。
	 * 走镜像；落盘缓存（带 TTL，由 Plugin 层 saveStatsCache 处理）。
	 */
public fetchStatsAndMerge = () => fetchStatsAndMerge(this._ctx);

	/** 把 statsMap 内容写回 this.plugins 的 downloads/updated 字段 */
public mergeStatsIntoPlugins = () => mergeStatsIntoPlugins(this._ctx);


	/** 用已加载的缓存 stats 同步合并到 plugins（首屏不空白） */
public mergeStatsFromCache = () => mergeStatsFromCache(this._ctx);

	/**
	 * 快照已安装/已启用插件（产品改进 #7）。
	 * app.plugins 为半官方 API，整体 try/catch 容错，缺失时静默不打标。
	 */
public snapshotInstalled = () => snapshotInstalled(this._ctx);

	/** 预计算搜索索引：每个插件的小写化搜索串（委托 filter.ts 的 buildSearchBlob，保证口径一致） */
public buildSearchIndex = (ids?: Set<string>) => buildSearchIndex(this._ctx, ids);

	/** 统计作者作品数，列出"多插件作者"（作品数≥2），按拼音首字母分组（A→Z，#兜底）。 */
public buildAuthorFacet = () => buildAuthorFacet(this._ctx);

	/** 渲染作者 facet 行：字母条 A-Z/#（默认不展开），点击字母展开该组 chips */
public renderAuthorFacet = () => renderAuthorFacet(this._ctx);

	/** 切换作者筛选：再次点同一作者则取消，并刷新 facet 选中态与列表 */
public toggleAuthorFilter = (author: string) => toggleAuthorFilter(this._ctx, author);

	/**
	 * 作者钻取状态条：当 authorFilter 活跃时，在工具栏下方显示
	 * 「正在查看作者 XXX 的 N 个插件 | ✕ 清除」，让用户知道当前处于筛选态。
	 * N 使用全量 authorCounts（不受其他筛选影响），避免与搜索/来源筛选交叉后显示 0。
	 */
public updateAuthorBanner = () => updateAuthorBanner(this._ctx);

	

	/** 更新搜索模式引导行：无查询时显示当前模式的一句话提示，有查询时隐藏 */
public updateGuidance = () => updateGuidance(this._ctx);

	/** facet 容器与行的显隐：分类行 AI/keyword 模式可见（全局发现维度）；作者行同 */
public updateFacetVisibility = () => updateFacetVisibility(this._ctx);

	/** 重算可见列表（过滤 + 排序，纯数据，不创建 DOM），并重置滚动位置后渲染窗口 */
public renderPluginList = (preserveScroll?: boolean) => renderPluginList(this._ctx, preserveScroll);

	/** 仅当插件数据变化（pluginsRev 改变）时重算智能信号 */
public recomputeSmartSignalsIfNeeded = () => recomputeSmartSignalsIfNeeded(this._ctx);

	/** 运行过滤+排序管线，回写 FilterCache，返回 filtered 列表 */
public runFilterPipeline = (query: string) => runFilterPipeline(this._ctx, query);

	/** 更新列表外围 chrome（结果计数、推荐区域、焦点重置） */
public updateListChrome = (filtered: PluginInfo[]) => updateListChrome(this._ctx, filtered);

	/** 使高度缓存失效、清空旧卡片、测量布局、渲染窗口 */
public invalidateAndRender = (preserveScroll: boolean) => invalidateAndRender(this._ctx, preserveScroll);

	/** 后渲染同步：懒翻译、AI 翻译按钮、滚动按钮、作者横幅 */
public postRenderSync = () => postRenderSync(this._ctx);

	/**
	 * 增量更新单张卡片的视觉状态（收藏/对比/翻译），不触发全量销毁重建。
	 * 用于：收藏切换、对比切换等不改变数据集的操作。
	 */
public refreshCardState = (pluginId: string) => refreshCardState(this._ctx, pluginId);

	/**
	 * ARIA live 状态播报（屏幕阅读器同步）。
	 * 更新 pt-sr-only 区域内容，触发 assistive technology 读出变化。
	 */
public announceStatus = (message: string) => announceStatus(this._ctx, message);

	/**
	 * 同步两个滚动快捷按钮的可见性：
	 * - 回到顶部：滚动超过 1.5 屏时显示；
	 * - 一键置底：未抵达列表底部（留 4px 容差，规避小数像素误差）时显示。
	 * 类方法，供滚动监听与每次列表重渲染后统一调用。
	 */
public updateScrollButtons = () => updateScrollButtons(this._ctx);

public updateScrollPosBadge = () => updateScrollPosBadge(this._ctx);

	/**
	 * 去抖调度：对当前结果集里 source=original 的插件做按需在线翻译。
	 * 与快速连续输入/筛选解耦，避免每次按键都发起网络请求。
	 */
	public translateVisibleTimer: number | undefined;

	/**
	 * 对当前 visibleList 中仍是原文（未翻译）的插件按需翻译，翻完就地刷新对应卡片，
	 * 并落盘缓存。失败静默——原文兜底已在展示，不影响可用性。
	 */
/** 滚动/筛选后填充进入可见窗口的 pending 卡片（窗口化懒填充补完） */
public fillVisibleWindow = () => fillVisibleWindow(this._ctx);

	/**
	 * 「AI 一键翻译」按钮显隐 / 置灰 / 文案同步。
	 * 策略：sourceFilter=original → 显示完整翻译按钮；
	 * 其它筛选下有未翻译 → 显示轻量引导入口；全已翻译 → 隐藏。
	 * 点击行为由 loadAndRender 中绑定的 click handler 统一驱动
	 * （切到 original 后再次 renderPluginList 会重新进入本方法显示完整按钮）。
	 */
public updateAiTranslateButton = () => updateAiTranslateButton(this._ctx);

	/**
	 * 一键 AI 翻译当前筛选结果（仅「未翻译」筛选下可用）：收集 visibleList 中仍是原文的插件，
	 * 复用翻译引擎的 translateBatchIncremental（CONCURRENCY=4 并发 + 失败降级），
	 * 边翻边逐卡刷新 + 进度反馈，完成后落盘缓存。未配置 AI Key 时引导去配置。
	 */
public aiTranslateAllPending = () => aiTranslateAllPending(this._ctx);

	/** 进度文本：完成时显示已翻译数量并延时淡出。 */
public setAIProgressDone = (n: number) => setAIProgressDone(this._ctx, n);

	/**
	 * 就地刷新单张卡片的译名/译描 + 来源角标（若该卡片当前在视口 DOM 中）。
	 * 找不到 DOM（已滚出视口）时静默——下次进入视口重建卡片会用最新缓存。
	 * 在线翻译把 original 翻成 online 时，连带把角标从「未翻译」切到「在线翻译」、
	 * 副标解释从「未翻译说明」切回原名，让用户即时感知「这张新插件刚被翻译好了」。
	 */
public refreshCardTranslation = (id: string, result: TranslateResult) => refreshCardTranslation(this._ctx, id, result);

	/**
	 * rAF 排期的「重新过滤 + 渲染」（供搜索防抖/筛选调用，避免同步重渲染阻塞输入）。
	 * 注意：必须走 renderPluginList（重新过滤 visibleList），
	 * 而不是 renderWindow（只重画当前窗口）——否则搜索词变化后列表不更新。
	 */
public scheduleRender = (preserveScroll?: boolean) => scheduleRender(this._ctx, !!preserveScroll);

	/**
	 * 测量列数 colCount（方案 B 下不再假设固定行高）。
	 * 列宽固定（grid 由 JS 注入 repeat(cols,1fr)）→ 同一行各卡同宽同折行 → 同行等高，
	 * 但行与行之间高度可能不同（AI 理由、内联编辑器），故行高改为「渲染后逐行实测」。
	 * 仅 colCount 变化时才需要清空重绘；行高变化由 renderWindow 渲染后实测并重建前缀和。
	 */
public measureLayout = () => measureLayout(this._ctx);
public measureLayoutIfNeeded = () => measureLayoutIfNeeded(this._ctx);

	/** AI 模式下按 Enter 触发的语义搜索（含状态/校验/通知），提取为独立方法便于重入守卫 */
public runAISearch = (searchInput: HTMLInputElement, aiBadge: HTMLElement) => runAISearch(this._ctx, searchInput, aiBadge);

	/**
	 * 虚拟滚动核心（方案 B：动态行高）。
	 *
	 * 关键修正：行与行之间高度可能不同（AI 理由行、内联编辑器展开都会撑高卡片），
	 * 故不再用「固定行高 × 行数」。改为：
	 *  1. 渲染当前可见窗口的卡片（整行整行创建，与之前一致）；
	 *  2. 实测每张卡片真实高度，按行取最大值 → rowHeights[r]；
	 *  3. 前缀和 offsets[r] = 各行累计偏移；
	 *  4. 用 offsets 二分定位 startRow（scrollTop 落在哪一行），layer 偏移 = offsets[startRow]；
	 *  5. spacer 总高 = offsets[totalRows]（真实像素）。
	 * 这样无论卡片高度如何参差，translateY 与 grid 真实排版都严格对齐。
	 */
public renderWindow = (opts?: { measure?: boolean }) => renderWindow(this._ctx, opts);
public updateWindow = () => updateWindow(this._ctx);

	/** 操作按钮的瞬时反馈（短反馈，不依赖 toast） */
public flashAction = (btn: HTMLElement) => flashAction(this._ctx, btn);
}

// ──────────────────────────────────────────
// 主插件类
// ──────────────────────────────────────────



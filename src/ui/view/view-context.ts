/**
 * ViewContext — 替代 bind 模板的视图上下文模式
 * ─────────────────────────────────────────────
 *
 * 当前问题（审计发现 8）：
 *   translator-view.ts 中有 69 处 `.bind(this)`，形成 ~840 行 bind 模板代码。
 *   每新增一个视图方法需 3 步（实现 + 绑声明 + 确保 this 正确），且方法散落
 *   为 public fields 而非 class methods，增加认知成本。
 *
 * ViewContext 方案：
 *   所有 view-* 模块的函数签名从 `(this: ChinesePluginMarketView, ...)` 改为
 *   `(ctx: ViewContext, ...)`。ViewContext 是一个扁平对象，聚合了视图的所有
 *   公共状态和动作方法，一次创建，全局传递。
 *
 * 收益：
 *   - 消除 69 处 `.bind(this)`（GC 压力降低）
 *   - 模块函数可脱离 this 上下文独立测试
 *   - 新方法只需在 createViewContext() 中加入一项即可全局可用
 *   - translator-view.ts 从 ~840 行 bind 模板缩减为 ~100 行编排代码
 */

import type { PluginInfo, TranslateResult, AISearchResult, Translator } from "@domain/catalog/translator";
import type { DrawerHostPlugin } from "@ui/components/detail-drawer";
import type { SearchMode, SourceFilter, InstallFilter, FilterCache, EmptyState } from "@domain/filter/filter";
import type { SortBy } from "@domain/filter/sort";
import type { PluginStat } from "@domain/catalog/stats";
import type { SimilarCandidate } from "@domain/recommend/similar";
import type { InvertedIndex } from "@domain/recommend/similar";
import type { MirrorConfig } from "@domain/catalog/mirror";
import type { CardRenderContext } from "@ui/components/card-render";
import type { PluginDetailDrawer } from "@ui/components/detail-drawer";
import type { SignalId } from "@domain/filter/smart-signal";
import type { ListState } from "@ui/dom/list-state";
import type { TrendingEngine } from "@domain/recommend/trending";
import type { AuthorGroup } from "@translation/lexicon/pinyin-init";

import type { I18nKey, I18nVars } from "@shared/i18n";
import type { ChinesePluginMarketSettings, ChinesePluginMarketView } from "@ui/view/translator-view";
import type { TrendSnapshot } from "@domain/recommend/trending";
import type { App, PluginManifest } from "obsidian";
import { makeT } from "@shared/i18n";

// ──────────────────────────────────────────
// ViewContext 接口定义
// ──────────────────────────────────────────

/**
 * ViewContext 是 ChinesePluginMarketView 公共状态的扁平投影。
 *
 * 数据字段（只读或可读写，由实现决定）：
 *   所有 view-* 模块通过 ctx.fieldName 访问视图状态，
 *   替代原来的 this.fieldName（this 指向 ChinesePluginMarketView）。
 *
 * 模块函数通过 ctx 访问视图的所有公共能力：
 *   - ctx.translator / ctx.app / ctx.plugin → 依赖注入点
 *   - ctx.t(key, vars?) → i18n 翻译函数
 *   - ctx.track(ev, n?) → 埋点
 *   - ctx.saveSettings() → 持久化
 *   - 所有视图状态字段 → 列表、结果、DOM 引用等
 *
 * 扩展方式：
 *   新增模块方法 → 在 createViewContext() 中绑好 this 并加入返回值。
 *   新增状态字段 → 添加到接口声明即可，createViewContext 直接透传。
 */
export interface ViewContext {
	// ── 依赖注入 ──
	translator: Translator; // type-only import，无运行时循环
	app: App;
	manifest: PluginManifest;
	pluginTagMap: Map<string, string>;
	/**
	 * 插件最小端口（P2-2 收尾：不再暴露 ChinesePluginMarketPlugin 完整形状）。
	 * view 层唯一消费点是 view-cards 传给 PluginDetailDrawer；
	 * 其余 plugin 内部状态/动作一律走下方的 ctx 委托。
	 */
	plugin: DrawerHostPlugin;
	/** 插件设置（getter 返回同一引用，view 层对 .sourceFilter/.sortBy 等的写回等价于直改 plugin.settings） */
	get settings(): ChinesePluginMarketSettings;
	set settings(v: ChinesePluginMarketSettings);

	// ── plugin 内部状态/动作的 ctx 委托（P2-2 去耦合收尾批）──
	get cachedStats(): Map<string, PluginStat> | null;
	get cachedTrendingHistory(): Record<string, TrendSnapshot[]> | null;
	get recommendedTitle(): string;
	get seenPluginIds(): Set<string>;
	set seenPluginIds(v: Set<string>);
	saveTrendingHistory: (history: Record<string, TrendSnapshot[]>) => Promise<void>;
	savePluginListCache: (list: unknown[]) => Promise<void>;
	saveStatsCache: (map: Map<string, PluginStat>) => Promise<void>;
	saveVectorIndex: () => Promise<void>;

	// ── Obsidian ItemView DOM ──
	containerEl: HTMLElement;
	contentEl: HTMLElement;

	// ── i18n ──
	t: (key: I18nKey, vars?: I18nVars) => string;

	// ── 核心状态 ──
	plugins: PluginInfo[];
	translatedResults: Record<string, TranslateResult>;
	searchQuery: string;
	searchMode: SearchMode;
	sourceFilter: SourceFilter;
	installFilter: InstallFilter;
	favoriteFilter: boolean;
	sortBy: SortBy;
	dataLoaded: boolean;
	dataLoading: boolean;
	lastListFetchAt: number;
	compareMode: boolean;
	compareSet: Set<string>;
	favoritesSet: Set<string>;
	sortFavoritesFirst: boolean;

	// ── AI 搜索状态 ──
	aiSearchResult: AISearchResult | null;
	aiSearchPending: boolean;
	aiSearchQueryCache: string;
	lastAiSearchResult: AISearchResult | null;
	lastAiSearchQuery: string;
	aiTranslateRunning: boolean;
	/**
	 * 本次会话（插件打开期间）用户主动触发的翻译计数。
	 * 懒翻译已移除，历史缓存命中（mergeOffline）不再计入，仅统计用户手动点翻译产生的译文，
	 * 用于「已翻译 N」统计的准确性，避免把历史 online/ai 缓存误认为「本次译过」。
	 */
	translatedThisSession: number;

	// ── 视图滚动与测量 ──
	visibleList: PluginInfo[];
	defaultRowH: number;
	rowGap: number;
	colCount: number;
	lastListSignature: string;
	cardPool: HTMLElement[];
	pendingCards: Set<HTMLElement>;
	cardPoolCtx: CardRenderContext | null;
	/** 插件 id → 卡片 DOM 持久化索引（增量复用，避免每次 querySelectorAll 全量建 Map） */
	cardById: Map<string, HTMLElement>;
	// ── 固定网格行高缓存（per-view）──
	/** 固定网格行高缓存（卡片高 + 行距） */
	cachedRowH: number;
	/** 布局参数是否失效：尺寸/列数变化后置 true，measureLayout 仅在脏时重新测量（避免重复 getComputedStyle/scrollHeight） */
	layoutDirty: boolean;
	/** scrollHeight 缓存：内容/列数不变时为常量，updateScrollButtons 每帧复用避免强制重排；失效时回退实测 */
	cachedScrollHeight: number | null;
	/** 插件 id→PluginInfo 查表缓存（per-view） */
	pluginMap: Map<string, PluginInfo> | null;
	/** pluginMap 的失效键（以 pluginsRev 版本号为键，避免依赖数组引用身份） */
	pluginMapSrc: number | null;
	/** 视图已卸载标记：为 true 时所有异步路径（翻译/落盘定时器）应尽早退出，避免幽灵写盘 */
	disposed: boolean;
	scrollRAF: number;
	/** 滚动速度采样（像素/秒）：由滚动监听实时估算，供 PREFETCH_ROWS 速度自适应 */
	scrollVelocity: number;
	/** 速度采样基线（上一次 scroll 事件的 scrollTop / timestamp） */
	lastScrollTopSample: number;
	lastScrollSampleAt: number;
	/** requestIdleCallback 句柄：超量分帧填充的挂起任务，卸载时取消 */
	fillIdleHandle: number | null;
	measureRAF: number;
	renderRAF: number;
	descRAF: number;
	debounceTimer: number | undefined;
	scrollPosTimer: number | undefined;
	/** 滚动位置徽标上次写入文本（避免每帧无变化重写 textContent） */
	lastScrollPosText: string;
	resizeObserver: ResizeObserver | null;

	// ── DOM 引用 ──
	scrollViewport: HTMLElement | null;
	scrollCardLayer: HTMLElement | null;
	resultCountEl: HTMLElement | null;
	aiTranslateBtnEl: HTMLButtonElement | null;
	aiProgressEl: HTMLElement | null;
	refreshBtn: HTMLButtonElement | null;
	backTopBtn: HTMLButtonElement | null;
	scrollBottomBtn: HTMLButtonElement | null;
	compareTrayEl: HTMLElement | null;
	scrollPosEl: HTMLElement | null;
	facetContainerEl: HTMLElement | null;
	catRowEl: HTMLElement | null;
	/** 分类 facet 重新渲染（标签后台加载完成后由插件回调触发，避免空态残留） */
	refreshFacets: () => void;
	authorRowEl: HTMLElement | null;
	guidanceEl: HTMLElement | null;
	authorFacetEl: HTMLElement | null;
	authorBannerEl: HTMLElement | null;
	featuredSectionEl: HTMLElement | null;
	featuredGridEl: HTMLElement | null;

	// ── Facet 与作者筛选 ──
	searchIndex: Map<string, string>;
	filterCache: FilterCache;
	selectedCategories: string[];
	authorFilter: string | null;
	authorFacetList: AuthorGroup[];
	authorExpanded: boolean;
	authorCounts: Map<string, number>;
	activeAuthorLetter: string | null;
	recommendedOnly: boolean;

	// ── 统计 ──
	statsMap: Map<string, PluginStat>;
	installedIds: Set<string>;
	enabledIds: Set<string>;
	/** 已装插件本地版本号（id → manifest.version） */
	installedVersions: Map<string, string>;
	/** 官方版本领先本地的插件 id 集合（有新版可更） */
	outdatedIds: Set<string>;
	/** 可更新详情（id → {local, latest}） */
	outdatedInfo: Map<string, { local: string; latest: string }>;

	// ── 智能信号 ──
	smartSignals: Map<string, SignalId[]>;
	pluginsRev: number;
	smartSignalsRev: number;

	// ── 推荐引擎 ──
	/** 趋势评分引擎 */
	trendingEngine: TrendingEngine;
	/** 趋势评分 (id → 0-1)，由 recomputeSmartSignalsIfNeeded 产出 */
	trendingScores: Map<string, number>;
	/** 综合推荐评分 (id → 0-100)，由 recomputeSmartSignalsIfNeeded 产出 */
	recommendScores: Map<string, number>;
	/** 标签倒排索引（供相似推荐加速用） */
	invertedIndex: InvertedIndex;

	// ── 键盘导航 ──
	focusedCardIdx: number;

	// ── 其他 ──
	listState: ListState;
	featuredCollapsed: boolean;
	translateVisibleTimer: number | undefined;
	isTranslated: (plugin: PluginInfo) => boolean;
	activeDrawer: PluginDetailDrawer | null;
	enterDetailMode: () => void;
	exitDetailMode: () => void;

	// ── 持久化动作（统一门面：视图层只经 ctx 持久化，不直接碰 plugin）──
	/** 防抖持久化（plugin.saveSettings 为 debounce 包装，同步返回；真正落盘由 flushSaveSettings/卸载兜底） */
	saveSettings: () => void;
	flushSaveSettings: () => Promise<void>;
	saveTranslatorData: () => void;
	/** 立即落盘（无防抖）：翻译/落库等关键节点后调用，避免重载时防抖定时器未触发导致数据丢失 */
	flushTranslatorData: () => Promise<void>;
	track: (ev: string, n?: number) => void;

	// ── 模块方法 ──
	loadAndRender: () => Promise<void>;
	ensureDataLoaded: () => Promise<boolean>;
	fetchPlugins: () => Promise<PluginInfo[]>;
	refreshData: () => Promise<void>;
	updateRefreshTooltip: () => void;
	relativeTime: (tsMs: number) => string;
	reportNewPluginDelta: (current: PluginInfo[], results: Record<string, TranslateResult>) => void;
	mirrorConfig: () => MirrorConfig;
	fetchStatsAndMerge: (baseList?: PluginInfo[]) => Promise<void>;
	mergeStatsIntoPlugins: () => void;
	mergeStatsFromCache: () => void;
	snapshotInstalled: () => void;
	buildSearchIndex: (ids?: Set<string>) => void;
	buildAuthorFacet: () => void;
	renderAuthorFacet: () => void;
	toggleAuthorFilter: (author: string) => void;
	updateAuthorBanner: () => void;
	applySearchInput: (raw?: string) => void;
	showAIPendingHint: () => void;
	showAIConfigGuide: (reason?: "disabled" | "noKey") => void;
	showLoadingState: (message: string) => void;
	updateStats: () => void;
	applyAIConfig: () => void;
	updateGuidance: (es?: EmptyState) => void;
	updateFacetVisibility: () => void;
	showSearchGuide: () => void;
	renderFeaturedSection: () => void;
	ensureFeaturedSection: () => void;
	hideFeaturedSection: () => void;
	renderPluginList: (preserveScroll?: boolean) => void;
	recomputeSmartSignalsIfNeeded: () => void;
	runFilterPipeline: (raw: string) => PluginInfo[];
	updateListChrome: (filtered: PluginInfo[]) => void;
	invalidateAndRender: (preserveScroll?: boolean) => void;
	postRenderSync: (opts?: { force?: boolean; keepScroll?: boolean }) => void;
	refreshCardState: (pluginId?: string) => void;
	fillVisibleWindow: () => void;
	measureLayout: () => void;
	measureLayoutIfNeeded: () => void;
	scheduleRender: (preserveScroll?: boolean) => void;
	renderWindow: (opts?: { measure?: boolean }) => void;
	/** 增量窗口化：仅根据当前滚动位置换入/换出窗口内卡片（DOM 节点数稳定在 ≤250），滚动监听调用 */
	updateWindow: () => void;
	/** 当前已渲染窗口 [windowStart, windowEnd)，用于滚动时跳过无变化的重排 */
	windowStart: number;
	windowEnd: number;
	onCardClick: (ev: MouseEvent) => void;
	toggleFavorite: (pluginId: string) => boolean;
	onCardKeydown: (ev: KeyboardEvent) => void;
	focusCardByIdx: (idx: number) => void;
	flashAction: (el: HTMLElement) => void;
	openDetailDrawer: (pluginId: string, triggerCard?: HTMLElement | null) => void;
	computeSimilarFor: (info: PluginInfo) => SimilarCandidate[];
	updateCompareTray: () => void;
	openCompareModal: () => void;
	enterCompareMode: () => void;
	exitCompareMode: () => void;
	refreshCompareHighlights: () => void;
	updateScrollButtons: (visibleListLen?: number) => void;
	updateScrollPosBadge: () => void;
	announceStatus: (msg: string) => void;
	refreshCardTranslation: (pluginId: string, result: TranslateResult) => Promise<void>;
	updateAiTranslateButton: () => void;
	runAISearch: (searchInput: HTMLInputElement, aiBadge: HTMLElement) => Promise<void>;
	aiTranslateAllPending: () => Promise<void>;
	setAIProgressDone: (n: number) => void;
	removeCompareTray: () => void;
	tryLoadCachedPluginList: () => Promise<PluginInfo[] | null>;
	register: (cb: () => void) => void;
	getRecommendedIds: () => Set<string>;
	/** 后台预建本地向量索引（A+B：本地 embedding 用户自动预建 / 设置页手动触发） */
	buildLocalIndex: (force?: boolean) => Promise<void>;
	/** 预热本地 embedding worker（加载模型，让首次搜索免冷启动） */
	warmupLocalEmbedding: () => void;
}

// ──────────────────────────────────────────
// ViewContext 工厂函数
// ──────────────────────────────────────────

/**
 * createViewContext(view) — 从 ChinesePluginMarketView 实例创建 ViewContext。
 *
 * 所有方法在此处一次性绑好 this，后续通过 ctx.method() 调用，
 * 替代各模块内散落的 `.bind(this)`。
 *
 * 新增视图方法时：
 *   1. 在 ViewContext 接口中声明方法签名
 *   2. 在 createViewContext() 返回对象中添加 `method: view.method.bind(view)`
 *   3. view-* 模块即可通过 ctx.method() 直接调用
 */
export function createViewContext(view: ChinesePluginMarketView): ViewContext {
	return {
		// ── 依赖注入 ──
		translator: view.translator,
		app: view.app,
		plugin: view.plugin,
		manifest: view.plugin.manifest,
		pluginTagMap: view.plugin.pluginTagMap,
		get settings() { return view.plugin.settings; },
		set settings(v) { view.plugin.settings = v; },

		// ── plugin 内部状态/动作的 ctx 委托（P2-2 收尾批）──
		get cachedStats() { return view.plugin.cachedStats; },
		get cachedTrendingHistory() { return view.plugin.cachedTrendingHistory; },
		get recommendedTitle() { return view.plugin.recommendedTitle; },
		get seenPluginIds() { return view.plugin.seenPluginIds; },
		set seenPluginIds(v) { view.plugin.seenPluginIds = v; },
		saveTrendingHistory: (history) => view.plugin.storage.saveTrendingHistory(history),
		savePluginListCache: (list) => view.plugin.storage.savePluginListCache(list),
		saveStatsCache: (map) => view.plugin.storage.saveStatsCache(map),
		saveVectorIndex: () => view.plugin.saveVectorIndex(),

		// ── Obsidian ItemView DOM ──
		containerEl: view.containerEl,
		contentEl: view.contentEl,

		// ── i18n ──
		t: view.t ?? makeT(),

		// ── 核心状态（直接透传，不拷贝）──
		get plugins() { return view.plugins; },
		set plugins(v) { view.plugins = v; },
		get translatedResults() { return view.translatedResults; },
		set translatedResults(v) { view.translatedResults = v; },
		get searchQuery() { return view.searchQuery; },
		set searchQuery(v) { view.searchQuery = v; },
		get searchMode() { return view.searchMode; },
		set searchMode(v) { view.searchMode = v; },
		get sourceFilter() { return view.sourceFilter; },
		set sourceFilter(v) { view.sourceFilter = v; },
		get installFilter() { return view.installFilter; },
		set installFilter(v) { view.installFilter = v; },
		get favoriteFilter() { return view.favoriteFilter; },
		set favoriteFilter(v) { view.favoriteFilter = v; },
		get sortBy() { return view.sortBy; },
		set sortBy(v) { view.sortBy = v; },
		get dataLoaded() { return view.dataLoaded; },
		set dataLoaded(v) { view.dataLoaded = v; },
		get dataLoading() { return view.dataLoading; },
		set dataLoading(v) { view.dataLoading = v; },
		get lastListFetchAt() { return view.lastListFetchAt; },
		set lastListFetchAt(v) { view.lastListFetchAt = v; },
		get compareMode() { return view.compareMode; },
		set compareMode(v) { view.compareMode = v; },
		get compareSet() { return view.compareSet; },
		get favoritesSet() { return view.favoritesSet; },
		get sortFavoritesFirst() { return view.sortFavoritesFirst; },
		set sortFavoritesFirst(v) { view.sortFavoritesFirst = v; },

		get aiSearchResult() { return view.aiSearchResult; },
		set aiSearchResult(v) { view.aiSearchResult = v; },
		get aiSearchPending() { return view.aiSearchPending; },
		set aiSearchPending(v) { view.aiSearchPending = v; },
		get aiSearchQueryCache() { return view.aiSearchQueryCache; },
		set aiSearchQueryCache(v) { view.aiSearchQueryCache = v; },
		get lastAiSearchResult() { return view.lastAiSearchResult; },
		set lastAiSearchResult(v) { view.lastAiSearchResult = v; },
		get lastAiSearchQuery() { return view.lastAiSearchQuery; },
		set lastAiSearchQuery(v) { view.lastAiSearchQuery = v; },
		get aiTranslateRunning() { return view.aiTranslateRunning; },
		set aiTranslateRunning(v) { view.aiTranslateRunning = v; },
		get translatedThisSession() { return view.translatedThisSession; },
		set translatedThisSession(v) { view.translatedThisSession = v; },

		// ── 视图滚动与测量状态 ──
		get visibleList() { return view.visibleList; },
		set visibleList(v) { view.visibleList = v; },
		get defaultRowH() { return view.defaultRowH; },
		set defaultRowH(v) { view.defaultRowH = v; },
		get rowGap() { return view.rowGap; },
		set rowGap(v) { view.rowGap = v; },
		get colCount() { return view.colCount; },
		set colCount(v) { view.colCount = v; },
		get lastListSignature() { return view.lastListSignature; },
		set lastListSignature(v) { view.lastListSignature = v; },
		get cardPool() { return view.cardPool; },
		set cardPool(v) { view.cardPool = v; },
		get pendingCards() { return view.pendingCards; },
		set pendingCards(v) { view.pendingCards = v; },
		get cardPoolCtx() { return view.cardPoolCtx; },
		set cardPoolCtx(v) { view.cardPoolCtx = v; },
		get cardById() { return view.cardById; },
		set cardById(v) { view.cardById = v; },
		get cachedRowH() { return view.cachedRowH; },
		set cachedRowH(v) { view.cachedRowH = v; },
		get layoutDirty() { return view.layoutDirty; },
		set layoutDirty(v) { view.layoutDirty = v; },
		get cachedScrollHeight() { return view.cachedScrollHeight; },
		set cachedScrollHeight(v) { view.cachedScrollHeight = v; },
		get pluginMap() { return view.pluginMap; },
		set pluginMap(v) { view.pluginMap = v; },
		get pluginMapSrc() { return view.pluginMapSrc; },
		set pluginMapSrc(v) { view.pluginMapSrc = v; },
		get disposed() { return view.disposed; },
		set disposed(v) { view.disposed = v; },

		get scrollRAF() { return view.scrollRAF; },
		set scrollRAF(v) { view.scrollRAF = v; },
		get scrollVelocity() { return view.scrollVelocity; },
		set scrollVelocity(v) { view.scrollVelocity = v; },
		get lastScrollTopSample() { return view.lastScrollTopSample; },
		set lastScrollTopSample(v) { view.lastScrollTopSample = v; },
		get lastScrollSampleAt() { return view.lastScrollSampleAt; },
		set lastScrollSampleAt(v) { view.lastScrollSampleAt = v; },
		get fillIdleHandle() { return view.fillIdleHandle; },
		set fillIdleHandle(v) { view.fillIdleHandle = v; },
		get measureRAF() { return view.measureRAF; },
		set measureRAF(v) { view.measureRAF = v; },
		get renderRAF() { return view.renderRAF; },
		set renderRAF(v) { view.renderRAF = v; },
		get descRAF() { return view.descRAF; },
		set descRAF(v) { view.descRAF = v; },
		get debounceTimer() { return view.debounceTimer; },
		set debounceTimer(v) { view.debounceTimer = v; },
		get scrollPosTimer() { return view.scrollPosTimer; },
		set scrollPosTimer(v) { view.scrollPosTimer = v; },
		get resizeObserver() { return view.resizeObserver; },
		set resizeObserver(v) { view.resizeObserver = v; },

		// ── DOM 引用 ──
		get scrollViewport() { return view.scrollViewport; },
		set scrollViewport(v) { view.scrollViewport = v; },
		get scrollCardLayer() { return view.scrollCardLayer; },
		set scrollCardLayer(v) { view.scrollCardLayer = v; },
		get resultCountEl() { return view.resultCountEl; },
		set resultCountEl(v) { view.resultCountEl = v; },
		get aiTranslateBtnEl() { return view.aiTranslateBtnEl; },
		set aiTranslateBtnEl(v) { view.aiTranslateBtnEl = v; },
		get aiProgressEl() { return view.aiProgressEl; },
		set aiProgressEl(v) { view.aiProgressEl = v; },
		get refreshBtn() { return view.refreshBtn; },
		set refreshBtn(v) { view.refreshBtn = v; },
		get backTopBtn() { return view.backTopBtn; },
		set backTopBtn(v) { view.backTopBtn = v; },
		get scrollBottomBtn() { return view.scrollBottomBtn; },
		set scrollBottomBtn(v) { view.scrollBottomBtn = v; },
		get compareTrayEl() { return view.compareTrayEl; },
		set compareTrayEl(v) { view.compareTrayEl = v; },
		get scrollPosEl() { return view.scrollPosEl; },
		set scrollPosEl(v) { view.scrollPosEl = v; },
		get lastScrollPosText() { return view.lastScrollPosText; },
		set lastScrollPosText(v) { view.lastScrollPosText = v; },
	get facetContainerEl() { return view.facetContainerEl; },
	set facetContainerEl(v) { view.facetContainerEl = v; },
	get catRowEl() { return view.catRowEl; },
	set catRowEl(v) { view.catRowEl = v; },
	get refreshFacets() { return view.refreshFacets; },
	set refreshFacets(v) { view.refreshFacets = v; },
		get authorRowEl() { return view.authorRowEl; },
		set authorRowEl(v) { view.authorRowEl = v; },
		get guidanceEl() { return view.guidanceEl; },
		set guidanceEl(v) { view.guidanceEl = v; },
		get authorFacetEl() { return view.authorFacetEl; },
		set authorFacetEl(v) { view.authorFacetEl = v; },
		get authorBannerEl() { return view.authorBannerEl; },
		set authorBannerEl(v) { view.authorBannerEl = v; },
		get featuredSectionEl() { return view.featuredSectionEl; },
		set featuredSectionEl(v) { view.featuredSectionEl = v; },
		get featuredGridEl() { return view.featuredGridEl; },
		set featuredGridEl(v) { view.featuredGridEl = v; },

		// ── Facet / 作者 ──
		get searchIndex() { return view.searchIndex; },
		filterCache: view.filterCache,
		get selectedCategories() { return view.selectedCategories; },
		set selectedCategories(v) { view.selectedCategories = v; },
		get authorFilter() { return view.authorFilter; },
		set authorFilter(v) { view.authorFilter = v; },
get authorFacetList() { return view.authorFacetList; },
	set authorFacetList(v) { view.authorFacetList = v; },
	get authorExpanded() { return view.authorExpanded; },
	set authorExpanded(v) { view.authorExpanded = v; },
		get authorCounts() { return view.authorCounts; },
		get activeAuthorLetter() { return view.activeAuthorLetter; },
		set activeAuthorLetter(v) { view.activeAuthorLetter = v; },
		get recommendedOnly() { return view.recommendedOnly; },
		set recommendedOnly(v) { view.recommendedOnly = v; },

		// ── 统计 ─
		get statsMap() { return view.statsMap; },
		get installedIds() { return view.installedIds; },
		get enabledIds() { return view.enabledIds; },
		get installedVersions() { return view.installedVersions; },
		get outdatedIds() { return view.outdatedIds; },
		get outdatedInfo() { return view.outdatedInfo; },

		// ── 智能信号 ──
		get smartSignals() { return view.smartSignals; },
		get pluginsRev() { return view.pluginsRev; },
		set pluginsRev(v) { view.pluginsRev = v; },
		get smartSignalsRev() { return view.smartSignalsRev; },
		set smartSignalsRev(v) { view.smartSignalsRev = v; },

		// ── 推荐引擎 ──
		get trendingEngine() { return view.trendingEngine; },
		get trendingScores() { return view.trendingScores; },
		get recommendScores() { return view.recommendScores; },
		get invertedIndex() { return view.invertedIndex; },

		// ── 其他 ──
		get focusedCardIdx() { return view.focusedCardIdx; },
		set focusedCardIdx(v) { view.focusedCardIdx = v; },
		get listState() { return view.listState; },
		set listState(v) { view.listState = v; },
		get featuredCollapsed() { return view.featuredCollapsed; },
		set featuredCollapsed(v) { view.featuredCollapsed = v; },

		// ── 详情页模式 ──
		get activeDrawer() { return view.activeDrawer; },
		set activeDrawer(v) { view.activeDrawer = v; },
		enterDetailMode: view.enterDetailMode.bind(view),
		exitDetailMode: view.exitDetailMode.bind(view),

		// ── 持久化动作（统一门面）──
		saveSettings: () => view.plugin.saveSettings(),
		flushSaveSettings: () => view.plugin.flushSaveSettings(),
		saveTranslatorData: () => view.plugin.saveTranslatorData(),
		flushTranslatorData: () => view.plugin.flushTranslatorData(),
		// 埋点已移除：track 保留为 no-op 以维持调用点接口稳定（不写盘、不计数）。
		track: () => {},

		// ── 模块方法（一次性绑好 this）──
		loadAndRender: view.loadAndRender.bind(view),
		ensureDataLoaded: view.ensureDataLoaded.bind(view),
		fetchPlugins: view.fetchPlugins.bind(view),
		refreshData: view.refreshData.bind(view),
		updateRefreshTooltip: view.updateRefreshTooltip.bind(view),
		relativeTime: view.relativeTime.bind(view),
		reportNewPluginDelta: view.reportNewPluginDelta.bind(view),
		mirrorConfig: view.mirrorConfig.bind(view),
		fetchStatsAndMerge: view.fetchStatsAndMerge.bind(view),
		mergeStatsIntoPlugins: view.mergeStatsIntoPlugins.bind(view),
		mergeStatsFromCache: view.mergeStatsFromCache.bind(view),
		snapshotInstalled: view.snapshotInstalled.bind(view),
		buildSearchIndex: view.buildSearchIndex.bind(view),
		buildAuthorFacet: view.buildAuthorFacet.bind(view),
		renderAuthorFacet: view.renderAuthorFacet.bind(view),
		toggleAuthorFilter: view.toggleAuthorFilter.bind(view),
		updateAuthorBanner: view.updateAuthorBanner.bind(view),
		applySearchInput: view.applySearchInput.bind(view),
		showAIPendingHint: view.showAIPendingHint.bind(view),
		showAIConfigGuide: view.showAIConfigGuide.bind(view),
		showLoadingState: view.showLoadingState.bind(view),
		updateStats: view.updateStats.bind(view),
		applyAIConfig: view.applyAIConfig.bind(view),
		updateGuidance: view.updateGuidance.bind(view),
		updateFacetVisibility: view.updateFacetVisibility.bind(view),
		showSearchGuide: view.showSearchGuide.bind(view),
		renderFeaturedSection: view.renderFeaturedSection.bind(view),
		ensureFeaturedSection: view.ensureFeaturedSection.bind(view),
		hideFeaturedSection: view.hideFeaturedSection.bind(view),
		renderPluginList: view.renderPluginList.bind(view),
		recomputeSmartSignalsIfNeeded: view.recomputeSmartSignalsIfNeeded.bind(view),
		runFilterPipeline: view.runFilterPipeline.bind(view),
		updateListChrome: view.updateListChrome.bind(view),
		invalidateAndRender: view.invalidateAndRender.bind(view),
		postRenderSync: view.postRenderSync.bind(view),
		refreshCardState: view.refreshCardState.bind(view),
		fillVisibleWindow: view.fillVisibleWindow.bind(view),
		updateWindow: view.updateWindow.bind(view),
		get windowStart() { return view.windowStart; },
		set windowStart(v) { view.windowStart = v; },
		get windowEnd() { return view.windowEnd; },
		set windowEnd(v) { view.windowEnd = v; },
		measureLayout: view.measureLayout.bind(view),
		measureLayoutIfNeeded: view.measureLayoutIfNeeded.bind(view),
		scheduleRender: view.scheduleRender.bind(view),
		renderWindow: view.renderWindow.bind(view),
		onCardClick: view.onCardClick.bind(view),
		toggleFavorite: view.toggleFavorite.bind(view),
		onCardKeydown: view.onCardKeydown.bind(view),
		focusCardByIdx: view.focusCardByIdx.bind(view),
		flashAction: view.flashAction.bind(view),
		openDetailDrawer: view.openDetailDrawer.bind(view),
		computeSimilarFor: view.computeSimilarFor.bind(view),
		updateCompareTray: view.updateCompareTray.bind(view),
		openCompareModal: view.openCompareModal.bind(view),
		enterCompareMode: view.enterCompareMode.bind(view),
		exitCompareMode: view.exitCompareMode.bind(view),
		refreshCompareHighlights: view.refreshCompareHighlights.bind(view),
		updateScrollButtons: view.updateScrollButtons.bind(view),
		updateScrollPosBadge: view.updateScrollPosBadge.bind(view),
		announceStatus: view.announceStatus.bind(view),
		refreshCardTranslation: view.refreshCardTranslation.bind(view),
		updateAiTranslateButton: view.updateAiTranslateButton.bind(view),
		runAISearch: view.runAISearch.bind(view),
		aiTranslateAllPending: view.aiTranslateAllPending.bind(view),
		setAIProgressDone: view.setAIProgressDone.bind(view),
		removeCompareTray: view.removeCompareTray.bind(view),
		tryLoadCachedPluginList: view.tryLoadCachedPluginList.bind(view),
		register: view.register.bind(view),
		getRecommendedIds: () => view.plugin.getRecommendedIds(),
		buildLocalIndex: (force?: boolean) => view.plugin.buildLocalIndex(force),
		warmupLocalEmbedding: () => view.plugin.warmupLocalEmbedding(),
		get translateVisibleTimer() { return view.translateVisibleTimer; },
		set translateVisibleTimer(v) { view.translateVisibleTimer = v; },
		isTranslated: view.isTranslated.bind(view),
	};
}

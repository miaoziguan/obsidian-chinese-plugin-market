import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ChinesePluginMarketView } from "@ui/view/translator-view";
import { createViewContext, type ViewContext } from "./view-context";

/**
 * createViewContext（483-888，约 405 行）——视图状态门面。
 *
 * 这是 ui 层第二大的未覆盖缺口（405 条语句、此前零测试）。整块是
 * 「把 view / view.plugin 的状态与方法收敂成一个 ctx 对象」的委派层：
 * ~400 个 getter/setter + ~60 个函数委托。
 *
 * 覆盖策略（关键认知）：getter/setter 的**函数体只有被读写才计入覆盖**，
 * 光建对象不算。所以这里用遍历方式逐个读写全部访问器——同时这本身就是
 * 一个真实的回归守卫：若某个 setter 写 view.plugin.X 而 getter 读 view.X，
 * 读写闭环会当场失败（这类「两边指不到同一处」正是委派层最容易出的错）。
 *
 * 另有若干由注释明确记录过 bug 的动态 getter，单独写契约测试锁住：
 * profiles / chineseEcoSet / bambooSeriesSet 必须「动态读」而非值拷贝
 * （值拷贝会让异步到货的清单恒空、另存为的组合在下拉里看不到）。
 */

vi.mock("@shared/i18n", () => ({
	makeT: () => (k: string) => `T:${k}`,
}));

const plugin = (id: string): PluginInfo => ({ id, name: `插件${id}`, description: "", author: "作者" } as PluginInfo);

/** 记录 enterDetailMode 被调用时的 this（验证 .bind(view) 生效） */
let enterDetailThis: unknown = null;

type ViewMock = ChinesePluginMarketView & Record<string, unknown>;

/**
 * 构造最小可用的 view mock。
 * 状态字段显式给出；未定义的方法用 Proxy 按需兜底为 vi.fn——
 * createViewContext 会对 60+ 个 view 方法做 .bind(view)，漏一个就 TypeError。
 */
function makeView(over: Record<string, unknown> = {}): ViewMock {
	const storage = {
		loadStatsCache: vi.fn(),
		saveTrendingHistory: vi.fn(),
		savePluginListCache: vi.fn(),
		saveStatsCache: vi.fn(),
	};
	const pluginObj: Record<string, unknown> = {
		manifest: { id: "chinese-plugin-market" },
		pluginTagMap: {},
		settings: { profiles: [], betaPlugins: [], pluginVersionPins: {}, aiSearchEnabled: false },
		cachedStats: null,
		cachedTrendingHistory: null,
		recommendedTitle: "",
		seenPluginIds: new Set<string>(),
		firstSeenMap: new Map(),
		journalTriedIds: new Set<string>(),
		journalEntryIds: new Set<string>(),
		journalAbandonedIds: new Set<string>(),
		journalVerdictIds: new Set<string>(),
		journalStats: null,
		pluginDeps: {},
		storage,
		saveVectorIndex: vi.fn(),
		applyProfile: vi.fn(),
		saveCurrentAsProfile: vi.fn(() => true),
		saveSettings: vi.fn(),
		flushSaveSettings: vi.fn(),
		saveTranslatorData: vi.fn(),
		flushTranslatorData: vi.fn(),
		getRecommendedIds: vi.fn(() => [] as string[]),
		buildLocalIndex: vi.fn(),
		warmupLocalEmbedding: vi.fn(),
		updateBetaPluginById: vi.fn(),
		updateAllBetaPlugins: vi.fn(),
		setBetaFrozen: vi.fn(),
		removeBetaPlugin: vi.fn(),
		openDirectInstall: vi.fn(),
		recordBetaInstall: vi.fn(),
	};

	const base: Record<string, unknown> = {
		translator: {},
		app: {},
		plugin: pluginObj,
		containerEl: document.createElement("div"),
		contentEl: document.createElement("div"),
		t: (k: string) => `V:${k}`,
		// 核心状态
		plugins: [] as PluginInfo[],
		translatedResults: {} as Record<string, unknown>,
		searchQuery: "",
		searchMode: "keyword",
		sourceFilter: "all",
		installFilter: "all",
		favoriteFilter: "all",
		chineseEcoFilter: "all",
		seriesFilter: "all",
		triedFilter: "all",
		abandonedFilter: "all",
		verdictFilter: "all",
		newWithinDays: 0,
		updatedWithinDays: 0,
		sortBy: "downloads",
		sortByUserSelected: false,
		semanticSortBackup: null,
		dataLoaded: false,
		dataLoading: false,
		lastListFetchAt: 0,
		compareMode: false,
		compareSet: new Set<string>(),
		favoritesSet: new Set<string>(),
		sortFavoritesFirst: false,
		aiSearchResult: null,
		aiSearchPending: false,
		aiSearchQueryCache: new Map(),
		lastAiSearchResult: null,
		lastAiSearchQuery: "",
		aiTranslateRunning: false,
		translatedThisSession: 0,
		// 滚动与测量
		visibleList: [] as PluginInfo[],
		defaultRowH: 100,
		rowGap: 0,
		colCount: 3,
		lastListSignature: "",
		cardPool: [] as HTMLElement[],
		pendingCards: new Set<HTMLElement>(),
		cardPoolCtx: null,
		cardById: new Map<string, HTMLElement>(),
		cachedRowH: 0,
		layoutDirty: false,
		cachedScrollHeight: 0,
		pluginMap: new Map(),
		pluginMapSrc: null,
		disposed: false,
		scrollRAF: 0,
		scrollVelocity: 0,
		lastScrollTopSample: 0,
		lastScrollSampleAt: 0,
		fillIdleHandle: null,
		measureRAF: 0,
		renderRAF: 0,
		descRAF: 0,
		debounceTimer: undefined,
		scrollPosTimer: undefined,
		resizeObserver: null,
		// DOM 引用
		scrollViewport: null,
		scrollCardLayer: null,
		updatesListEl: null,
		betaListEl: null,
		cssSnippetListEl: null,
		favoritesListEl: null,
		favoriteGroupFilter: "all",
		favKeyword: "",
		resultCountEl: null,
		aiTranslateBtnEl: null,
		aiProgressEl: null,
		refreshBtn: null,
		backTopBtn: null,
		scrollBottomBtn: null,
		compareTrayEl: null,
		scrollPosEl: null,
		lastScrollPosText: "",
		facetContainerEl: null,
		catRowEl: null,
		refreshFacets: null,
		authorRowEl: null,
		guidanceEl: null,
		authorFacetEl: null,
		featuredSectionEl: null,
		featuredGridEl: null,
		// Facet / 统计 / 信号 / 推荐
		searchIndex: null,
		filterCache: {},
		selectedCategories: new Set<string>(),
		authorFilter: null,
		advancedOpen: false,
		authorFacetList: [] as Array<{ authors: string[] }>,
		authorExpanded: false,
		activeAuthorLetter: "",
		recommendedOnly: false,
		statsMap: new Map(),
		releaseDatesMap: new Map(),
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		installedVersions: new Map(),
		outdatedIds: new Set<string>(),
		outdatedInfo: new Map(),
		viewTab: "browse",
		updateSelection: new Set<string>(),
		updatesViewMode: "pending",
		installingIds: new Set<string>(),
		updatingIds: new Set<string>(),
		smartSignals: new Map(),
		pluginsRev: 0,
		smartSignalsRev: 0,
		trendingEngine: null,
		trendingScores: new Map(),
		recommendScores: new Map(),
		invertedIndex: null,
		focusedCardIdx: -1,
		listState: "list",
		featuredCollapsed: false,
		activeDrawer: null,
		windowStart: -1,
		windowEnd: -1,
		spacerTop: null,
		spacerBottom: null,
		translateVisibleTimer: undefined,
		// 异步到货的清单
		chineseEcoSet: new Set<string>(),
		bambooSeriesSet: new Set<string>(),
		yulinPicksSet: new Set<string>(),
		cssStore: {},
		// 记录 this，验证 bind
		enterDetailMode() {
			enterDetailThis = this;
		},
		exitDetailMode: vi.fn(),
		...over,
	};

	return new Proxy(base, {
		get(target, prop) {
			const key = String(prop);
			if (key in target) return target[key];
			// 兜底：createViewContext 会对大量 view 方法做 .bind(view)，
			// 未显式定义的一律按需给个 vi.fn，避免漏一个就 TypeError
			const fn = vi.fn();
			target[key] = fn;
			return fn;
		},
	}) as ViewMock;
}

function setup(over: Record<string, unknown> = {}) {
	const view = makeView(over);
	const ctx = createViewContext(view);
	return { view, ctx };
}

const keysOf = (ctx: ViewContext) => Object.keys(ctx as unknown as Record<string, unknown>);
const anyCtx = (ctx: ViewContext) => ctx as unknown as Record<string, unknown>;

beforeEach(() => {
	enterDetailThis = null;
	document.body.innerHTML = "";
});

describe("createViewContext：委派闭环", () => {
	it("每个 getter 都能读到（不抛错）", () => {
		const { ctx } = setup();
		for (const key of keysOf(ctx)) {
			const desc = Object.getOwnPropertyDescriptor(ctx, key);
			if (!desc?.get) continue;
			expect(() => void anyCtx(ctx)[key], `读 ctx.${key} 抛错`).not.toThrow();
		}
	});

	it("每个 setter 写进去都能原样读回（委派两侧必须指到同一处）", () => {
		const { ctx } = setup();
		for (const key of keysOf(ctx)) {
			const desc = Object.getOwnPropertyDescriptor(ctx, key);
			if (!desc?.set) continue;
			const sentinel = { tag: key };
			anyCtx(ctx)[key] = sentinel;
			// 若 setter 写 view.plugin.X 而 getter 读 view.X（或反之），这里会失败
			expect(anyCtx(ctx)[key], `ctx.${key} 读写未闭环`).toBe(sentinel);
		}
	});

	it("所有函数委托都能被调用且不抛错", () => {
		const { ctx } = setup();
		for (const key of keysOf(ctx)) {
			const v = anyCtx(ctx)[key];
			if (typeof v !== "function") continue;
			expect(() => (v as (...a: unknown[]) => unknown)(), `调用 ctx.${key} 抛错`).not.toThrow();
		}
	});
});

describe("动态 getter（注释明确记过值拷贝 bug，锁成契约）", () => {
	it("profiles 动态读：另存为换新数组后 ctx 立即看到（值拷贝会让下拉看不到新组合）", () => {
		const { view, ctx } = setup();
		const before = [{ id: "p1", name: "A", enabledIds: [] as string[], enabled: [] as string[] }];
		view.plugin.settings.profiles = before as never;
		expect(ctx.profiles).toBe(before);
		const after = [...before, { id: "p2", name: "B", enabledIds: [] as string[], enabled: [] as string[] }];
		view.plugin.settings.profiles = after;
		expect(ctx.profiles).toBe(after);
	});

	it("中文生态 / 系列清单异步晚到：ctx 读到最新 Set（值拷贝会让筛选恒空）", () => {
		const { view, ctx } = setup();
		// 视图创建时清单还没到货
		expect(ctx.chineseEcoSet.size).toBe(0);
		expect(ctx.bambooSeriesSet.size).toBe(0);
		const eco = new Set(["zh-plugin-a"]);
		const series = new Set(["bamboo-x"]);
		view.chineseEcoSet = eco;
		view.bambooSeriesSet = series;
		expect(ctx.chineseEcoSet).toBe(eco);
		expect(ctx.bambooSeriesSet).toBe(series);
	});

	it("knownPluginIds 由 plugins 派生，随列表变化（判定依赖目标能否给安装入口）", () => {
		const { view, ctx } = setup();
		view.plugins = [plugin("a"), plugin("b")];
		expect([...ctx.knownPluginIds!].sort()).toEqual(["a", "b"]);
		view.plugins = [plugin("c")];
		expect([...ctx.knownPluginIds!]).toEqual(["c"]);
	});

	it("allPlugins 与 plugins 同源；depGraph 与 pluginDeps 同源（卡片徽标用同一份数据）", () => {
		const { view, ctx } = setup();
		view.plugins = [plugin("a")];
		expect(ctx.allPlugins).toBe(view.plugins);
		const deps = { a: [] };
		view.plugin.pluginDeps = deps as never;
		expect(ctx.depGraph).toBe(view.plugin.pluginDeps);
		expect(ctx.pluginDeps).toBe(view.plugin.pluginDeps);
	});

	it("settings 读写透传到 view.plugin.settings", () => {
		const { view, ctx } = setup();
		const s = { ...view.plugin.settings, sortBy: "downloads" };
		ctx.settings = s as never;
		expect(view.plugin.settings).toBe(s);
		expect(ctx.settings).toBe(s);
	});

	it("view 未提供 t 时回退 makeT()", () => {
		const view = makeView();
		// 显式置空：Proxy 兜底只补未定义的，已定义的（即使 undefined）原样返回
		(view as Record<string, unknown>).t = undefined;
		const ctx = createViewContext(view);
		expect(typeof ctx.t).toBe("function");
		expect(ctx.t("app.loading")).toBe("T:app.loading");
	});
});

describe("函数委托的转发目标", () => {
	it("持久化门面转发到 plugin（saveSettings / flush / translator 数据）", () => {
		const { view, ctx } = setup();
		ctx.saveSettings();
		ctx.flushSaveSettings();
		ctx.saveTranslatorData();
		ctx.flushTranslatorData();
		expect(view.plugin.saveSettings).toHaveBeenCalled();
		expect(view.plugin.flushSaveSettings).toHaveBeenCalled();
		expect(view.plugin.saveTranslatorData).toHaveBeenCalled();
		expect(view.plugin.flushTranslatorData).toHaveBeenCalled();
	});

	it("track 保留为 no-op（埋点已移除，维持调用点接口稳定）", () => {
		const { ctx } = setup();
		// ctx 侧 track 首参标成 number（埋点已移除，签名未同步收敛），本轮只锁「no-op 不写盘」
		expect((ctx.track as unknown as (...a: unknown[]) => unknown)("any", "args")).toBeUndefined();
	});

	it("缓存读写委托到 plugin.storage 与 saveVectorIndex", () => {
		const { view, ctx } = setup();
		ctx.loadStatsCache();
		expect(view.plugin.storage.loadStatsCache).toHaveBeenCalled();
		(ctx.saveTrendingHistory as (h: unknown) => void)([]);
		expect(view.plugin.storage.saveTrendingHistory).toHaveBeenCalled();
		(ctx.savePluginListCache as (l: unknown) => void)([]);
		expect(view.plugin.storage.savePluginListCache).toHaveBeenCalled();
		(ctx.saveStatsCache as (m: unknown) => void)(new Map());
		expect(view.plugin.storage.saveStatsCache).toHaveBeenCalled();
		ctx.saveVectorIndex();
		expect(view.plugin.saveVectorIndex).toHaveBeenCalled();
	});

	it("profiles 相关委托到 plugin（applyProfile / saveCurrentAsProfile）", () => {
		const { view, ctx } = setup();
		const p = { id: "x", name: "X", enabledIds: [] as string[] } as never;
		void ctx.applyProfile(p);
		expect(view.plugin.applyProfile).toHaveBeenCalledWith(p);
		ctx.pluginSaveProfile("新组合");
		expect(view.plugin.saveCurrentAsProfile).toHaveBeenCalledWith("新组合");
	});

	it("本地索引 / 推荐委托到 plugin", () => {
		const { view, ctx } = setup();
		ctx.getRecommendedIds();
		expect(view.plugin.getRecommendedIds).toHaveBeenCalled();
		ctx.buildLocalIndex(true);
		expect(view.plugin.buildLocalIndex).toHaveBeenCalledWith(true);
		ctx.warmupLocalEmbedding();
		expect(view.plugin.warmupLocalEmbedding).toHaveBeenCalled();
	});

	it("beta 与版本固定委托到 view / plugin", () => {
		const { view, ctx } = setup();
		ctx.pinPluginVersion("a", "1.0.0");
		expect(view.pinPluginVersion).toHaveBeenCalledWith("a", "1.0.0");
		(ctx.listPluginVersions as (r: string, f?: boolean) => void)("u/a", true);
		expect(view.listPluginVersions).toHaveBeenCalledWith("u/a", true);
		ctx.setBetaFrozen("b", true);
		expect(view.plugin.setBetaFrozen).toHaveBeenCalledWith("b", true);
		// ctx 侧签名标成 number、plugin 侧实为 string（既有签名不一致，本轮只锁转发行为）
		(ctx.removeBetaPlugin as unknown as (id: string) => void)("b");
		expect(view.plugin.removeBetaPlugin).toHaveBeenCalledWith("b");
		ctx.updateBetaPluginById("b");
		expect(view.plugin.updateBetaPluginById).toHaveBeenCalledWith("b");
		ctx.updateAllBetaPlugins();
		expect(view.plugin.updateAllBetaPlugins).toHaveBeenCalled();
		const cb = vi.fn();
		(ctx.openDirectInstall as (k: unknown, c: unknown) => void)("beta", cb);
		expect(view.plugin.openDirectInstall).toHaveBeenCalledWith("beta", cb);
		(ctx.recordBetaInstall as (i: unknown) => void)({});
		expect(view.plugin.recordBetaInstall).toHaveBeenCalled();
	});

	it("页签列表渲染委托到 view", () => {
		const { view, ctx } = setup();
		ctx.renderUpdatesList();
		expect(view.renderUpdatesList).toHaveBeenCalled();
		ctx.renderBetaList();
		expect(view.renderBetaList).toHaveBeenCalled();
		ctx.renderCssSnippetsList();
		expect(view.renderCssSnippetsList).toHaveBeenCalled();
		ctx.renderFavoritesList();
		expect(view.renderFavoritesList).toHaveBeenCalled();
	});

	it("模块方法一次性绑好 this（enterDetailMode 内 this 仍是 view）", () => {
		const { view, ctx } = setup();
		ctx.enterDetailMode();
		expect(enterDetailThis).toBe(view);
	});

	it("视口/窗口状态读写透传到 view", () => {
		const { view, ctx } = setup();
		ctx.windowStart = 3;
		ctx.windowEnd = 9;
		expect(view.windowStart).toBe(3);
		expect(view.windowEnd).toBe(9);
		const top = document.createElement("div");
		ctx.spacerTop = top as never;
		expect(view.spacerTop).toBe(top);
	});
});

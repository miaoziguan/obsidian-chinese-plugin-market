import { describe, it, expect, vi } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import { FilterCache } from "@domain/filter/filter";
import type { ViewContext } from "./view-context";
import { runFilterPipeline, updateListChrome, recomputeSmartSignalsIfNeeded } from "./view-render";

/**
 * 列表渲染管线的「决策层」：筛排 + 结论回写。
 *
 * 真正画 DOM 的那部分（卡片池、虚拟窗口）另行覆盖；这里只锁定
 * 最容易无声改坏的两件事：
 *   1. 筛选/排序参数是否正确从 ctx 透传给 domain 层
 *   2. 管线跑完之后 ctx 的状态是否被正确回写（visibleList、焦点、AI 结果、缓存）
 */

const DAY = 86_400_000;

const plugin = (id: string, over: Partial<PluginInfo> = {}): PluginInfo => ({
	id,
	name: `插件${id}`,
	description: "",
	author: "作者",
	...over,
});

type Ctx = Record<string, unknown>;

function makeCtx(over: Ctx = {}): ViewContext {
	const ctx: Ctx = {
		plugins: [] as PluginInfo[],
		searchMode: "keyword",
		searchQuery: "",
		sourceFilter: "all",
		installFilter: "all",
		authorFilter: null,
		recommendedOnly: false,
		getRecommendedIds: () => new Set<string>(),
		sortFavoritesFirst: false,
		favoriteFilter: "all",
		favoritesSet: new Set<string>(),
		chineseEcoFilter: "all",
		chineseEcoSet: new Set<string>(),
		seriesFilter: "all",
		bambooSeriesSet: new Set<string>(),
		yulinPicksSet: new Set<string>(),
		triedFilter: "all",
		journalTriedIds: new Set<string>(),
		abandonedFilter: "all",
		journalAbandonedIds: new Set<string>(),
		newWithinDays: null,
		updatedWithinDays: null,
		releaseDatesMap: new Map<string, number>(),
		selectedCategories: [] as string[],
		pluginTagMap: new Map<string, string>(),
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		translatedResults: {},
		searchIndex: new Map<string, string>(),
		sortBy: "default",
		trendingScores: new Map<string, number>(),
		recommendScores: new Map<string, number>(),
		aiSearchResult: null,
		aiSearchQueryCache: "",
		translator: { hasAnyTranslation: () => false },
		filterCache: new FilterCache(),
		settings: { demoteAtRisk: false, healthHealthyDays: 180, healthAgingDays: 365 },
		visibleList: [] as PluginInfo[],
		focusedCardIdx: 3,
		resultCountEl: null,
		renderFeaturedSection: vi.fn(),
		announceStatus: vi.fn(),
		...over,
	};
	return ctx as unknown as ViewContext;
}

describe("runFilterPipeline：参数透传与结果回写", () => {
	it("返回排序后的列表并写入 visibleList", () => {
		const ctx = makeCtx({ plugins: [plugin("a"), plugin("b")] });

		const list = runFilterPipeline(ctx, "");

		expect(list.length).toBe(2);
		expect(ctx.visibleList).toBe(list);
	});

	it("重置卡片焦点（列表变化后旧下标无意义）", () => {
		const ctx = makeCtx({ plugins: [plugin("a")], focusedCardIdx: 5 });

		runFilterPipeline(ctx, "");

		expect(ctx.focusedCardIdx).toBe(-1);
	});

	it("把筛选结果同步回前缀缓存", () => {
		const ctx = makeCtx({ plugins: [plugin("a")] });
		const sync = vi.spyOn(ctx.filterCache, "sync");

		runFilterPipeline(ctx, "");

		expect(sync).toHaveBeenCalled();
	});

	it("domain 层要求清空 AI 结果时，同步清掉查询缓存", () => {
		const ctx = makeCtx({
			plugins: [plugin("a")],
			searchMode: "keyword",
			aiSearchResult: { hits: [1] },
			aiSearchQueryCache: "旧查询",
		});

		runFilterPipeline(ctx, "新词");

		expect(ctx.aiSearchResult).toBeNull();
		expect(ctx.aiSearchQueryCache).toBe("");
	});

	it("只安装筛选为 all 时不会误筛掉未安装插件", () => {
		const ctx = makeCtx({ plugins: [plugin("a"), plugin("b")], installFilter: "all" });
		expect(runFilterPipeline(ctx, "").length).toBe(2);
	});

	it("只安装筛选为 installed 时只保留已装", () => {
		const ctx = makeCtx({
			plugins: [plugin("a"), plugin("b")],
			installFilter: "installed",
			installedIds: new Set(["a"]),
		});

		const list = runFilterPipeline(ctx, "");

		expect(list.map((p) => p.id)).toEqual(["a"]);
	});
});

describe("runFilterPipeline：停更风险沉底", () => {
	const fresh = () => plugin("fresh", { updated: Date.now() - 2 * DAY });
	const stale = () => plugin("stale", { updated: Date.now() - 1000 * DAY });

	it("未开启沉底时保持原有顺序", () => {
		const ctx = makeCtx({
			plugins: [stale(), fresh()],
			settings: { demoteAtRisk: false, healthHealthyDays: 180, healthAgingDays: 365 },
		});

		const ids = runFilterPipeline(ctx, "").map((p) => p.id);

		expect(ids[0]).toBe("stale");
	});

	it("开启沉底时把 at-risk 插件稳定挪到末尾（其余顺序不变）", () => {
		const ctx = makeCtx({
			plugins: [stale(), fresh(), plugin("fresh2", { updated: Date.now() - 1 * DAY })],
			settings: { demoteAtRisk: true, healthHealthyDays: 180, healthAgingDays: 365 },
		});

		const ids = runFilterPipeline(ctx, "").map((p) => p.id);

		expect(ids[ids.length - 1]).toBe("stale");
		// 稳定排序：健康插件之间的相对顺序保持原样
		expect(ids.slice(0, 2)).toEqual(["fresh", "fresh2"]);
	});

	it("没有 at-risk 插件时不重排", () => {
		const ctx = makeCtx({
			plugins: [fresh(), plugin("f2", { updated: Date.now() - 3 * DAY })],
			settings: { demoteAtRisk: true, healthHealthyDays: 180, healthAgingDays: 365 },
		});

		expect(runFilterPipeline(ctx, "").map((p) => p.id)).toEqual(["fresh", "f2"]);
	});
});

describe("updateListChrome：结果计数与无障碍播报", () => {
	it("更新结果计数并播报给读屏器", () => {
		const el = document.createElement("span");
		const announceStatus = vi.fn();
		const ctx = makeCtx({ resultCountEl: el, announceStatus });

		updateListChrome(ctx, [plugin("a"), plugin("b")]);

		expect(el.textContent).toContain("2");
		expect(announceStatus).toHaveBeenCalled();
	});

	it("没有计数值元素时不报错", () => {
		const ctx = makeCtx({ resultCountEl: null });
		expect(() => updateListChrome(ctx, [])).not.toThrow();
	});

	it("每次都刷新精选区（推荐位依赖最新可见集合）", () => {
		const ctx = makeCtx();
		updateListChrome(ctx, []);
		expect(ctx.renderFeaturedSection).toHaveBeenCalled();
	});
});

describe("recomputeSmartSignalsIfNeeded：按版本号短路", () => {
	const makeSignalsCtx = (over: Ctx = {}) => {
		const updateWithStats = vi.fn(() => false);
		const trendingEngine = {
			isEmpty: () => true,
			load: vi.fn(),
			lastSampleStats: () => new Map(),
			updateWithStats,
			prune: vi.fn(() => false),
			batchTrendingScores: vi.fn(() => new Map()),
			serialize: vi.fn(() => ({})),
		};
		const ctx = makeCtx({
			// 没有插件时整个重算块会被跳过（下面「列表为空」用例专门覆盖该分支）
			plugins: [plugin("a")],
			pluginsRev: 2,
			smartSignalsRev: 1,
			smartSignals: {} as Record<string, unknown>,
			trendingEngine,
			cachedTrendingHistory: null,
			trendingScores: new Map(),
			recommendScores: new Map(),
			invertedIndex: { build: vi.fn() },
			translator: { hasAnyTranslation: () => false, tagService: null },
			...over,
		});
		return { ctx, updateWithStats };
	};

	it("版本号一致时跳过重算", () => {
		const { ctx } = makeSignalsCtx({ pluginsRev: 2, smartSignalsRev: 2 });

		recomputeSmartSignalsIfNeeded(ctx);

		expect(ctx.trendingEngine.batchTrendingScores).not.toHaveBeenCalled();
	});

	it("插件集合变化时重算并记录版本号", () => {
		const { ctx } = makeSignalsCtx();

		recomputeSmartSignalsIfNeeded(ctx);

		expect(ctx.smartSignalsRev).toBe(2);
		expect(ctx.trendingEngine.batchTrendingScores).toHaveBeenCalled();
	});

	it("列表为空时不重算", () => {
		const { ctx } = makeSignalsCtx({ plugins: [] });

		recomputeSmartSignalsIfNeeded(ctx);

		expect(ctx.smartSignalsRev).toBe(1);
	});

	it("开启趋势采样且产生新采样点时落盘历史", () => {
		const { ctx, updateWithStats } = makeSignalsCtx({
			settings: { demoteAtRisk: false, healthHealthyDays: 180, healthAgingDays: 365, trendSampling: true },
		});
		updateWithStats.mockReturnValue(true);
		ctx.saveTrendingHistory = vi.fn(async () => {});

		recomputeSmartSignalsIfNeeded(ctx);

		expect(ctx.saveTrendingHistory).toHaveBeenCalled();
	});

	it("标签未就绪时不构建空倒排索引（否则相似推荐永远为空）", () => {
		const { ctx } = makeSignalsCtx({
			translator: {
				hasAnyTranslation: () => false,
				tagService: { getTag: () => null },
			},
		});

		recomputeSmartSignalsIfNeeded(ctx);

		expect(ctx.invertedIndex.build).not.toHaveBeenCalled();
	});
});

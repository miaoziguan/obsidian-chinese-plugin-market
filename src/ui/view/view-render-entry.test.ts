import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "./view-context";
import { renderPluginList, invalidateAndRender, postRenderSync, refreshCardState } from "./view-render";
import { setListState } from "@ui/dom/list-state";
import { applyCardState } from "@ui/components/card-render";

/**
 * 渲染管线的入口与同步层：renderPluginList（23-89）、invalidateAndRender（227-241）、
 * postRenderSync（251-258）、refreshCardState（260-286）。
 *
 * 前一轮已覆盖窗口化渲染（renderWindow / updateWindowImpl / fillVisibleWindow），
 * 这一轮补的是**入口决策**：什么时候该重建、什么时候该跳过。
 * 错误模式是「性能退化 + 界面说谎」：签名守卫漏维会导致「点了筛选但列表一张卡没换」，
 * 或反过来每次按键都全量重建导致闪烁回顶；refreshCardState 漏 CSS.escape 会让
 * 含引号的插件 id 直接抛 SyntaxError 中断刷新。都不崩溃，只让用户拿到坏体验。
 */

const filterMock = vi.hoisted(() => ({
	signature: "sig-base",
}));

vi.mock("@ui/view/active-filters", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ui/view/active-filters")>();
	return { ...actual, activeFilterSignature: vi.fn(() => filterMock.signature) };
});

vi.mock("@ui/dom/list-state", () => ({ setListState: vi.fn() }));

vi.mock("@ui/components/card-render", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ui/components/card-render")>();
	return { ...actual, applyCardState: vi.fn() };
});

// jsdom 较老版本没有 CSS.escape，而 refreshCardState 依赖它转义插件 id
if (!(window as unknown as { CSS?: { escape?: unknown } }).CSS?.escape) {
	const g = window as unknown as { CSS: { escape: (s: string) => string } };
	g.CSS = { ...(g.CSS ?? {}), escape: (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, (c) => `\\${c}`) };
}

type Ctx = Record<string, unknown>;

const plugin = (id: string): PluginInfo => ({ id, name: `插件${id}`, description: "", author: "作者" } as PluginInfo);

function makeCtx(over: Ctx = {}): ViewContext {
	const layer = document.createElement("div");
	const viewport = document.createElement("div");
	const featuredGridEl = document.createElement("div");
	const ctx: Ctx = {
		disposed: false,
		compareMode: false,
		dataLoaded: true,
		plugins: [] as PluginInfo[],
		pluginMap: new Map<string, PluginInfo>(),
		visibleList: [] as PluginInfo[],
		scrollCardLayer: layer,
		scrollViewport: viewport,
		featuredGridEl,
		contentEl: document.createElement("div"),
		searchQuery: "",
		searchMode: "keyword",
		aiSearchPending: false,
		sortBy: "hot",
		sortFavoritesFirst: false,
		smartSignalsRev: 0,
		lastListSignature: "",
		layoutDirty: false,
		translatedResults: {} as Record<string, unknown>,
		favoritesSet: new Set<string>(),
		compareSet: new Set<string>(),
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		aiSearchResult: null,
		smartSignals: new Map(),
		outdatedIds: new Set<string>(),
		outdatedInfo: new Map(),
		installingIds: new Set<string>(),
		updatingIds: new Set<string>(),
		journalTriedIds: new Set<string>(),
		journalEntryIds: new Set<string>(),
		firstSeenMap: new Map(),
		yulinPicksSet: new Set<string>(),
		getRecommendedIds: () => [] as string[],
		translator: { persistSystemTranslation: vi.fn() },
		saveTranslatorData: vi.fn(),
		updatePlugin: vi.fn(),
		t: (k: string) => k,
		settings: {},
		app: {} as never,
		// 管线各段（renderPluginList 通过 ctx 调用，便于断言调用与顺序）
		recomputeSmartSignalsIfNeeded: vi.fn(),
		runFilterPipeline: vi.fn(() => [] as PluginInfo[]),
		updateListChrome: vi.fn(),
		invalidateAndRender: vi.fn(),
		postRenderSync: vi.fn(),
		measureLayout: vi.fn(),
		renderWindow: vi.fn(),
		updateAiTranslateButton: vi.fn(),
		updateScrollButtons: vi.fn(),
		...over,
	};
	return ctx as unknown as ViewContext;
}

beforeEach(() => {
	document.body.innerHTML = "";
	filterMock.signature = "sig-base";
	vi.mocked(setListState).mockClear();
	vi.mocked(applyCardState).mockClear();
});

describe("renderPluginList：早退守卫", () => {
	it("视图已卸载 → 完全不渲染", () => {
		const ctx = makeCtx({ disposed: true });
		renderPluginList(ctx);
		expect(setListState).not.toHaveBeenCalled();
		expect(ctx.runFilterPipeline).not.toHaveBeenCalled();
		expect(ctx.invalidateAndRender).not.toHaveBeenCalled();
	});

	it("对比模式 → 不渲染列表（列表被对比页替换）", () => {
		const ctx = makeCtx({ compareMode: true });
		renderPluginList(ctx);
		expect(ctx.runFilterPipeline).not.toHaveBeenCalled();
		expect(ctx.invalidateAndRender).not.toHaveBeenCalled();
	});

	it("数据未加载且列表为空 → 不渲染（避免误导性的「找到 0 个」）", () => {
		const ctx = makeCtx({ dataLoaded: false, plugins: [] });
		renderPluginList(ctx);
		expect(ctx.runFilterPipeline).not.toHaveBeenCalled();
		expect(ctx.invalidateAndRender).not.toHaveBeenCalled();
	});
});

describe("renderPluginList：正常管线", () => {
	it("依次走 列表态 → 智能信号 → 过滤 → chrome → 重建 → 后同步", () => {
		const filtered = [plugin("a"), plugin("b")];
		const ctx = makeCtx({ plugins: filtered, runFilterPipeline: vi.fn(() => filtered) });
		renderPluginList(ctx);
		expect(setListState).toHaveBeenCalledWith(ctx, "list");
		expect(ctx.recomputeSmartSignalsIfNeeded).toHaveBeenCalled();
		expect(ctx.updateListChrome).toHaveBeenCalledWith(filtered);
		expect(ctx.invalidateAndRender).toHaveBeenCalledWith(false);
		expect(ctx.postRenderSync).toHaveBeenCalled();
	});

	it("查询词取 trim 后的值传给过滤管线", () => {
		const ctx = makeCtx({ plugins: [plugin("a")], searchQuery: "  foo  " });
		renderPluginList(ctx);
		expect(ctx.runFilterPipeline).toHaveBeenCalledWith("foo");
	});

	it("preserveScroll 透传给重建", () => {
		const ctx = makeCtx({ plugins: [plugin("a")] });
		renderPluginList(ctx, true);
		expect(ctx.invalidateAndRender).toHaveBeenCalledWith(true);
	});
});

describe("renderPluginList：S2 增量签名守卫", () => {
	it("签名一致且卡片已在 DOM → 只后同步，不重建（避免闪烁与回顶）", () => {
		const filtered = [plugin("a")];
		const ctx = makeCtx({ plugins: filtered, runFilterPipeline: vi.fn(() => filtered) });
		renderPluginList(ctx); // 首次：写入 lastListSignature
		expect(ctx.invalidateAndRender).toHaveBeenCalledTimes(1);
		vi.mocked(ctx.invalidateAndRender).mockClear();
		vi.mocked(ctx.postRenderSync).mockClear();
		// 卡片已在 DOM（childElementCount > 0）
		ctx.scrollCardLayer!.appendChild(document.createElement("div"));
		renderPluginList(ctx); // 同一列表身份
		expect(ctx.invalidateAndRender).not.toHaveBeenCalled();
		expect(ctx.postRenderSync).toHaveBeenCalled();
	});

	it("签名一致但卡片不在 DOM → 仍需重建", () => {
		const filtered = [plugin("a")];
		const ctx = makeCtx({ plugins: filtered, runFilterPipeline: vi.fn(() => filtered) });
		renderPluginList(ctx);
		vi.mocked(ctx.invalidateAndRender).mockClear();
		// layer 空：说明卡片根本没渲染出来，不能靠守卫跳过
		expect(ctx.scrollCardLayer!.childElementCount).toBe(0);
		renderPluginList(ctx);
		expect(ctx.invalidateAndRender).toHaveBeenCalledTimes(1);
	});

	it("签名一致且结果为空 → 不重建空态（消除闪烁）", () => {
		const ctx = makeCtx({ runFilterPipeline: vi.fn(() => [] as PluginInfo[]) });
		renderPluginList(ctx); // 首次：空态建出来
		vi.mocked(ctx.invalidateAndRender).mockClear();
		vi.mocked(ctx.postRenderSync).mockClear();
		renderPluginList(ctx);
		expect(ctx.invalidateAndRender).not.toHaveBeenCalled();
		expect(ctx.postRenderSync).toHaveBeenCalled();
	});

	it("查询变化导致签名变化 → 走重建", () => {
		const filtered = [plugin("a")];
		const ctx = makeCtx({ plugins: filtered, runFilterPipeline: vi.fn(() => filtered) });
		renderPluginList(ctx);
		vi.mocked(ctx.invalidateAndRender).mockClear();
		ctx.scrollCardLayer!.appendChild(document.createElement("div"));
		ctx.searchQuery = "something-else"; // 签名随之变化
		renderPluginList(ctx);
		expect(ctx.invalidateAndRender).toHaveBeenCalledTimes(1);
	});

	it("筛选维度变化（activeFilterSignature 变化）→ 走重建", () => {
		const filtered = [plugin("a")];
		const ctx = makeCtx({ plugins: filtered, runFilterPipeline: vi.fn(() => filtered) });
		renderPluginList(ctx);
		vi.mocked(ctx.invalidateAndRender).mockClear();
		ctx.scrollCardLayer!.appendChild(document.createElement("div"));
		filterMock.signature = "sig-changed"; // 模拟筛选维度变化
		renderPluginList(ctx);
		expect(ctx.invalidateAndRender).toHaveBeenCalledTimes(1);
	});
});

describe("invalidateAndRender", () => {
	it("标脏并触发一次布局重测，再渲染窗口", () => {
		const ctx = makeCtx();
		invalidateAndRender(ctx, false);
		expect(ctx.layoutDirty).toBe(true);
		expect(ctx.measureLayout).toHaveBeenCalled();
		expect(ctx.renderWindow).toHaveBeenCalled();
	});

	it("不保留滚动 → 滚动位置归零", () => {
		const ctx = makeCtx();
		ctx.scrollViewport!.scrollTop = 400;
		invalidateAndRender(ctx, false);
		expect(ctx.scrollViewport!.scrollTop).toBe(0);
	});

	it("保留滚动 → 不动滚动位置", () => {
		const ctx = makeCtx();
		ctx.scrollViewport!.scrollTop = 400;
		invalidateAndRender(ctx, true);
		expect(ctx.scrollViewport!.scrollTop).toBe(400);
	});

	it("入场类 pt-list-in 只加一次", () => {
		const ctx = makeCtx();
		const layer = ctx.scrollCardLayer!;
		const addSpy = vi.spyOn(layer.classList, "add");
		invalidateAndRender(ctx, false);
		expect(layer.classList.contains("pt-list-in")).toBe(true);
		addSpy.mockClear();
		invalidateAndRender(ctx, false);
		expect(addSpy).not.toHaveBeenCalled();
	});
});

describe("postRenderSync", () => {
	it("刷新 AI 翻译按钮与滚动按钮", () => {
		const ctx = makeCtx();
		postRenderSync(ctx);
		expect(ctx.updateAiTranslateButton).toHaveBeenCalled();
		expect(ctx.updateScrollButtons).toHaveBeenCalled();
	});
});

describe("refreshCardState", () => {
	/** 在主列表造一张 .pt-card（含对比图标） */
	const makeCard = (parent: HTMLElement, id: string) => {
		const card = document.createElement("div");
		card.className = "pt-card";
		card.setAttribute("data-plugin-id", id);
		const cmp = document.createElement("span");
		cmp.setAttribute("data-action", "compare");
		card.appendChild(cmp);
		parent.appendChild(card);
		return card;
	};

	it("命中主列表卡片 → 按收藏集合更新 is-favorited", () => {
		const ctx = makeCtx({ plugins: [plugin("a")], favoritesSet: new Set(["a"]) });
		const card = makeCard(ctx.scrollCardLayer!, "a");
		refreshCardState(ctx, "a");
		expect(card.classList.contains("is-favorited")).toBe(true);
		expect(applyCardState).toHaveBeenCalled();
	});

	it("不再收藏 → 移除 is-favorited", () => {
		const ctx = makeCtx({ plugins: [plugin("a")], favoritesSet: new Set<string>() });
		const card = makeCard(ctx.scrollCardLayer!, "a");
		card.classList.add("is-favorited");
		refreshCardState(ctx, "a");
		expect(card.classList.contains("is-favorited")).toBe(false);
	});

	it("对比态：按 compareSet 切换对比图标", () => {
		const ctx = makeCtx({ plugins: [plugin("a")], compareSet: new Set(["a"]) });
		const card = makeCard(ctx.scrollCardLayer!, "a");
		refreshCardState(ctx, "a");
		expect(card.querySelector("[data-action='compare']")!.classList.contains("is-compare-on")).toBe(true);
	});

	it("主列表未命中 → 回退查官方推荐网格", () => {
		const ctx = makeCtx({ plugins: [plugin("b")], favoritesSet: new Set(["b"]) });
		const card = makeCard(ctx.featuredGridEl!, "b");
		refreshCardState(ctx, "b");
		expect(card.classList.contains("is-favorited")).toBe(true);
	});

	it("两处都没有该卡片 → 直接返回，不做任何填充", () => {
		const ctx = makeCtx({ plugins: [plugin("zz")] });
		refreshCardState(ctx, "zz");
		expect(applyCardState).not.toHaveBeenCalled();
	});

	it("id 含引号等特殊字符 → 经 CSS.escape 仍能命中（不会抛 SyntaxError）", () => {
		const weirdId = 'we"ird[id]';
		const ctx = makeCtx({ plugins: [plugin(weirdId)], favoritesSet: new Set([weirdId]) });
		const card = makeCard(ctx.scrollCardLayer!, weirdId);
		expect(() => refreshCardState(ctx, weirdId)).not.toThrow();
		expect(card.classList.contains("is-favorited")).toBe(true);
	});

	it("pluginMap 缺失时回退到全量列表查找并填充卡片", () => {
		const ctx = makeCtx({ plugins: [plugin("a")], pluginMap: undefined });
		const card = makeCard(ctx.scrollCardLayer!, "a");
		refreshCardState(ctx, "a");
		expect(applyCardState).toHaveBeenCalled();
		const [filledCard, filledPlugin] = vi.mocked(applyCardState).mock.calls[0];
		expect(filledCard).toBe(card);
		expect((filledPlugin as PluginInfo).id).toBe("a");
	});
});

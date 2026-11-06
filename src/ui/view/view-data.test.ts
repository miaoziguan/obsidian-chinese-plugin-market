import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ViewContext } from "./view-context";
import {
	mirrorConfig,
	mergeStatsIntoPlugins,
	mergeStatsFromCache,
	snapshotInstalled,
	buildSearchIndex,
	buildAuthorFacet,
	relativeTime,
	updateRefreshTooltip,
	ensureDataLoaded,
	applySearchInput,
	updateAiTranslateButton,
	toggleAuthorFilter,
	renderAuthorFacet,
	scheduleBm25Warmup,
	disposeViewDataCache,
} from "./view-data";
import { AISearcher } from "@domain/search/ai";
import { prepareSearchPlugins } from "@domain/search/search-plugins";
import { LLMClient } from "@translation/api/api";
import { PluginTagService } from "@domain/catalog/plugin-tags";
import type { Translator } from "@domain/catalog/translator";
import { makeMockContext } from "@shared/test-utils";

/**
 * 视图数据管线的「纯逻辑」部分。
 *
 * ViewContext 是 244 字段的巨型接口（由 translator-view 装配），
 * 这里只填被测函数实际用到的字段——用类型断言跨过形状检查。
 * 这样测的是函数逻辑本身，而不是上下文装配。
 */

/**
 * 补齐 Obsidian 挂在 Element 实例上的构造方法（el.createEl / createDiv）。
 * test/setup.ts 只补了全局 createEl 与样式方法，实例方法一直缺；
 * view-toolbar.test.ts 等处各自局部补齐——这里沿用同样做法，
 * 不改共享 setup（试过，会影响别的测试的元素构造路径）。
 */
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (
			this: HTMLElement,
			tag: string,
			o?: { cls?: string; text?: string } | string,
		): HTMLElement {
			const el = document.createElement(tag);
			if (typeof o === "string") el.textContent = o;
			else if (o) {
				if (o.cls) el.className = o.cls;
				if (o.text != null) el.textContent = o.text;
			}
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o?: { cls?: string; text?: string } | string): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.createSpan) {
		proto.createSpan = function (this: HTMLElement, o?: { cls?: string; text?: string } | string): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("span", o);
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, text: string): void {
			this.textContent = text;
		};
	}
}

ensureDomHelpers();

type Ctx = Record<string, unknown>;

function makeCtx(over: Ctx = {}): ViewContext {
	const ctx: Ctx = {
		plugins: [] as unknown[],
		translatedResults: {},
		statsMap: new Map(),
		cachedStats: null,
		pluginsRev: 0,
		pluginMap: null,
		pluginMapSrc: -1,
		searchIndex: new Map(),
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		installedVersions: new Map(),
		filterCache: { reset: vi.fn() },
		installFilter: "all",
		settings: { mirrorSource: "auto", mirrorCustomBase: "" },
		app: {},
		t: (k: string) => k,
		refreshBtn: null,
		lastListFetchAt: null,
		relativeTime: (ts: number) => `rel:${ts}`,
		...over,
	};
	return ctx as unknown as ViewContext;
}

type TestPlugin = {
	id: string;
	name: string;
	author: string;
	description: string;
	downloads?: number;
	updated?: number;
};

const plugin = (id: string, over: Partial<TestPlugin> = {}): TestPlugin => ({
	id,
	name: id,
	author: "作者",
	description: "",
	...over,
});

describe("mirrorConfig：镜像配置透传", () => {
	it("取 settings 的镜像源与自定义 base", () => {
		const ctx = makeCtx({ settings: { mirrorSource: "custom", mirrorCustomBase: "https://m.example/" } });
		expect(mirrorConfig(ctx)).toEqual({ source: "custom", customBase: "https://m.example/" });
	});

	it("未配置自定义 base 时原样返回空", () => {
		const ctx = makeCtx({ settings: { mirrorSource: "auto", mirrorCustomBase: "" } });
		expect(mirrorConfig(ctx)).toEqual({ source: "auto", customBase: "" });
	});
});

describe("mergeStatsIntoPlugins：统计就地合并", () => {
	it("按 id 写入下载量与更新时间", () => {
		const p = plugin("a");
		const ctx = makeCtx({
			plugins: [p],
			statsMap: new Map([["a", { downloads: 999, updated: 1700000000000 }]]),
		});

		mergeStatsIntoPlugins(ctx);

		expect(p.downloads).toBe(999);
		expect(p.updated).toBe(1700000000000);
	});

	it("updated 为 null 时不覆盖插件已有更新时间", () => {
		const p = plugin("a", { updated: 111 });
		const ctx = makeCtx({
			plugins: [p],
			statsMap: new Map([["a", { downloads: 1, updated: null }]]),
		});

		mergeStatsIntoPlugins(ctx);

		expect(p.updated).toBe(111);
		expect(p.downloads).toBe(1);
	});

	it("无对应统计的插件保持原值", () => {
		const p = plugin("a", { downloads: 7 });
		const ctx = makeCtx({ plugins: [p], statsMap: new Map() });

		mergeStatsIntoPlugins(ctx);

		expect(p.downloads).toBe(7);
	});

	it("合并后递增 pluginsRev，让智能信号缓存失效", () => {
		const ctx = makeCtx({ plugins: [plugin("a")] });
		const before = ctx.pluginsRev;

		mergeStatsIntoPlugins(ctx);

		expect(ctx.pluginsRev).toBe(before + 1);
	});
});

describe("mergeStatsFromCache：离线可用性", () => {
	it("有缓存时先用缓存填充，保证断网也有下载量", () => {
		const cached = new Map([["a", { downloads: 42 }]]);
		const merge = vi.fn();
		const ctx = makeCtx({ cachedStats: cached, mergeStatsIntoPlugins: merge });

		mergeStatsFromCache(ctx);

		expect(ctx.statsMap).toBe(cached);
		expect(merge).toHaveBeenCalled();
	});

	it("无缓存时也要走一遍合并（沿用已有 statsMap）", () => {
		const merge = vi.fn();
		const ctx = makeCtx({ cachedStats: null, mergeStatsIntoPlugins: merge });

		mergeStatsFromCache(ctx);

		expect(merge).toHaveBeenCalled();
	});
});

describe("snapshotInstalled：安装态快照与缓存失效", () => {
	const withPlugins = (plugins: unknown, over: Ctx = {}) =>
		makeCtx({ app: { plugins }, ...over });

	it("app.plugins 不存在时直接返回，不抛错", () => {
		const ctx = makeCtx({ app: {} });
		expect(() => snapshotInstalled(ctx)).not.toThrow();
	});

	it("记录已安装 id 与本地版本号（供可更新检测对比）", () => {
		const ctx = withPlugins({
			manifests: { a: { version: "1.2.3" }, b: { version: "2.0.0" } },
			enabledPlugins: new Set(["a"]),
		});

		snapshotInstalled(ctx);

		expect([...ctx.installedIds].sort()).toEqual(["a", "b"]);
		expect((ctx.installedVersions as Map<string, string>).get("a")).toBe("1.2.3");
	});

	it("enabledPlugins 为 Set 时以它为准", () => {
		const ctx = withPlugins({ manifests: { a: {} }, enabledPlugins: new Set(["a"]) });
		snapshotInstalled(ctx);
		expect([...ctx.enabledIds]).toEqual(["a"]);
	});

	it("enabledPlugins 缺失时保留原有启用集合（不误清空）", () => {
		const ctx = withPlugins({ manifests: { a: {} } }, { enabledIds: new Set(["old"]) });
		snapshotInstalled(ctx);
		expect([...ctx.enabledIds]).toEqual(["old"]);
	});

	it("当前筛选为「仅已安装」且集合变化时，必须重置前缀缓存", () => {
		const reset = vi.fn();
		const ctx = withPlugins(
			{ manifests: { a: {}, b: {} }, enabledPlugins: new Set() },
			{ installFilter: "installed", installedIds: new Set(["a"]), filterCache: { reset } },
		);

		snapshotInstalled(ctx);

		expect(reset).toHaveBeenCalled();
	});

	it("当前筛选为「全部」时集合变化不重置缓存（缓存仍正确）", () => {
		const reset = vi.fn();
		const ctx = withPlugins(
			{ manifests: { a: {}, b: {} }, enabledPlugins: new Set() },
			{ installFilter: "all", installedIds: new Set(["a"]), filterCache: { reset } },
		);

		snapshotInstalled(ctx);

		expect(reset).not.toHaveBeenCalled();
	});

	it("启用状态变化影响「仅已启动」筛选时重置缓存", () => {
		const reset = vi.fn();
		const ctx = withPlugins(
			{ manifests: { a: {} }, enabledPlugins: new Set(["a"]) },
			{ installFilter: "enabled", enabledIds: new Set(), filterCache: { reset } },
		);

		snapshotInstalled(ctx);

		expect(reset).toHaveBeenCalled();
	});

	it("读取内部结构抛错时只记日志，不影响列表渲染", () => {
		const badApp = {
			get plugins(): never {
				throw new Error("内部结构异常");
			},
		};
		const ctx = makeCtx({ app: badApp });
		expect(() => snapshotInstalled(ctx)).not.toThrow();
	});
});

describe("buildSearchIndex：全量与增量", () => {
	it("全量重建：每个插件一条 blob", () => {
		const ctx = makeCtx({ plugins: [plugin("a"), plugin("b")] });

		buildSearchIndex(ctx);

		expect((ctx.searchIndex as Map<string, string>).size).toBe(2);
	});

	it("增量模式只更新给定 id，不动其它条目", () => {
		const ctx = makeCtx({ plugins: [plugin("a"), plugin("b")] });
		buildSearchIndex(ctx);
		const index = ctx.searchIndex as Map<string, string>;
		const before = index.get("b");

		buildSearchIndex(ctx, new Set(["a"]));

		expect(index.get("b")).toBe(before);
		expect(index.size).toBe(2);
	});

	it("增量里包含不存在的 id 时安全忽略", () => {
		const ctx = makeCtx({ plugins: [plugin("a")] });
		expect(() => buildSearchIndex(ctx, new Set(["ghost"]))).not.toThrow();
		expect((ctx.searchIndex as Map<string, string>).size).toBe(0);
	});

	it("全量重建会先清空旧索引（避免已下架插件残留）", () => {
		const ctx = makeCtx({ plugins: [plugin("a")], searchIndex: new Map([["old", "x"]]) });

		buildSearchIndex(ctx);

		expect((ctx.searchIndex as Map<string, string>).has("old")).toBe(false);
	});
});

describe("buildAuthorFacet：作者分面只保留多产作者", () => {
	it("出现 ≥2 次的作者才进入分面", () => {
		const ctx = makeCtx({
			plugins: [
				plugin("a", { author: "多产" }),
				plugin("b", { author: "多产" }),
				plugin("c", { author: "独苗" }),
			],
		});

		buildAuthorFacet(ctx);

		// 分面按首字母分组：AuthorGroup[] = { letter, authors: string[] }[]
		const groups = ctx.authorFacetList as Array<{ authors: string[] }>;
		const names = groups.flatMap((g) => g.authors);
		expect(names).toContain("多产");
		expect(names).not.toContain("独苗");
	});

	it("空列表产出空分面", () => {
		const ctx = makeCtx({ plugins: [] });
		buildAuthorFacet(ctx);
		expect(ctx.authorFacetList).toEqual([]);
	});

	it("重建分面同样递增 pluginsRev（智能信号需重算）", () => {
		const ctx = makeCtx({ plugins: [plugin("a")] });
		const before = ctx.pluginsRev;
		buildAuthorFacet(ctx);
		expect(ctx.pluginsRev).toBe(before + 1);
	});
});

describe("relativeTime / updateRefreshTooltip：时间展示", () => {
	it("relativeTime 走统一的格式化函数（t 被注入，返回 i18n key）", () => {
		const ctx = makeCtx();
		// 注：它调用 formatRelativeTime(ts, Date.now(), ctx.t)，不经过 ctx.relativeTime
		expect(relativeTime(ctx, Date.now())).toContain("time.");
	});

	it("刷新按钮不存在时安全跳过", () => {
		const ctx = makeCtx({ refreshBtn: null });
		expect(() => updateRefreshTooltip(ctx)).not.toThrow();
	});

	it("从未拉取过时只显示基础文案", () => {
		const setAttribute = vi.fn();
		const ctx = makeCtx({ refreshBtn: { setAttribute }, lastListFetchAt: null });

		updateRefreshTooltip(ctx);

		expect(setAttribute).toHaveBeenCalledWith("title", "action.refresh");
	});

	it("有拉取时间时附带相对时间", () => {
		const setAttribute = vi.fn();
		const ctx = makeCtx({ refreshBtn: { setAttribute }, lastListFetchAt: 1000, relativeTime: () => "3 分钟前" });

		updateRefreshTooltip(ctx);

		expect(String(setAttribute.mock.calls[0][1])).toContain("3 分钟前");
	});
});

describe("applySearchInput：输入框 → 查询状态", () => {
	const withInput = (value: string, over: Ctx = {}) => {
		const contentEl = document.createElement("div");
		const input = document.createElement("input");
		input.className = "pt-search-input";
		input.value = value;
		const clearBtn = document.createElement("button");
		clearBtn.className = "pt-search-clear";
		contentEl.append(input, clearBtn);
		const ctx = makeCtx({ contentEl, ...over });
		return { ctx, input, clearBtn };
	};

	it("没有输入框时直接返回，不污染查询状态", () => {
		const ctx = makeCtx({ contentEl: document.createElement("div"), searchQuery: "原值" });
		expect(() => applySearchInput(ctx)).not.toThrow();
		expect(ctx.searchQuery).toBe("原值");
	});

	it("空输入回到全量列表：清空 AI 结果并重渲染，不触发数据加载", () => {
		const scheduleRender = vi.fn();
		const ensureDataLoaded = vi.fn(async () => true);
		const { ctx } = withInput("   ", {
			scheduleRender,
			ensureDataLoaded,
			aiSearchResult: { hits: [1] },
			aiSearchQueryCache: "旧",
		});

		applySearchInput(ctx);

		expect(ctx.searchQuery).toBe("");
		expect(ctx.aiSearchResult).toBeNull();
		expect(ctx.aiSearchQueryCache).toBe("");
		expect(scheduleRender).toHaveBeenCalled();
		expect(ensureDataLoaded).not.toHaveBeenCalled();
	});

	it("查询词统一去空格转小写（避免大小写导致缓存穿透）", () => {
		const { ctx } = withInput("  DataView  ", {
			ensureDataLoaded: vi.fn(async () => true),
			scheduleRender: vi.fn(),
		});

		applySearchInput(ctx);

		expect(ctx.searchQuery).toBe("dataview");
	});

	it("非 AI 模式：先加载数据，成功后再渲染", async () => {
		const order: string[] = [];
		const { ctx } = withInput("x", {
			searchMode: "keyword",
			ensureDataLoaded: vi.fn(async () => {
				order.push("load");
				return true;
			}),
			scheduleRender: vi.fn(() => order.push("render")),
			aiSearchResult: { hits: [1] },
		});

		applySearchInput(ctx);
		// ensureDataLoaded().then(...) 需要跨过一个宏任务才执行
		await new Promise((r) => window.setTimeout(r, 0));

		expect(ctx.aiSearchResult).toBeNull();
		expect(order).toEqual(["load", "render"]);
	});

	it("AI 模式：输入变化使旧结果失效，仅提示按 Enter 检索", () => {
		const ensureDataLoaded = vi.fn(async () => true);
		const showAIPendingHint = vi.fn();
		const { ctx } = withInput("语义查询", {
			searchMode: "ai",
			ensureDataLoaded,
			showAIPendingHint,
			aiSearchResult: { hits: [1] },
		});
		// 模拟此前已有不同搜索词，本次输入与之不同 → 旧结果应失效（#77 修复：避免旧结果误显示）
		ctx.searchQuery = "旧查询";

		applySearchInput(ctx);

		expect(showAIPendingHint).toHaveBeenCalled();
		expect(ensureDataLoaded).not.toHaveBeenCalled();
		expect(ctx.aiSearchResult).toBeNull();
	});

	it("清除按钮可见性跟随内容（有值显示、无值隐藏）", () => {
		const { ctx, clearBtn } = withInput("a", { ensureDataLoaded: vi.fn(async () => true) });
		applySearchInput(ctx);
		expect(clearBtn.style.display).toBe("");

		const empty = withInput("", { scheduleRender: vi.fn() });
		applySearchInput(empty.ctx);
		expect(empty.clearBtn.style.display).toBe("none");
	});

	it("数据加载失败只记日志，不向输入路径抛错", async () => {
		const { ctx } = withInput("x", {
			searchMode: "keyword",
			ensureDataLoaded: vi.fn(async () => {
				throw new Error("load failed");
			}),
			scheduleRender: vi.fn(),
		});

		expect(() => applySearchInput(ctx)).not.toThrow();
		await Promise.resolve();
	});
});

describe("updateAiTranslateButton：按钮四态", () => {
	const makeBtn = () => {
		const btn = document.createElement("button");
		btn.disabled = false;
		return btn;
	};

	it("按钮不存在时安全返回", () => {
		const ctx = makeCtx({ aiTranslateBtnEl: null });
		expect(() => updateAiTranslateButton(ctx)).not.toThrow();
	});

	it("有待翻译项时高亮并显示数量", () => {
		const btn = makeBtn();
		const ctx = makeCtx({
			aiTranslateBtnEl: btn,
			visibleList: [plugin("a"), plugin("b")],
			isTranslated: (p: TestPlugin) => p.id === "a",
			sourceFilter: "online",
			settings: {},
		});

		updateAiTranslateButton(ctx);

		expect(btn.classList.contains("pt-ai-icon-btn--ready")).toBe(true);
		expect(String(btn.title)).toContain("ai.translate.hint");
		expect(btn.disabled).toBe(false);
	});

	it("全部已翻译时置灰禁用（按钮常驻避免定位困扰）", () => {
		const btn = makeBtn();
		const ctx = makeCtx({
			aiTranslateBtnEl: btn,
			visibleList: [plugin("a")],
			isTranslated: () => true,
			sourceFilter: "online",
			settings: {},
		});

		updateAiTranslateButton(ctx);

		expect(btn.disabled).toBe(true);
		expect(btn.title).toBe("ai.translate.none");
	});

	it("「未翻译」筛选态下作为重跑入口：运行中禁用", () => {
		const btn = makeBtn();
		const ctx = makeCtx({
			aiTranslateBtnEl: btn,
			visibleList: [],
			isTranslated: () => false,
			sourceFilter: "original",
			aiTranslateRunning: true,
			settings: {},
		});

		updateAiTranslateButton(ctx);

		expect(btn.disabled).toBe(true);
		expect(btn.title).toBe("ai.translate.running");
	});

	it("「未翻译」筛选态 + 有 AI Key → 提示重跑", () => {
		const btn = makeBtn();
		const ctx = makeCtx({
			aiTranslateBtnEl: btn,
			visibleList: [],
			isTranslated: () => false,
			sourceFilter: "original",
			settings: { aiSearchEnabled: true, aiSearchApiKey: "sk-1" },
		});

		updateAiTranslateButton(ctx);

		expect(btn.disabled).toBe(false);
		expect(btn.title).toBe("ai.translate.rerun");
	});

	it("「未翻译」筛选态 + 无 Key → 提示降级到免费引擎（仍可点）", () => {
		const btn = makeBtn();
		const ctx = makeCtx({
			aiTranslateBtnEl: btn,
			visibleList: [],
			isTranslated: () => false,
			sourceFilter: "original",
			settings: { aiSearchEnabled: false, aiSearchApiKey: "" },
		});

		updateAiTranslateButton(ctx);

		expect(btn.disabled).toBe(false);
		expect(btn.title).toBe("ai.translate.free");
	});
});

describe("toggleAuthorFilter：作者筛选开关", () => {
	it("点新作者即选中，并联动分面与重渲染", () => {
		const renderAuthorFacetFn = vi.fn();
		const updateFacetVisibility = vi.fn();
		const scheduleRender = vi.fn();
		const ctx = makeCtx({
			authorFilter: null,
			renderAuthorFacet: renderAuthorFacetFn,
			updateFacetVisibility,
			scheduleRender,
		});

		toggleAuthorFilter(ctx, "张三");

		expect(ctx.authorFilter).toBe("张三");
		expect(renderAuthorFacetFn).toHaveBeenCalled();
		expect(updateFacetVisibility).toHaveBeenCalled();
		expect(scheduleRender).toHaveBeenCalledWith(true);
	});

	it("再点同一作者即取消（toggle 语义）", () => {
		const ctx = makeCtx({
			authorFilter: "张三",
			renderAuthorFacet: vi.fn(),
			updateFacetVisibility: vi.fn(),
			scheduleRender: vi.fn(),
		});

		toggleAuthorFilter(ctx, "张三");

		expect(ctx.authorFilter).toBeNull();
	});
});

describe("renderAuthorFacet：字母索引与 chips", () => {
	const facetEl = () => document.createElement("div");

	it("容器不存在时安全返回", () => {
		const ctx = makeCtx({ authorFacetEl: null });
		expect(() => renderAuthorFacet(ctx)).not.toThrow();
	});

	it("没有作者时不出字母条（避免空占位）", () => {
		const el = facetEl();
		const ctx = makeCtx({ authorFacetEl: el, authorFacetList: [], activeAuthorLetter: null });
		renderAuthorFacet(ctx);
		expect(el.querySelector(".pt-facet-letter-strip")).toBeNull();
	});

	it("只为有作者的字母生成按钮，点击可切换选中字母", () => {
		const el = facetEl();
		const render = vi.fn();
		const ctx = makeCtx({
			authorFacetEl: el,
			authorFacetList: [{ letter: "Z", authors: ["张三"] }],
			activeAuthorLetter: null,
			renderAuthorFacet: render,
		});

		renderAuthorFacet(ctx);

		const btns = el.querySelectorAll(".pt-facet-letter-btn");
		expect(btns.length).toBe(1);
		expect(btns[0].textContent).toBe("Z");

		(btns[0] as HTMLElement).click();
		expect(ctx.activeAuthorLetter).toBe("Z");
		expect(render).toHaveBeenCalled();
	});

	it("选中字母时展开该组作者 chips", () => {
		const el = facetEl();
		const ctx = makeCtx({
			authorFacetEl: el,
			authorFacetList: [{ letter: "Z", authors: ["张三", "李四"] }],
			activeAuthorLetter: "Z",
			authorFilter: null,
			authorExpanded: false,
			toggleAuthorFilter: vi.fn(),
			renderAuthorFacet: vi.fn(),
		});

		renderAuthorFacet(ctx);

		const chips = el.querySelector(".pt-facet-chips");
		expect(chips).not.toBeNull();
		expect(chips!.textContent).toContain("张三");
	});
});

describe("ensureDataLoaded：加载决策与状态机", () => {
	beforeEach(() => {
		// 必须连 Date 一起接管：函数里有 `while (!cachedStats && Date.now() < deadline)`
		// 的等待循环，只 fake setTimeout 而 Date 走真实时间会让它空转 300ms 真实时间，
		// 甚至在某些配置下不退出。
		vi.useFakeTimers({
			toFake: ["setTimeout", "setInterval", "clearTimeout", "clearInterval", "requestAnimationFrame", "Date"],
		});
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	const makeLoadCtx = (over: Ctx = {}) => {
		const translator = {
			getData: () => ({ cache: {} }),
			tmApproved: {},
			recordCoverage: vi.fn(),
			mergeOffline: vi.fn(() => ({ results: {} })),
		};
		const ctx = makeCtx({
			dataLoaded: false,
			dataLoading: false,
			lastListFetchAt: 0,
			containerEl: document.createElement("div"),
			scrollCardLayer: null,
			manifest: { version: "1.0.0" },
			translator,
			plugin: {
				scheduleIndexRefresh: vi.fn(),
				tmApprovedReady: Promise.resolve(),
			},
			settings: { embeddingSource: "keyword" },
			fetchPlugins: vi.fn(async () => [plugin("a")]),
			savePluginListCache: vi.fn(async () => {}),
			buildAuthorFacet: vi.fn(),
			applyAIConfig: vi.fn(),
			saveTranslatorData: vi.fn(),
			reportNewPluginDelta: vi.fn(),
			showLoadingState: vi.fn(),
			loadStatsCache: vi.fn(async () => null),
			mergeStatsFromCache: vi.fn(),
			snapshotInstalled: vi.fn(),
			scheduleRender: vi.fn(),
			fetchStatsAndMerge: vi.fn(async () => {}),
			tryLoadCachedPluginList: vi.fn(async () => null),
			buildLocalIndex: vi.fn(async () => {}),
			warmupLocalEmbedding: vi.fn(),
			showSearchGuide: vi.fn(),
			buildSearchIndex: vi.fn(),
			renderAuthorFacet: vi.fn(),
			updateFacetVisibility: vi.fn(),
			updateRefreshTooltip: vi.fn(),
			...over,
		});
		return { ctx, translator };
	};

	/** 推进假时钟直到加载完成（幂等的“跑到底”辅助） */
	const finish = async (p: Promise<boolean>) => {
		await vi.advanceTimersByTimeAsync(2000);
		return p;
	};

	it("已加载且未过期：直接返回 true，不重复请求", async () => {
		const { ctx } = makeLoadCtx({ dataLoaded: true, lastListFetchAt: Date.now() });

		await expect(ensureDataLoaded(ctx)).resolves.toBe(true);
		expect(ctx.fetchPlugins).not.toHaveBeenCalled();
	});

	it("已加载但超过 TTL：重新拉取（让用户看到新上架）", async () => {
		const { ctx } = makeLoadCtx({ dataLoaded: true, lastListFetchAt: Date.now() - 365 * 24 * 3600 * 1000 });

		const p = ensureDataLoaded(ctx);
		await expect(finish(p)).resolves.toBe(true);
		expect(ctx.fetchPlugins).toHaveBeenCalled();
	});

	it("正在加载中：等待既有加载完成，不重复发起", async () => {
		const { ctx } = makeLoadCtx({ dataLoading: true });
		// 模拟另一条加载流程在稍后完成
		window.setTimeout(() => {
			ctx.dataLoaded = true;
			ctx.dataLoading = false;
		}, 100);

		await expect(finish(ensureDataLoaded(ctx))).resolves.toBe(true);
		expect(ctx.fetchPlugins).not.toHaveBeenCalled();
	});

	it("成功路径：写入列表、构建索引、标记已加载并调度渲染", async () => {
		const { ctx } = makeLoadCtx();

		await expect(finish(ensureDataLoaded(ctx))).resolves.toBe(true);

		expect((ctx.plugins as unknown[]).length).toBe(1);
		expect(ctx.dataLoaded).toBe(true);
		expect(ctx.buildSearchIndex).toHaveBeenCalled();
		expect(ctx.scheduleRender).toHaveBeenCalled();
		expect(ctx.snapshotInstalled).toHaveBeenCalled();
	});

	it("成功路径：把列表缓存到本地（离线重启秒开）", async () => {
		const { ctx } = makeLoadCtx();
		await finish(ensureDataLoaded(ctx));
		expect(ctx.savePluginListCache).toHaveBeenCalled();
	});

	it("显式选择本地语义时才预建索引并预热模型（不打扰默认用户）", async () => {
		const { ctx } = makeLoadCtx({ settings: { embeddingSource: "local" } });

		await finish(ensureDataLoaded(ctx));

		expect(ctx.buildLocalIndex).toHaveBeenCalled();
		expect(ctx.warmupLocalEmbedding).toHaveBeenCalled();
	});

	it("默认关键词模式不预建索引（避免给用户强塞大模型）", async () => {
		const { ctx } = makeLoadCtx({ settings: { embeddingSource: "keyword" } });

		await finish(ensureDataLoaded(ctx));

		expect(ctx.buildLocalIndex).not.toHaveBeenCalled();
		expect(ctx.warmupLocalEmbedding).not.toHaveBeenCalled();
	});

	it("网络失败但有本地缓存：恢复列表并提示当前为缓存", async () => {
		const cached = [plugin("cached")];
		const { ctx } = makeLoadCtx({
			fetchPlugins: vi.fn(async () => {
				throw new Error("network down");
			}),
			tryLoadCachedPluginList: vi.fn(async () => cached),
		});

		await expect(finish(ensureDataLoaded(ctx))).resolves.toBe(true);

		expect((ctx.plugins as unknown[]).length).toBe(1);
		expect(ctx.dataLoaded).toBe(true);
		expect(ctx.scheduleRender).toHaveBeenCalled();
	});

	it("网络失败且无缓存：渲染错误态并返回 false", async () => {
		const layer = document.createElement("div");
		const { ctx } = makeLoadCtx({
			fetchPlugins: vi.fn(async () => {
				throw new Error("network down");
			}),
			tryLoadCachedPluginList: vi.fn(async () => null),
			scrollCardLayer: layer,
			cardById: new Map(),
			windowStart: 0,
			windowEnd: 0,
		});

		await expect(finish(ensureDataLoaded(ctx))).resolves.toBe(false);

		expect(layer.querySelector(".pt-error")).not.toBeNull();
		expect(ctx.dataLoaded).toBe(false);
	});

	it("无缓存的错误态提供「重试」与「回到搜索」两个明确出口", async () => {
		const layer = document.createElement("div");
		const { ctx } = makeLoadCtx({
			fetchPlugins: vi.fn(async () => {
				throw new Error("network down");
			}),
			tryLoadCachedPluginList: vi.fn(async () => null),
			scrollCardLayer: layer,
			cardById: new Map(),
			windowStart: 0,
			windowEnd: 0,
		});

		await finish(ensureDataLoaded(ctx));

		expect(layer.querySelector(".pt-error-retry")).not.toBeNull();
		expect(layer.querySelector(".pt-error-guide")).not.toBeNull();
	});

	it("点击「回到搜索」重置加载锁并展示搜索引导", async () => {
		const layer = document.createElement("div");
		const { ctx } = makeLoadCtx({
			fetchPlugins: vi.fn(async () => {
				throw new Error("network down");
			}),
			tryLoadCachedPluginList: vi.fn(async () => null),
			scrollCardLayer: layer,
			cardById: new Map(),
			windowStart: 0,
			windowEnd: 0,
		});

		await finish(ensureDataLoaded(ctx));
		(layer.querySelector(".pt-error-guide") as HTMLElement).click();

		expect(ctx.dataLoaded).toBe(false);
		expect(ctx.dataLoading).toBe(false);
		expect(ctx.showSearchGuide).toHaveBeenCalled();
	});

	it("无论如何结束都会复位 dataLoading（避免锁死后续加载）", async () => {
		const { ctx } = makeLoadCtx({
			fetchPlugins: vi.fn(async () => {
				throw new Error("boom");
			}),
		});

		await finish(ensureDataLoaded(ctx));

		expect(ctx.dataLoading).toBe(false);
	});

	it("stats 缓存缺失时会主动补拉一次（首屏下载量不空白）", async () => {
		const loadStatsCache = vi.fn(async () => new Map([["a", { downloads: 1 }]]));
		const { ctx } = makeLoadCtx({ loadStatsCache });

		await finish(ensureDataLoaded(ctx));

		expect(loadStatsCache).toHaveBeenCalled();
		expect(ctx.mergeStatsFromCache).toHaveBeenCalled();
		});

		// ─────────────────────────────────────────────────────────────
		// 融合 PR #77 的「双语 BM25 预热」搜索回归（scheduleBm25Warmup /
		// disposeViewDataCache / buildSearchIndex 的预热共享索引与卸载取消）。
		// 生产实现由 #77 在 view-data.ts 引入，本块仅补充回归断言。
		// ─────────────────────────────────────────────────────────────
		describe("双语 BM25 预热", () => {
		beforeEach(() => { vi.useFakeTimers(); });
		afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });
		function setup() {
			const config = { baseURL: "http://localhost", apiKey: "", model: "mock", embedding: { source: "keyword" as const } };
			const searcher = new AISearcher(config, new LLMClient(config), new PluginTagService());
			const translator = { aiSearcher: searcher, cache: { a: { source: "custom" as const, translatedName: "日历", translatedDesc: "管理每日笔记" } } } as unknown as Translator;
			const ctx = makeMockContext({ translator, plugins: [{ id: "a", name: "Calendar", description: "Daily notes", author: "x" }], searchIndex: new Map() });
			return { ctx, searcher };
		}

		it("译文合并后的预热与第一次本地搜索共享同一个索引", async () => {
			const { ctx, searcher } = setup();
			ctx.translatedResults = {};
			const build = vi.spyOn(searcher, "getBm25Index");
			buildSearchIndex(ctx);
			vi.advanceTimersByTime(60);
			const warmed = build.mock.results[0].value;
			const args = prepareSearchPlugins(ctx.plugins, ctx.translator.cache);
			const result = await searcher.localSearch("日历", args);
			expect(result.rankedIds).toContain("a");
			expect(searcher.getBm25Index(args)).toBe(warmed);
		});

		it("合并多次预热，只使用执行时的最新译文；卸载取消任务", () => {
			const { ctx, searcher } = setup();
			const build = vi.spyOn(searcher, "getBm25Index");
			scheduleBm25Warmup(ctx);
			ctx.translator.cache.a.translatedName = "最新日历";
			scheduleBm25Warmup(ctx);
			vi.advanceTimersByTime(60);
			expect(build).toHaveBeenCalledTimes(1);
			expect(build.mock.calls[0][0][0]).toMatchObject({ nameZh: "最新日历" });
			scheduleBm25Warmup(ctx);
			disposeViewDataCache(ctx);
			vi.advanceTimersByTime(60);
			expect(build).toHaveBeenCalledTimes(1);
		});
		});
});

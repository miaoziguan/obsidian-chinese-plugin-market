import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "./view-context";
import {
	showSearchGuide,
	showAIPendingHint,
	showAIConfigGuide,
	showLoadingState,
	updateStats,
	applyAIConfig,
	updateGuidance,
	updateFacetVisibility,
	renderActiveFilters,
	announceStatus,
	updateScrollButtons,
	updateScrollPosBadge,
	loadAndRender,
} from "./view-chrome";
import { setListState } from "@ui/dom/list-state";
import { alignFacetLabels, buildToolbar } from "@ui/view/view-toolbar";
import { clearOneFilter } from "@ui/view/active-filters";
import { isMobileEnvironment, isTouchEnvironment } from "@shared/platform";

/**
 * 顶部 chrome 与列表区骨架：view-chrome.ts（536 行，此前仅 12.5% 覆盖）。
 *
 * 这是当时 ui 层**最大的单块未覆盖缺口（469 条语句）**：整块「搜索引导 / AI 等待 /
 * AI 配置引导 / 加载态」空态体系，以及 loadAndRender 搭的整个视图骨架（滚动视口、
 * 卡片层、四个页签列表容器、回到顶部 / 一键置底 / 位置徽标）。
 * 错误模式是「界面说谎」：收藏筛选残留、筛选 chips 不显示导致「列表莫名变少却无提示」、
 * 或滚动按钮可见性判错。不抛错，只让用户困惑。
 *
 * mock 边界：setListState / activeFilters / clearOneFilter / buildToolbar /
 * alignFacetLabels 用可控 mock——本轮验证的是 chrome 层「渲染什么、怎么响应」，
 * 不重复测筛选维度清单与工具栏实现（那些另有单测）。
 */

const chromeMock = vi.hoisted(() => ({
	filters: [] as Array<{ label: string }>,
	searchInput: null as HTMLInputElement | null,
}));

vi.mock("@ui/dom/list-state", () => ({ setListState: vi.fn() }));

vi.mock("@ui/view/active-filters", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ui/view/active-filters")>();
	return {
		...actual,
		activeFilters: vi.fn(() => chromeMock.filters),
		clearOneFilter: vi.fn(),
	};
});

vi.mock("@ui/view/view-toolbar", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ui/view/view-toolbar")>();
	return {
		...actual,
		buildToolbar: vi.fn(() => ({ searchInput: chromeMock.searchInput })),
		alignFacetLabels: vi.fn(),
	};
});

vi.mock("@shared/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@shared/platform")>();
	// 这两个要能被单用例改写（触摸设备判定），必须做成 vi.fn 而非普通箭头函数
	return { ...actual, isMobileEnvironment: vi.fn(() => false), isTouchEnvironment: vi.fn(() => false) };
});

// Obsidian 扩展方法：createDiv/createEl/createSpan 与 appendText 都挂在
// HTMLElement.prototype，共享 setup 没给全（尤其 appendText）。这里局部补齐。
type ElInfo = { cls?: string | string[]; text?: string; attr?: Record<string, string> } | string | undefined;
function applyElInfo(el: HTMLElement, o: ElInfo) {
	if (!o) return;
	if (typeof o === "string") {
		el.textContent = o;
		return;
	}
	if (o.cls) {
		const cls = Array.isArray(o.cls) ? o.cls : String(o.cls).split(/\s+/);
		cls.filter(Boolean).forEach((c) => el.classList.add(c));
	}
	if (o.text != null) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
}
if (!(HTMLElement.prototype as unknown as { createDiv?: unknown }).createDiv) {
	const proto = HTMLElement.prototype as unknown as {
		createDiv: (o?: ElInfo) => HTMLElement;
		createEl: (tag: string, o?: ElInfo) => HTMLElement;
		createSpan: (o?: ElInfo) => HTMLElement;
	};
	proto.createDiv = function (o) {
		const el = document.createElement("div");
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
	proto.createEl = function (tag, o) {
		const el = document.createElement(tag);
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
	proto.createSpan = function (o) {
		const el = document.createElement("span");
		applyElInfo(el, o);
		this.appendChild(el);
		return el;
	};
}
if (!(HTMLElement.prototype as unknown as { appendText?: unknown }).appendText) {
	(HTMLElement.prototype as unknown as { appendText: (t: string) => HTMLElement }).appendText = function (t: string) {
		this.appendChild(document.createTextNode(String(t)));
		return this;
	};
}

type Ctx = Record<string, unknown>;

const plugin = (id: string): PluginInfo => ({ id, name: `插件${id}`, description: "", author: "作者" } as PluginInfo);

function makeCtx(over: Ctx = {}): ViewContext {
	const contentEl = document.createElement("div");
	const containerEl = document.createElement("div");
	const scrollViewport = document.createElement("div");
	Object.defineProperty(scrollViewport, "clientHeight", { value: 600, configurable: true });
	Object.defineProperty(scrollViewport, "scrollHeight", { value: 3000, configurable: true });
	const ctx: Ctx = {
		contentEl,
		containerEl,
		scrollViewport,
		scrollCardLayer: document.createElement("div"),
		cardById: new Map<string, HTMLElement>(),
		guidanceEl: null,
		facetContainerEl: null,
		catRowEl: null,
		authorRowEl: null,
		authorFacetList: [] as Array<{ authors: string[] }>,
		searchMode: "keyword",
		searchQuery: "",
		sortBy: "relevance",
		sourceFilter: "all",
		favoriteFilter: "installed", // 故意非 all：验证会被重置
		plugins: [] as PluginInfo[],
		visibleList: [] as PluginInfo[],
		cachedScrollHeight: 3000,
		defaultRowH: 100,
		rowGap: 0,
		colCount: 3,
		scrollVelocity: 0,
		lastScrollTopSample: 0,
		lastScrollSampleAt: 0,
		measureRAF: 0,
		scrollRAF: 0,
		backTopBtn: null,
		scrollBottomBtn: null,
		scrollPosEl: null,
		scrollPosTimer: undefined,
		lastScrollPosText: "",
		settings: {
			sourceFilter: "all",
			aiSearchEnabled: false,
			aiSearchBaseURL: "",
			aiSearchApiKey: "",
			aiSearchModel: "",
			embeddingSource: "remote",
			embeddingBaseURL: "",
			embeddingApiKey: "",
			embeddingModel: "",
			embeddingLocalModel: "",
			embeddingLocalWasmPaths: {},
			embeddingRemoteHost: "",
		},
		translator: { setAIConfig: vi.fn() },
		app: { plugins: { manifests: {}, enabledPlugins: new Set() } } as never,
		manifest: { id: "chinese-plugin-market" },
		onCardClick: vi.fn(),
		onCardKeydown: vi.fn(),
		register: vi.fn(),
		t: (k: string) => k,
		updateGuidance: vi.fn(),
		applySearchInput: vi.fn(),
		runAISearch: vi.fn(),
		showLoadingState: vi.fn(),
		renderPluginList: vi.fn(),
		updateStats: vi.fn(),
		updateScrollButtons: vi.fn(),
		measureLayout: vi.fn(),
		updateWindow: vi.fn(),
		saveSettings: vi.fn(),
		ensureDataLoaded: vi.fn(async () => true),
		...over,
	};
	return ctx as unknown as ViewContext;
}

/** 在 contentEl 里放一个搜索框（并可选地给个 .pt-search 包裹层） */
function withSearchInput(ctx: ViewContext, wrap = true): HTMLInputElement {
	const input = document.createElement("input");
	input.className = "pt-search-input";
	if (wrap) {
		const box = document.createElement("div");
		box.className = "pt-search";
		box.appendChild(input);
		ctx.contentEl.appendChild(box);
	} else {
		ctx.contentEl.appendChild(input);
	}
	return input;
}

beforeEach(() => {
	document.body.innerHTML = "";
	chromeMock.filters = [];
	chromeMock.searchInput = document.createElement("input");
	vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "requestAnimationFrame", "cancelAnimationFrame"] });
	(window as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
		observe() {}
		disconnect() {}
		unobserve() {}
	};
	vi.mocked(setListState).mockClear();
	vi.mocked(alignFacetLabels).mockClear();
	vi.mocked(buildToolbar).mockClear();
	vi.mocked(clearOneFilter).mockClear();
	vi.mocked(isMobileEnvironment).mockReturnValue(false);
	vi.mocked(isTouchEnvironment).mockReturnValue(false);
});

afterEach(() => {
	vi.useRealTimers();
});

describe("空态体系：搜索引导 / AI 等待 / AI 配置 / 加载中", () => {
	it("搜索引导：置 guide 态、建引导行与示例词，清空卡片索引", () => {
		const ctx = makeCtx();
		showSearchGuide(ctx);
		expect(setListState).toHaveBeenCalledWith(ctx, "guide");
		expect(ctx.cardById.size).toBe(0);
		const layer = ctx.scrollCardLayer!;
		expect(layer.querySelector(".pt-search-guide")).not.toBeNull();
		expect(layer.querySelector(".pt-empty-title")!.textContent).toBe("guide.title");
		expect(layer.querySelector(".pt-guide-compare-hint")).not.toBeNull();
		// 引导行挂在列表区（供 updateGuidance 复用）
		expect(ctx.guidanceEl).not.toBeNull();
		expect(ctx.updateGuidance).toHaveBeenCalled();
		// 5 个示例词
		expect(layer.querySelectorAll(".pt-guide-chip").length).toBe(5);
	});

	it("点击搜索示例词 → 填入搜索框并立即触发搜索（跳过防抖）", async () => {
		const ctx = makeCtx();
		const input = withSearchInput(ctx);
		showSearchGuide(ctx);
		const chip = ctx.scrollCardLayer!.querySelector<HTMLElement>(".pt-guide-chip")!;
		chip.click();
		expect(input.value).toBe("思维导图");
		expect(ctx.applySearchInput).toHaveBeenCalled();
		// 闪光反馈：先加类，超时后移除
		expect(input.classList.contains("pt-search-flash")).toBe(true);
		await vi.advanceTimersByTimeAsync(2000);
		expect(input.classList.contains("pt-search-flash")).toBe(false);
	});

	it("无搜索框时点击示例词安全返回（不抛错）", () => {
		const ctx = makeCtx(); // 没有 .pt-search-input
		showSearchGuide(ctx);
		const chip = ctx.scrollCardLayer!.querySelector<HTMLElement>(".pt-guide-chip")!;
		expect(() => chip.click()).not.toThrow();
		expect(ctx.applySearchInput).not.toHaveBeenCalled();
	});

	it("AI 等待提示：置 aiPending 态并给出 AI 语义示例词", () => {
		const ctx = makeCtx();
		showAIPendingHint(ctx);
		expect(setListState).toHaveBeenCalledWith(ctx, "aiPending");
		const layer = ctx.scrollCardLayer!;
		expect(layer.querySelector(".pt-ai-pending")).not.toBeNull();
		expect(layer.querySelector(".pt-empty-title")!.textContent).toBe("ai.pending.title");
		expect(layer.querySelectorAll(".pt-guide-chip").length).toBe(4);
	});

	it("点击 AI 示例词 → 设置查询词、显示清除按钮并发起 AI 搜索", () => {
		const ctx = makeCtx();
		const input = withSearchInput(ctx);
		const badge = document.createElement("div");
		badge.className = "pt-ai-badge";
		const clearBtn = document.createElement("div");
		clearBtn.className = "pt-search-clear";
		ctx.contentEl.appendChild(badge);
		ctx.contentEl.appendChild(clearBtn);
		showAIPendingHint(ctx);
		const chip = ctx.scrollCardLayer!.querySelector<HTMLElement>(".pt-guide-chip")!;
		chip.click();
		expect(input.value).toBe("做思维导图的插件");
		expect(ctx.searchQuery).toBe("做思维导图的插件");
		expect(ctx.runAISearch).toHaveBeenCalledWith(input, badge);
		expect(clearBtn.style.display).toBe("");
	});

	it("AI 示例词缺少 badge → 不发起搜索（防半成品状态）", () => {
		const ctx = makeCtx();
		withSearchInput(ctx); // 只有 input，没有 .pt-ai-badge
		showAIPendingHint(ctx);
		const chip = ctx.scrollCardLayer!.querySelector<HTMLElement>(".pt-guide-chip")!;
		chip.click();
		expect(ctx.runAISearch).not.toHaveBeenCalled();
	});

	it("AI 配置引导：未开启与未配置 Key 两种文案", () => {
		const ctx = makeCtx();
		showAIConfigGuide(ctx, "disabled");
		const layer = ctx.scrollCardLayer!;
		expect(setListState).toHaveBeenCalledWith(ctx, "aiConfig");
		expect(layer.querySelector(".pt-ai-config-guide")).not.toBeNull();
		expect(layer.querySelector(".pt-empty-title")!.textContent).toBe("AI 语义搜索未开启");
		showAIConfigGuide(ctx, "noKey");
		expect(layer.querySelector(".pt-empty-title")!.textContent).toBe("未配置 API Key");
	});

	it("AI 配置引导的「打开设置」按钮：先开面板再切 tab", () => {
		const open = vi.fn();
		const openTabById = vi.fn();
		const ctx = makeCtx({ app: { setting: { open, openTabById } } as never });
		showAIConfigGuide(ctx, "noKey");
		const btn = ctx.scrollCardLayer!.querySelector<HTMLElement>(".pt-guide-chip")!;
		btn.click();
		expect(open).toHaveBeenCalled();
		expect(openTabById).toHaveBeenCalledWith("chinese-plugin-market");
	});

	it("加载态：置 loading 态并展示传入文案", () => {
		const ctx = makeCtx();
		showLoadingState(ctx, "正在拉取…");
		expect(setListState).toHaveBeenCalledWith(ctx, "loading");
		const layer = ctx.scrollCardLayer!;
		expect(layer.querySelector(".pt-loading")).not.toBeNull();
		expect(layer.querySelector(".pt-loading-spinner")).not.toBeNull();
		expect(layer.querySelector(".pt-empty-hint")!.textContent).toBe("正在拉取…");
	});

	it("没有卡片层时全部空态函数安全返回", () => {
		const ctx = makeCtx({ scrollCardLayer: undefined });
		expect(() => {
			showSearchGuide(ctx);
			showAIPendingHint(ctx);
			showAIConfigGuide(ctx, "noKey");
			showLoadingState(ctx, "x");
		}).not.toThrow();
	});
});

describe("统计与 AI 配置下发", () => {
	it("updateStats：显示计数并按插件总数渲染「共 N」", () => {
		const ctx = makeCtx({ plugins: [plugin("a"), plugin("b"), plugin("c")] });
		const stats = document.createElement("div");
		stats.className = "pt-stats";
		ctx.containerEl.appendChild(stats);
		updateStats(ctx);
		expect(stats.querySelector(".pt-stat")!.textContent).toBe("共 3");
		expect(stats.style.display).toBe("");
	});

	it("updateStats：无计数元素时不报错", () => {
		const ctx = makeCtx({ plugins: [plugin("a")] });
		expect(() => updateStats(ctx)).not.toThrow();
	});

	it("applyAIConfig：可用时下发完整 AI + 向量配置", () => {
		const ctx = makeCtx({
			settings: {
				aiSearchEnabled: true,
				aiSearchBaseURL: "https://api.example",
				aiSearchApiKey: "sk-1",
				aiSearchModel: "m1",
				embeddingSource: "local",
				embeddingBaseURL: "",
				embeddingApiKey: "",
				embeddingModel: "e1",
				embeddingLocalModel: "lm",
				embeddingLocalWasmPaths: {},
				embeddingRemoteHost: "",
			},
		});
		applyAIConfig(ctx);
		const arg = vi.mocked(ctx.translator.setAIConfig).mock.calls[0][0] as unknown as Record<string, unknown>;
		expect(arg).not.toBeNull();
		expect(arg.apiKey).toBe("sk-1");
		expect((arg.embedding as Record<string, unknown>).model).toBe("e1");
	});

	it("applyAIConfig：不可用时清空 AI 配置（null）", () => {
		const ctx = makeCtx(); // aiSearchEnabled false
		applyAIConfig(ctx);
		expect(ctx.translator.setAIConfig).toHaveBeenCalledWith(null);
	});
});

describe("引导行与筛选可见性", () => {
	it("updateGuidance：有查询时隐藏引导行", () => {
		const ctx = makeCtx({ searchQuery: "  foo " });
		ctx.guidanceEl = document.createElement("div");
		updateGuidance(ctx);
		expect(ctx.guidanceEl.style.display).toBe("none");
	});

	it("updateGuidance：无查询时按搜索模式显示对应引导文案", () => {
		const ctx = makeCtx({ searchMode: "ai" });
		ctx.guidanceEl = document.createElement("div");
		updateGuidance(ctx);
		expect(ctx.guidanceEl.textContent).toBe("mode.guidance.ai");
		expect(ctx.guidanceEl.style.display).toBe("");
	});

	it("updateGuidance：无引导行元素时直接返回", () => {
		const ctx = makeCtx({ guidanceEl: null });
		expect(() => updateGuidance(ctx)).not.toThrow();
	});

	it("updateFacetVisibility：AI/关键词模式显示分类行，有作者时显示作者行", async () => {
		const ctx = makeCtx({
			searchMode: "keyword",
			authorFacetList: [{ authors: ["张三"] }],
			facetContainerEl: document.createElement("div"),
			catRowEl: document.createElement("div"),
			authorRowEl: document.createElement("div"),
		});
		updateFacetVisibility(ctx);
		expect(ctx.facetContainerEl!.style.display).toBe("");
		expect(ctx.catRowEl!.style.display).toBe("");
		expect(ctx.authorRowEl!.style.display).toBe("");
		await vi.advanceTimersByTimeAsync(20);
		expect(alignFacetLabels).toHaveBeenCalled();
	});

	it("updateFacetVisibility：无作者分面时隐藏作者行", () => {
		const ctx = makeCtx({
			authorFacetList: [],
			facetContainerEl: document.createElement("div"),
			catRowEl: document.createElement("div"),
			authorRowEl: document.createElement("div"),
		});
		updateFacetVisibility(ctx);
		expect(ctx.authorRowEl!.style.display).toBe("none");
		expect(ctx.catRowEl!.style.display).toBe("");
	});

	it("updateFacetVisibility：有生效筛选时高亮重置按钮（一眼知道可以清空）", () => {
		const reset = document.createElement("div");
		reset.className = "pt-toolbar-reset--inline";
		const ctx = makeCtx();
		ctx.contentEl.appendChild(reset);
		chromeMock.filters = [{ label: "安装：已安装" }];
		updateFacetVisibility(ctx);
		expect(reset.classList.contains("is-active")).toBe(true);
		chromeMock.filters = [];
		updateFacetVisibility(ctx);
		expect(reset.classList.contains("is-active")).toBe(false);
	});
});

describe("活跃筛选 chips", () => {
	const headerCtx = () => {
		const ctx = makeCtx();
		const header = document.createElement("div");
		header.className = "pt-header";
		ctx.contentEl.appendChild(header);
		return ctx;
	};

	it("无 .pt-header 时直接返回", () => {
		const ctx = makeCtx();
		expect(() => renderActiveFilters(ctx)).not.toThrow();
	});

	it("没有生效筛选 → 隐藏 chips 容器", () => {
		const ctx = headerCtx();
		renderActiveFilters(ctx);
		const box = ctx.contentEl.querySelector<HTMLElement>(".pt-active-filters")!;
		expect(box.style.display).toBe("none");
	});

	it("有生效筛选 → 渲染 chips，并把「键：值」拆成两段", () => {
		const ctx = headerCtx();
		chromeMock.filters = [{ label: "翻译：从未翻译" }];
		renderActiveFilters(ctx);
		const box = ctx.contentEl.querySelector<HTMLElement>(".pt-active-filters")!;
		expect(box.style.display).toBe("");
		expect(box.querySelector(".pt-active-chip-key")!.textContent).toBe("翻译");
		expect(box.querySelector(".pt-active-chip-value")!.textContent).toBe("从未翻译");
	});

	it("无冒号分隔的筛选 → 只渲染值段", () => {
		const ctx = headerCtx();
		chromeMock.filters = [{ label: "仅已收藏" }];
		renderActiveFilters(ctx);
		const box = ctx.contentEl.querySelector<HTMLElement>(".pt-active-filters")!;
		expect(box.querySelector(".pt-active-chip-key")).toBeNull();
		expect(box.querySelector(".pt-active-chip-value")!.textContent).toBe("仅已收藏");
	});

	it("点击 chip 的 ✕ → 用单一入口 clearOneFilter 移除该维度", () => {
		const ctx = headerCtx();
		const f = { label: "来源：社区" };
		chromeMock.filters = [f];
		renderActiveFilters(ctx);
		const x = ctx.contentEl.querySelector<HTMLElement>(".pt-active-chip-clear")!;
		expect(x.textContent).toBe("×");
		x.click();
		expect(clearOneFilter).toHaveBeenCalledWith(ctx, f);
	});
});

describe("无障碍播报与滚动控件", () => {
	it("announceStatus：写入屏幕阅读器专用区域", () => {
		const ctx = makeCtx();
		const sr = document.createElement("div");
		sr.className = "pt-sr-only";
		ctx.containerEl.appendChild(sr);
		announceStatus(ctx, "找到 3 个");
		expect(sr.textContent).toBe("找到 3 个");
	});

	it("announceStatus：无播报区时不报错", () => {
		const ctx = makeCtx();
		expect(() => announceStatus(ctx, "x")).not.toThrow();
	});

	it("updateScrollButtons：超过 1.5 屏才显示「回到顶部」", () => {
		const ctx = makeCtx();
		const back = document.createElement("div");
		const bottom = document.createElement("div");
		ctx.backTopBtn = back as never;
		ctx.scrollBottomBtn = bottom as never;
		ctx.scrollViewport!.scrollTop = 100; // < 600*1.5
		updateScrollButtons(ctx);
		expect(back.classList.contains("pt-back-top--visible")).toBe(false);
		ctx.scrollViewport!.scrollTop = 1000; // > 900
		updateScrollButtons(ctx);
		expect(back.classList.contains("pt-back-top--visible")).toBe(true);
	});

	it("updateScrollButtons：未到底部时显示「一键置底」", () => {
		const ctx = makeCtx();
		const bottom = document.createElement("div");
		ctx.scrollBottomBtn = bottom as never;
		ctx.scrollViewport!.scrollTop = 0;
		updateScrollButtons(ctx);
		expect(bottom.classList.contains("pt-scroll-bottom--visible")).toBe(true);
		ctx.scrollViewport!.scrollTop = 2400; // 2400+600 >= 3000-4
		updateScrollButtons(ctx);
		expect(bottom.classList.contains("pt-scroll-bottom--visible")).toBe(false);
	});

	it("updateScrollButtons：无视口时直接返回", () => {
		const ctx = makeCtx({ scrollViewport: undefined });
		expect(() => updateScrollButtons(ctx)).not.toThrow();
	});

	it("updateScrollPosBadge：≤60 项不显示（短列表无需位置感）", () => {
		const ctx = makeCtx({ visibleList: [plugin("a")] });
		const el = document.createElement("div");
		ctx.scrollPosEl = el as never;
		updateScrollPosBadge(ctx);
		expect(el.classList.contains("pt-scroll-pos--visible")).toBe(false);
	});

	it("updateScrollPosBadge：长列表显示「第 x / 共 n」，滚停 800ms 淡出", async () => {
		const ctx = makeCtx({ visibleList: Array.from({ length: 100 }, (_, i) => plugin(`p${i}`)) });
		const el = document.createElement("div");
		ctx.scrollPosEl = el as never;
		ctx.scrollViewport!.scrollTop = 200; // row = 200/100 = 2 → 2*3+1 = 7
		updateScrollPosBadge(ctx);
		expect(el.classList.contains("pt-scroll-pos--visible")).toBe(true);
		expect(el.textContent).toBe("7 / 100");
		await vi.advanceTimersByTimeAsync(900);
		expect(el.classList.contains("pt-scroll-pos--visible")).toBe(false);
		expect(ctx.scrollPosTimer).toBeUndefined();
	});

	it("updateScrollPosBadge：文本未变时不重写 textContent（避免高频滚动无谓 DOM 写）", () => {
		const ctx = makeCtx({ visibleList: Array.from({ length: 100 }, (_, i) => plugin(`p${i}`)) });
		const el = document.createElement("div");
		ctx.scrollPosEl = el as never;
		ctx.scrollViewport!.scrollTop = 200;
		updateScrollPosBadge(ctx);
		el.appendChild(document.createElement("span")); // 若重写 textContent 会把它冲掉
		updateScrollPosBadge(ctx);
		expect(el.querySelector("span")).not.toBeNull();
	});
});

describe("loadAndRender：视图骨架与首屏", () => {
	const runLoad = async (ctx: ViewContext) => {
		await loadAndRender(ctx);
		await vi.advanceTimersByTimeAsync(0);
		await Promise.resolve();
	};

	it("搭出骨架：滚动视口 + 卡片层（role=list）+ 四个页签列表容器 + 三个浮动控件", async () => {
		const ctx = makeCtx();
		await runLoad(ctx);
		expect(ctx.contentEl.classList.contains("pt-view")).toBe(true);
		const vp = ctx.contentEl.querySelector(".pt-list.pt-list-viewport");
		expect(vp).not.toBeNull();
		const cardLayer = vp!.querySelector(".pt-list-layer")!;
		expect(cardLayer.getAttribute("role")).toBe("list");
		// 四个页签列表默认隐藏
		for (const cls of [".pt-updates-list", ".pt-beta-list", ".pt-css-list", ".pt-fav-list"]) {
			const el = ctx.contentEl.querySelector<HTMLElement>(cls)!;
			expect(el).not.toBeNull();
			expect(el.style.display).toBe("none");
		}
		expect(ctx.contentEl.querySelector(".pt-back-top")).not.toBeNull();
		expect(ctx.contentEl.querySelector(".pt-scroll-bottom")).not.toBeNull();
		expect(ctx.contentEl.querySelector(".pt-scroll-pos")).not.toBeNull();
		// ARIA 播报区
		const sr = ctx.contentEl.querySelector(".pt-sr-only")!;
		expect(sr.getAttribute("aria-live")).toBe("polite");
		expect(sr.getAttribute("role")).toBe("status");
	});

	it("触摸设备（平板 Platform.isMobile=false）也加 pt-mobile 类，消除响应式盲区", async () => {
		vi.mocked(isTouchEnvironment).mockReturnValue(true);
		const ctx = makeCtx();
		await runLoad(ctx);
		expect(ctx.contentEl.classList.contains("pt-mobile")).toBe(true);
		vi.mocked(isTouchEnvironment).mockReturnValue(false);
	});

	it("非触摸桌面端不加 pt-mobile", async () => {
		const ctx = makeCtx();
		await runLoad(ctx);
		expect(ctx.contentEl.classList.contains("pt-mobile")).toBe(false);
	});

	it("恢复持久化的来源筛选，但收藏筛选重置为「全部」（会话级，避免残留误以为默认）", async () => {
		const ctx = makeCtx({
			settings: { sourceFilter: "community" },
			favoriteFilter: "favorited",
			ensureDataLoaded: vi.fn(async () => false),
		});
		await runLoad(ctx);
		expect(ctx.sourceFilter).toBe("community");
		expect(ctx.favoriteFilter).toBe("all");
	});

	it("数据加载成功 → 渲染列表 + 刷新统计 + 同步滚动按钮", async () => {
		const ctx = makeCtx();
		await runLoad(ctx);
		expect(ctx.showLoadingState).toHaveBeenCalled(); // 首屏先给加载反馈
		expect(ctx.renderPluginList).toHaveBeenCalled();
		expect(ctx.updateStats).toHaveBeenCalled();
		expect(ctx.updateScrollButtons).toHaveBeenCalled();
	});

	it("首屏 keyword + relevance → 改为按下载量排序并保存偏好", async () => {
		const ctx = makeCtx({ searchMode: "keyword", sortBy: "relevance" });
		await runLoad(ctx);
		expect(ctx.sortBy).toBe("downloads");
		expect(ctx.settings.sortBy).toBe("downloads");
		expect(ctx.saveSettings).toHaveBeenCalled();
	});

	it("数据加载失败 → 不渲染列表（保留加载态，不误报空）", async () => {
		const ctx = makeCtx({ ensureDataLoaded: vi.fn(async () => false) });
		await runLoad(ctx);
		expect(ctx.renderPluginList).not.toHaveBeenCalled();
		expect(ctx.updateStats).not.toHaveBeenCalled();
	});

	it("「/」快捷键聚焦搜索框；在输入框内按 / 不拦截", async () => {
		const ctx = makeCtx();
		const input = chromeMock.searchInput!;
		document.body.appendChild(input);
		const focusSpy = vi.spyOn(input, "focus");
		await runLoad(ctx);
		// 在容器上按 /（非输入元素）
		const ev = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
		ctx.contentEl.dispatchEvent(ev);
		expect(focusSpy).toHaveBeenCalled();
		expect(ev.defaultPrevented).toBe(true);
		// 在输入框内按 / 应放行
		focusSpy.mockClear();
		const inInput = new KeyboardEvent("keydown", { key: "/", bubbles: true, cancelable: true });
		Object.defineProperty(inInput, "target", { value: document.createElement("input") });
		ctx.contentEl.dispatchEvent(inInput);
		expect(focusSpy).not.toHaveBeenCalled();
		expect(inInput.defaultPrevented).toBe(false);
	});
});

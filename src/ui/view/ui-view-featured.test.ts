import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderFeaturedSection, ensureFeaturedSection, hideFeaturedSection } from "@ui/view/view-featured";
import { createPluginCard } from "@ui/components/card-render";

/**
 * 补 ui/view/view-featured.ts（此前 15.1%，行 36-205 三导出函数 + 内部 computeFeaturedIds）。
 * 以伪造 ViewContext 驱动：推荐引擎 computeFeaturedIdsPure 走真实纯逻辑；卡片用 @ui/components/card-render
 * 的桩（真实卡片渲染在 jsdom 下易碎且不属本文件目标）。本环境下 obsidian 的 HTMLElement 扩展未加载，
 * 故用实例级 helper 给伪造元素补齐 createDiv/createEl/createSpan/setCssStyles/setText/classList 等。
 *
 * 错误模式「落地页官方推荐区在筛选/搜索/对比态下未隐藏而泄漏到其它页签」「内容签名缓存未命中导致
 * 高频重渲染卡顿」「推荐卡片电源键切换启用态无效」「折叠态未同步显隐」。
 *
 * 本文件自包含，不依赖插件实例；本轮绝不碰已有测试文件。
 */

vi.mock("@ui/components/card-render", () => ({
	createPluginCard: vi.fn(() => document.createElement("div")),
}));

function withHelpers(el: HTMLElement) {
	const n = el as unknown as Record<string, unknown>;
	const add = (child: HTMLElement) => withHelpers(child);
	n.empty = function (this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild);
		return this;
	};
	n.createDiv = function (this: HTMLElement, opts: { cls?: string; text?: string } = {}) {
		const e = document.createElement("div");
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		this.appendChild(e);
		return add(e);
	};
	n.createSpan = function (
		this: HTMLElement,
		opts: { cls?: string; text?: string; attr?: Record<string, string> } = {}
	) {
		const e = document.createElement("span");
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		if (opts.attr) for (const k of Object.keys(opts.attr)) e.setAttribute(k, opts.attr[k]);
		this.appendChild(e);
		return add(e);
	};
	n.createEl = function (
		this: HTMLElement,
		tag: string,
		opts: { cls?: string; text?: string; title?: string } = {}
	) {
		const e = document.createElement(tag);
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		if (opts.title) e.title = opts.title;
		this.appendChild(e);
		return add(e);
	};
	n.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		for (const k of Object.keys(styles)) this.style.setProperty(k, styles[k]);
		return this;
	};
	n.setText = function (this: HTMLElement, t: string) {
		this.textContent = t;
		return this;
	};
	n.addClass = function (this: HTMLElement, cls: string) {
		this.classList.add(cls);
		return this;
	};
	return el;
}

function makeCtx(over: Record<string, unknown> = {}) {
	const containerEl = withHelpers(document.createElement("div"));
	const contentEl = withHelpers(document.createElement("div"));
	const scrollViewport = withHelpers(document.createElement("div"));
	contentEl.appendChild(scrollViewport);
	const ctx: any = {
		containerEl,
		contentEl,
		scrollViewport,
		viewTab: "browse",
		advancedOpen: false,
		searchQuery: "",
		authorFilter: null,
		recommendedOnly: false,
		compareMode: false,
		searchMode: "keyword",
		installFilter: "all",
		featuredSectionEl: null,
		featuredGridEl: null,
		featuredCollapsed: false,
		recommendedTitle: undefined,
		plugins: [{ id: "a", name: "A", description: "da" }],
		translatedResults: {},
		settings: {},
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		aiSearchResult: null,
		compareSet: new Set<string>(),
		favoritesSet: new Set<string>(),
		smartSignals: undefined,
		translator: { tagService: null, persistSystemTranslation: vi.fn(), saveTranslatorData: vi.fn() },
		getRecommendedIds: vi.fn(() => new Set(["a"])),
		onCardClick: vi.fn(),
		t: vi.fn((k: string) => k),
		hideFeaturedSection: vi.fn((..._a: unknown[]) => hideFeaturedSection(ctx as never)),
		ensureFeaturedSection: vi.fn((..._a: unknown[]) => ensureFeaturedSection(ctx as never)),
		handleToggleEnabled: vi.fn(),
		...over,
	};
	return ctx;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("hideFeaturedSection（view-featured.ts 188-192）", () => {
	it("有 section → 隐藏（display:none）（190）", () => {
		const ctx = makeCtx();
		ctx.featuredSectionEl = withHelpers(document.createElement("div"));
		hideFeaturedSection(ctx);
		expect((ctx.featuredSectionEl as HTMLElement).style.display).toBe("none");
	});
	it("无 section → 不抛错（189-190）", () => {
		const ctx = makeCtx();
		expect(() => hideFeaturedSection(ctx)).not.toThrow();
	});
});

describe("ensureFeaturedSection（view-featured.ts 137-186）", () => {
	it("首次 → 建 section/head/title/toggle/grid，插入 contentEl，写入 ctx（139-184）", () => {
		const ctx = makeCtx();
		ensureFeaturedSection(ctx);
		expect(ctx.featuredSectionEl).toBeTruthy();
		expect(ctx.featuredGridEl).toBeTruthy();
		const section = ctx.featuredSectionEl as HTMLElement;
		expect(section.querySelector(".pt-featured-title")).toBeTruthy();
		expect(section.querySelector(".pt-featured-toggle")).toBeTruthy();
		// 插入到 scrollViewport 之前
		expect((ctx.contentEl as HTMLElement).firstChild).toBe(section);
	});
	it("已有 section → 直接返回（139）", () => {
		const ctx = makeCtx();
		ensureFeaturedSection(ctx);
		const first = ctx.featuredSectionEl;
		ensureFeaturedSection(ctx);
		expect(ctx.featuredSectionEl).toBe(first);
	});
	it("toggle 点击 → 切换折叠态并同步标签（166-170）", () => {
		const ctx = makeCtx();
		ensureFeaturedSection(ctx);
		const toggle = (ctx.featuredSectionEl as HTMLElement).querySelector(".pt-featured-toggle") as HTMLElement;
		const before = ctx.featuredCollapsed;
		toggle.click();
		expect(ctx.featuredCollapsed).toBe(!before);
	});
});

describe("renderFeaturedSection（view-featured.ts 36-135）", () => {
	it("不满足展示条件 → 隐藏并返回（44-57）", () => {
		const ctx = makeCtx({ viewTab: "updates" });
		renderFeaturedSection(ctx);
		expect(ctx.hideFeaturedSection).toHaveBeenCalled();
		expect(createPluginCard).not.toHaveBeenCalled();
	});

	it("满足条件但推荐集为空 → 隐藏并记录空签名（62-84）", () => {
		const ctx = makeCtx({ getRecommendedIds: vi.fn(() => new Set<string>()) });
		renderFeaturedSection(ctx);
		expect(ctx.hideFeaturedSection).toHaveBeenCalled();
		expect(createPluginCard).not.toHaveBeenCalled();
	});

	it("满足条件且推荐非空 → 建 section、逐卡渲染、写缓存（86-134）", () => {
		const ctx = makeCtx();
		renderFeaturedSection(ctx);
		expect(ctx.hideFeaturedSection).not.toHaveBeenCalled();
		expect(createPluginCard).toHaveBeenCalledTimes(1);
		expect(ctx.featuredSectionEl).toBeTruthy();
		expect((ctx.featuredSectionEl as HTMLElement).style.display).toBe("");
	});

	it("同内容二次渲染 → 命中签名缓存、不重建卡片（62-75）", () => {
		const ctx = makeCtx();
		renderFeaturedSection(ctx);
		(createPluginCard as unknown as ReturnType<typeof vi.fn>).mockClear();
		renderFeaturedSection(ctx);
		expect(createPluginCard).not.toHaveBeenCalled();
	});

	it("折叠态 → 二次渲染命中缓存并同步隐藏（72-73）", () => {
		const ctx = makeCtx({ featuredCollapsed: true });
		ensureFeaturedSection(ctx);
		renderFeaturedSection(ctx); // 首次：构建，display:""
		(createPluginCard as unknown as ReturnType<typeof vi.fn>).mockClear();
		renderFeaturedSection(ctx); // 二次：命中缓存，按折叠态设 display:none
		expect(createPluginCard).not.toHaveBeenCalled();
		expect((ctx.featuredSectionEl as HTMLElement).style.display).toBe("none");
	});
});

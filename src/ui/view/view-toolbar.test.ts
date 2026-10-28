import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildToolbar, alignFacetLabels } from "@ui/view/view-toolbar";
import { makeMockContext } from "@shared/test-utils";
import type { ViewContext } from "@ui/view/view-context";
import { SEARCH_MODES, LAYOUT } from "@shared/constants";

/**
 * 工具栏测试替身。
 *
 * 说明：`test/setup.ts` 的注释声称补齐了 createEl/createDiv/createSpan，
 * 但实现里只有样式方法。这里按 Obsidian 真实语义补齐（含 type / placeholder / attr / href），
 * 与 facet-chips.test.ts、card-render.test.ts 的既有做法一致（各自局部补齐）。
 */
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (
			this: HTMLElement,
			tag: string,
			o?: { cls?: string; text?: string; attr?: Record<string, string>; href?: string; type?: string; placeholder?: string } | string,
		): HTMLElement {
			const el = document.createElement(tag);
			if (typeof o === "string") {
				el.textContent = o;
			} else if (o) {
				if (o.cls) el.className = o.cls;
				if (o.text != null) el.textContent = o.text;
				if (o.type) el.setAttribute("type", o.type);
				if (o.placeholder) el.setAttribute("placeholder", o.placeholder);
				if (o.href) el.setAttribute("href", o.href);
				if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
			}
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o?: unknown): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.createSpan) {
		proto.createSpan = function (this: HTMLElement, o?: unknown): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("span", o);
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, t: string): void {
			this.textContent = t;
		};
	}
}

/** jsdom 不提供 ResizeObserver：以最小可断言替身补齐 */
class FakeResizeObserver {
	static instances: FakeResizeObserver[] = [];
	constructor(private cb: () => void) {
		FakeResizeObserver.instances.push(this);
	}
	observe(): void {
		this.cb();
	}
	unobserve(): void {}
	disconnect(): void {}
	trigger(): void {
		this.cb();
	}
}

interface CtxOpts extends Partial<ViewContext> {}

function ctxFactory(overrides: CtxOpts = {}): ViewContext {
	const contentEl = document.createElement("div");
	const base: Partial<ViewContext> = {
		contentEl,
		app: {} as ViewContext["app"],
		manifest: { id: "chinese-plugin-market" } as ViewContext["manifest"],
		plugin: ({ openJournalView: vi.fn() } as unknown) as ViewContext["plugin"],
		plugins: [] as ViewContext["plugins"],
		settings: ({
			aiSearchEnabled: false,
			aiSearchBaseURL: "",
			aiSearchApiKey: "",
			sourceFilter: "all",
			sortBy: "downloads",
			newWithinDays: null,
			updatedWithinDays: null,
		} as unknown) as ViewContext["settings"],
		translator: ({} as unknown) as ViewContext["translator"],
		searchMode: "keyword",
		searchQuery: "",
		listState: "ready" as ViewContext["listState"],
		selectedCategories: [],
		sortBy: "downloads",
		sortByUserSelected: false,
		semanticSortBackup: null,
		sortFavoritesFirst: false,
		authorFilter: null,
		installFilter: "all",
		favoriteFilter: "all",
		newWithinDays: null,
		updatedWithinDays: null,
		outdatedIds: new Set<string>(),
		journalEntryIds: new Set<string>(),
		enabledIds: new Set<string>(),
		profiles: [],
		filterCache: ({ reset: vi.fn() } as unknown) as ViewContext["filterCache"],
		t: ((k: string) => k) as ViewContext["t"],
		track: vi.fn(),
		announceStatus: vi.fn(),
		switchViewTab: vi.fn(),
		applySearchInput: vi.fn(),
		applyProfile: vi.fn().mockResolvedValue(undefined),
		pluginSaveProfile: vi.fn(),
		saveSettings: vi.fn(),
		scheduleRender: vi.fn(),
		updateFacetVisibility: vi.fn(),
		renderAuthorFacet: vi.fn(),
		renderFeaturedSection: vi.fn(),
		updateGuidance: vi.fn(),
		updateRefreshTooltip: vi.fn(),
		updateAiTranslateButton: vi.fn(),
		aiTranslateAllPending: vi.fn().mockResolvedValue(undefined),
		aiTranslateRunning: false,
		measureLayout: vi.fn(),
		updateWindow: vi.fn(),
		register: vi.fn(),
		runAISearch: vi.fn().mockResolvedValue(undefined),
		advancedOpen: false,
	};
	return makeMockContext({ ...base, ...overrides });
}

function build(overrides: Partial<ViewContext> = {}) {
	const ctx = ctxFactory(overrides);
	const state = { suppressResizeMeasure: false, advancedAnimTimer: 0 };
	const out = buildToolbar(ctx, state);
	return { ctx, state, ...out };
}

/** 触发点击事件（冒泡，以便 stopPropagation 逻辑生效） */
const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true }));
/** 触发 keydown 并等待异步 IIFE 落定 */
async function keydown(el: Element, key: string) {
	el.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
	await Promise.resolve();
	await Promise.resolve();
}

beforeEach(() => {
	ensureDomHelpers();
	FakeResizeObserver.instances = [];
	(window as unknown as Record<string, unknown>).ResizeObserver = FakeResizeObserver;
	document.body.innerHTML = "";
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("alignFacetLabels 标签列对齐", () => {
	it("无 facet 标签时直接返回，不做任何改动", () => {
		const scope = document.createElement("div");
		expect(() => alignFacetLabels(scope)).not.toThrow();
	});

	it("取所有标签实测宽度的最大值，统一设 flex 基值", () => {
		const scope = document.createElement("div");
		const mk = (w: number) => {
			const row = document.createElement("div");
			row.className = "pt-facet-row";
			const label = document.createElement("span");
			label.className = "pt-facet-label";
			Object.defineProperty(label, "offsetWidth", { value: w, configurable: true });
			row.appendChild(label);
			scope.appendChild(row);
			return label;
		};
		const a = mk(40);
		const b = mk(96);
		const c = mk(72);

		alignFacetLabels(scope);

		for (const l of [a, b, c]) {
			expect(l.style.flex).toBe("0 0 96px");
		}
	});

	it("标签宽度全为 0 时回落默认 64px", () => {
		const scope = document.createElement("div");
		const row = document.createElement("div");
		row.className = "pt-facet-row";
		const label = document.createElement("span");
		label.className = "pt-facet-label";
		Object.defineProperty(label, "offsetWidth", { value: 0, configurable: true });
		row.appendChild(label);
		scope.appendChild(row);

		alignFacetLabels(scope);

		expect(label.style.flex).toBe("0 0 64px");
	});
});

describe("buildToolbar 结构契约", () => {
	it("返回带正确 class 的 searchInput", () => {
		const { searchInput } = build();
		expect(searchInput.tagName.toLowerCase()).toBe("input");
		expect(searchInput.classList.contains("pt-search-input")).toBe(true);
	});

	it("渲染 5 个页签，初始选中「浏览」", () => {
		const { ctx } = build();
		const tabs = Array.from(ctx.contentEl.querySelectorAll<HTMLElement>(".pt-view-tab"));
		expect(tabs.map((t) => t.dataset.viewTab)).toEqual([
			"browse",
			"updates",
			"beta",
			"css",
			"favorites",
		]);
		expect(tabs[0].getAttribute("aria-pressed")).toBe("true");
		expect(tabs[1].getAttribute("aria-pressed")).toBe("false");
	});

	it("排序菜单含 8 个排序项 + 1 个「收藏优先」项", () => {
		const { ctx } = build();
		const items = Array.from(ctx.contentEl.querySelectorAll<HTMLElement>(".pt-sort-menu-item"));
		const sorts = items.map((i) => i.dataset.sort);
		expect(sorts).toEqual([
			"relevance",
			"recommended",
			"trending",
			"downloads",
			"updated",
			"published",
			"popular",
			"name",
			"favorites",
		]);
	});
});

describe("buildToolbar 页签切换", () => {
	it("点击「更新」页签调用 switchViewTab('updates')", () => {
		const { ctx } = build();
		click(ctx.contentEl.querySelector(".pt-view-tab[data-view-tab='updates']")!);
		expect(ctx.switchViewTab).toHaveBeenCalledWith("updates");
	});

	it("无待更新项时徽标隐藏且无文案", () => {
		const { ctx } = build({ outdatedIds: new Set<string>() });
		const badge = ctx.contentEl.querySelector<HTMLElement>(".pt-view-tab-badge")!;
		expect(badge.textContent).toBe("");
		expect(badge.style.display).toBe("none");
	});

	it("有待更新项时徽标显示数量", () => {
		const { ctx } = build({ outdatedIds: new Set(["a", "b", "c"]) });
		const badge = ctx.contentEl.querySelector<HTMLElement>(".pt-view-tab-badge")!;
		expect(badge.textContent).toBe("3");
		expect(badge.style.display).toBe("");
	});

	it("暴露 refreshViewTabsBadge，供更新检测后同步徽标", () => {
		const ids = new Set(["a"]);
		const { ctx } = build({ outdatedIds: ids });
		const badge = ctx.contentEl.querySelector<HTMLElement>(".pt-view-tab-badge")!;
		expect(typeof ctx.refreshViewTabsBadge).toBe("function");
		ids.add("b");
		ctx.refreshViewTabsBadge!();
		expect(badge.textContent).toBe("2");
	});
});

describe("applySearchMode 模式切换语义", () => {
	it("切到相同模式时早退，不产生埋点与渲染", () => {
		const { ctx } = build({ searchMode: "ai" });
		(ctx.track as unknown as ReturnType<typeof vi.fn>).mockClear();
		(ctx.scheduleRender as unknown as ReturnType<typeof vi.fn>).mockClear();
		// ai 模式下点 ai 菜单项 = 相同模式
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		const aiItem = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='ai']")!;
		click(aiItem);
		expect(ctx.track).not.toHaveBeenCalled();
		expect(ctx.scheduleRender).not.toHaveBeenCalled();
	});

	it("keyword→ai 且未手动选排序：临时切到相关度并备份原排序", () => {
		const { ctx } = build({ searchMode: "keyword", sortBy: "downloads", sortByUserSelected: false });
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		const aiItem = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='ai']")!;
		click(aiItem);
		expect(ctx.sortBy).toBe("relevance");
		expect(ctx.semanticSortBackup).toBe("downloads");
	});

	it("ai→keyword 且未手动选排序：恢复备份并清空备份槽", () => {
		const { ctx } = build({
			searchMode: "ai",
			sortBy: "relevance",
			sortByUserSelected: false,
			semanticSortBackup: "downloads",
		});
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		const kwItem = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='keyword']")!;
		click(kwItem);
		expect(ctx.sortBy).toBe("downloads");
		expect(ctx.semanticSortBackup).toBeNull();
	});

	it("用户已手动选过排序时，切模式不覆盖其选择", () => {
		const { ctx } = build({ searchMode: "keyword", sortBy: "name", sortByUserSelected: true });
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		const aiItem = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='ai']")!;
		click(aiItem);
		expect(ctx.sortBy).toBe("name");
	});

	it("切模式重置跨模式状态：收藏优先/作者/安装/收藏筛选", () => {
		const { ctx } = build({
			searchMode: "ai",
			sortFavoritesFirst: true,
			authorFilter: "someone",
			installFilter: "installed",
			favoriteFilter: "favorited",
		});
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		const kwItem = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='keyword']")!;
		click(kwItem);

		expect(ctx.sortFavoritesFirst).toBe(false);
		expect(ctx.authorFilter).toBeNull();
		expect(ctx.installFilter).toBe("all");
		expect(ctx.favoriteFilter).toBe("all");
	});

	it("切到 keyword 清空 AI 结果缓存与已选分类", () => {
		const { ctx } = build({
			searchMode: "ai",
			aiSearchResult: ({ ids: ["x"] } as unknown) as ViewContext["aiSearchResult"],
			aiSearchQueryCache: "hello",
			selectedCategories: ["foo"],
		});
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		const kwItem = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='keyword']")!;
		click(kwItem);

		expect(ctx.aiSearchResult).toBeNull();
		expect(ctx.aiSearchQueryCache).toBe("");
		expect(ctx.selectedCategories).toEqual([]);
	});

	it("切模式后失效前缀缓存并上报埋点与状态播报", () => {
		const { ctx } = build({ searchMode: "keyword" });
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		const aiItem = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='ai']")!;
		click(aiItem);

		expect(ctx.filterCache.reset).toHaveBeenCalled();
		expect(ctx.track).toHaveBeenCalledWith("search:ai");
		expect(ctx.announceStatus).toHaveBeenCalled();
		expect(ctx.scheduleRender).toHaveBeenCalled();
	});

	it("切换到语义模式会同步 placeholder 与搜索行 class", () => {
		const { ctx, searchInput } = build({ searchMode: "keyword" });
		const searchBar = ctx.contentEl.querySelector<HTMLElement>(".pt-search")!;
		const modeBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-mode-btn")!;
		click(modeBtn);
		click(ctx.contentEl.querySelector<HTMLElement>(".pt-mode-menu-item[data-mode='ai']")!);

		const aiMode = SEARCH_MODES.find((m) => m.id === "ai")!;
		expect(searchInput.getAttribute("placeholder")).toBe(aiMode.placeholder);
		expect(searchBar.classList.contains("pt-search-ai")).toBe(true);
		expect(searchBar.classList.contains("pt-search-local")).toBe(false);
	});
});

describe("搜索输入防抖与输入法", () => {
	it("输入非空时挂防抖定时器，推进后触发 applySearchInput", () => {
		vi.useFakeTimers();
		try {
			const { ctx, searchInput } = build();
			searchInput.value = "dataview";
			searchInput.dispatchEvent(new Event("input", { bubbles: true }));
			expect(ctx.applySearchInput).not.toHaveBeenCalled();
			vi.advanceTimersByTime(LAYOUT.SEARCH_DEBOUNCE_MS + 5);
			expect(ctx.applySearchInput).toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("清空为空串时立即渲染，不等防抖", () => {
		vi.useFakeTimers();
		try {
			const { ctx, searchInput } = build({ searchQuery: "old" });
			searchInput.value = "";
			searchInput.dispatchEvent(new Event("input", { bubbles: true }));
			expect(ctx.scheduleRender).toHaveBeenCalled();
			vi.advanceTimersByTime(LAYOUT.SEARCH_DEBOUNCE_MS + 5);
			expect(ctx.applySearchInput).not.toHaveBeenCalled();
		} finally {
			vi.useRealTimers();
		}
	});

	it("输入法组字期间不触发搜索，compositionend 后立即触发", () => {
		const { ctx, searchInput } = build();
		searchInput.dispatchEvent(new Event("compositionstart", { bubbles: true }));
		searchInput.value = "ni";
		searchInput.dispatchEvent(new Event("input", { bubbles: true }));
		expect(ctx.applySearchInput).not.toHaveBeenCalled();
		searchInput.dispatchEvent(new Event("compositionend", { bubbles: true }));
		expect(ctx.applySearchInput).toHaveBeenCalled();
	});
});

describe("键盘交互", () => {
	it("语义模式下 Enter 触发 AI 检索", async () => {
		const { ctx, searchInput } = build({ searchMode: "ai" });
		await keydown(searchInput, "Enter");
		expect(ctx.runAISearch).toHaveBeenCalled();
	});

	it("关键词模式下数据未就绪先懒加载，失败则不渲染", async () => {
		const { ctx, searchInput } = build({
			searchMode: "keyword",
			dataLoaded: false,
			plugins: [],
			ensureDataLoaded: vi.fn().mockResolvedValue(false),
		});
		await keydown(searchInput, "Enter");
		expect(ctx.ensureDataLoaded).toHaveBeenCalled();
		expect(ctx.scheduleRender).not.toHaveBeenCalled();
	});

	it("Esc 优先清空搜索框内容", async () => {
		const { ctx, searchInput } = build({ searchQuery: "abc" });
		searchInput.value = "abc";
		await keydown(searchInput, "Escape");
		expect(searchInput.value).toBe("");
		expect(ctx.searchQuery).toBe("");
	});

	it("搜索框为空但处于作者筛选时，Esc 退出作者筛选", async () => {
		const { ctx, searchInput } = build({ searchQuery: "", authorFilter: "bob" });
		await keydown(searchInput, "Escape");
		expect(ctx.authorFilter).toBeNull();
		expect(ctx.renderAuthorFacet).toHaveBeenCalled();
	});

	it("无内容且无筛选时 Esc 失焦", async () => {
		const { searchInput } = build({ searchQuery: "", authorFilter: null });
		searchInput.focus();
		await keydown(searchInput, "Escape");
		expect(document.activeElement).not.toBe(searchInput);
	});
});

describe("AI 状态徽章", () => {
	it("关键词模式下隐藏徽章", () => {
		const { ctx } = build({ searchMode: "keyword" });
		const badge = ctx.contentEl.querySelector<HTMLElement>(".pt-ai-badge")!;
		expect(badge.style.display).toBe("none");
	});

	it("AI 模式且未配置 Key 时提示去配置", () => {
		const { ctx } = build({
			searchMode: "ai",
			settings: ({ aiSearchEnabled: true, aiSearchBaseURL: "", aiSearchApiKey: "" } as unknown) as ViewContext["settings"],
		});
		const badge = ctx.contentEl.querySelector<HTMLElement>(".pt-ai-badge")!;
		expect(badge.textContent).toBe("配置 AI · Enter");
		expect(badge.classList.contains("pt-ai-off")).toBe(true);
	});

	it("AI 模式且已配置 Key 时显示可触发态", () => {
		const { ctx } = build({
			searchMode: "ai",
			settings: ({ aiSearchEnabled: true, aiSearchBaseURL: "https://api.deepseek.com", aiSearchApiKey: "sk-x" } as unknown) as ViewContext["settings"],
		});
		const badge = ctx.contentEl.querySelector<HTMLElement>(".pt-ai-badge")!;
		expect(badge.textContent).toBe("AI · Enter 触发");
		expect(badge.classList.contains("pt-ai-ready")).toBe(true);
	});

	it("本地语义模式显示「本地」且为就绪态", () => {
		const { ctx } = build({ searchMode: "local" });
		const badge = ctx.contentEl.querySelector<HTMLElement>(".pt-ai-badge")!;
		expect(badge.textContent).toBe("本地");
		expect(badge.classList.contains("pt-ai-ready")).toBe(true);
	});

	it("AI 模式未配置 Key 时点击徽章打开本插件设置页", () => {
		const opened: string[] = [];
		const ctx = ctxFactory({
			searchMode: "ai",
			settings: ({ aiSearchEnabled: true, aiSearchBaseURL: "", aiSearchApiKey: "" } as unknown) as ViewContext["settings"],
			app: ({ setting: { openTabById: (id: string) => opened.push(id) } } as unknown) as ViewContext["app"],
		});
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(ctx.contentEl.querySelector<HTMLElement>(".pt-ai-badge")!);
		expect(opened).toEqual(["chinese-plugin-market"]);
	});
});

describe("筛选胶囊与重置", () => {
	it("点击来源胶囊同步 aria-pressed 与上下文状态", () => {
		const { ctx } = build({ sourceFilter: "all" });
		const originalBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-filter[data-value='original']")!;
		click(originalBtn);
		expect(ctx.sourceFilter).toBe("original");
		expect(originalBtn.getAttribute("aria-pressed")).toBe("true");
	});

	it("再次点击同一来源胶囊保持选中且不重复触发保存之外的副作用", () => {
		const { ctx } = build({ sourceFilter: "original" });
		const originalBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-filter[data-value='original']")!;
		const calls = (ctx.saveSettings as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
		click(originalBtn);
		expect(ctx.sourceFilter).toBe("original");
		expect((ctx.saveSettings as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(calls + 1);
	});

	it("点击重置按钮清空全部筛选并重建分类 chips", () => {
		const { ctx } = build({
			sourceFilter: "original",
			installFilter: "installed",
			favoriteFilter: "favorited",
			selectedCategories: ["foo"],
			authorFilter: "bob",
			sortFavoritesFirst: true,
		});
		click(ctx.contentEl.querySelector<HTMLElement>(".pt-toolbar-reset")!);
		expect(ctx.sourceFilter).toBe("all");
		expect(ctx.installFilter).toBe("all");
		expect(ctx.favoriteFilter).toBe("all");
		expect(ctx.selectedCategories).toEqual([]);
	});
});

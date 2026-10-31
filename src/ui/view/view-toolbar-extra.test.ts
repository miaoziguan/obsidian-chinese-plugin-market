import { describe, it, expect, vi, beforeEach } from "vitest";
import { buildToolbar, alignFacetLabels } from "@ui/view/view-toolbar";
import { Menu, Notice } from "obsidian";
import type { ViewContext } from "@ui/view/view-context";

/** obsidian mock 的 Menu 在运行期附带 lastShown / items，但真实类型没有，这里本地补一个形态。 */
type MenuLike = { items: Array<{ title: string; cb?: () => void }> };
const lastMenu = (): MenuLike => (Menu as unknown as { lastShown: MenuLike | null }).lastShown!;

/**
 * view-toolbar.ts 的「事件处理器 + 模式切换」部分。
 *
 * 原有 view-toolbar.test.ts 已覆盖结构契约 / 页签切换 / 搜索防抖 / 键盘 / AI 徽章 /
 * 筛选胶囊，但 buildToolbar 是 ~1100 行的巨型函数，大量逻辑在事件处理器体内、
 * 以及 applySearchMode（259-342，约 80 行的模式切换大块），此前完全没被驱动
 * （如 footprints 徽标、预设组合菜单、一键全更、AI 翻译/检查更新/溢出菜单/折叠面板）。
 *
 * 这些分支的错误模式是「点下去没反应 / 状态不同步」：组合菜单点应用但没切筛选、
 * 切到本地语义却没清掉上次 AI 结果、更新成功后一键全更仍报无更新、折叠面板展开后
 * 底下列表露不出行。都不抛错，靠覆盖率漏斗才能抓到。
 */

vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return { ...actual, Notice: vi.fn().mockImplementation((msg?: string) => ({ message: msg })) };
});
vi.mock("@ui/components/update-progress", () => ({
	createUpdateProgressLayer: vi.fn(() => ({ el: document.createElement("div"), set: vi.fn(), finish: vi.fn() })),
}));
vi.mock("@ui/view/view-data", () => ({
	refreshOutdated: vi.fn().mockResolvedValue(undefined),
}));

/** 复用共享 setup 的 DOM 助手思路：Obsidian 把构造/文本方法挂到 HTMLElement.prototype（局部补齐，避免跨文件泄漏）。 */
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string>; href?: string; type?: string; placeholder?: string } | string): HTMLElement {
			const el = document.createElement(tag);
			if (typeof o === "string") el.textContent = o;
			else if (o) {
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
	if (!proto.createDiv) proto.createDiv = function (this: HTMLElement, o?: unknown): HTMLElement { return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("div", o); };
	if (!proto.createSpan) proto.createSpan = function (this: HTMLElement, o?: unknown): HTMLElement { return (this as unknown as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("span", o); };
	if (!proto.setText) proto.setText = function (this: HTMLElement, t: string): void { this.textContent = t; };
	if (!proto.setCssStyles) proto.setCssStyles = function (this: HTMLElement, s: Record<string, string>): void { for (const [k, v] of Object.entries(s)) this.style.setProperty(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), v); };
	if (!proto.toggleClass) proto.toggleClass = function (this: HTMLElement, c: string, on?: boolean): void { this.classList.toggle(c, on ?? true); };
}

class FakeResizeObserver {
	cb: () => void;
	constructor(cb: () => void) { this.cb = cb; }
	observe(): void { this.cb(); }
	unobserve(): void {}
	disconnect(): void {}
}

interface CtxOpts {
	profiles?: Array<{ id: string; name: string; enabled: string[] }>;
	journalEntryIds?: Set<string>;
	outdatedIds?: Set<string>;
	enabledIds?: Set<string>;
	searchMode?: string;
	sourceFilter?: string;
	aiSearchEnabled?: boolean;
	[key: string]: unknown;
}

function makeCtx(over: CtxOpts = {}): { ctx: ViewContext; contentEl: HTMLElement } {
	ensureDomHelpers();
	(window as unknown as { ResizeObserver: unknown }).ResizeObserver = FakeResizeObserver;
	const contentEl = document.createElement("div");
	const profiles = over.profiles ?? [];
	const journalEntryIds = over.journalEntryIds ?? new Set<string>();
	const outdatedIds = over.outdatedIds ?? new Set<string>();
	const enabledIds = over.enabledIds ?? new Set<string>();
	const base: Record<string, unknown> = {
		contentEl,
		app: { setting: { open: vi.fn(), openTabById: vi.fn() } },
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		plugin: { openJournalView: vi.fn(), pluginSaveProfile: vi.fn(), saveCurrentAsProfile: vi.fn() },
		plugins: [] as unknown[],
		settings: { aiSearchEnabled: over.aiSearchEnabled ?? false, aiSearchBaseURL: "", aiSearchApiKey: "", sourceFilter: over.sourceFilter ?? "all", sortBy: "downloads" },
		translator: {},
		searchMode: over.searchMode ?? "keyword",
		searchQuery: "",
		listState: "ready",
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
		outdatedIds,
		journalEntryIds,
		enabledIds,
		profiles,
		installedIds: new Set<string>(),
		filterCache: { reset: vi.fn() },
		t: ((k: string) => k) as never,
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
		refreshViewTabsBadge: vi.fn(),
		updateAll: vi.fn(() => Promise.resolve()),
		refreshData: vi.fn().mockResolvedValue(undefined),
		...over,
	};
	return { ctx: base as unknown as ViewContext, contentEl };
}

const click = (el: Element) => el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));

beforeEach(() => {
	document.body.innerHTML = "";
	vi.mocked(Notice).mockClear();
	if (!(window as unknown as { requestAnimationFrame?: unknown }).requestAnimationFrame) {
		(window as unknown as { requestAnimationFrame: (cb: (t: number) => void) => number }).requestAnimationFrame = (cb) => { cb(0); return 1; };
		(window as unknown as { cancelAnimationFrame: (h: number) => void }).cancelAnimationFrame = () => {};
	}
});

describe("buildToolbar：事件处理器与模式切换", () => {
	it("组合预设菜单：非空 profiles 时菜单含每个预设 + 另存为项；点击预设应用", async () => {
		const { ctx } = makeCtx({
			profiles: [
				{ id: "p1", name: "A", enabled: ["x"] },
				{ id: "p2", name: "B", enabled: [] },
			],
			enabledIds: new Set(["x"]),
		});
		const { searchInput } = buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		expect(searchInput).toBeInstanceOf(HTMLInputElement);
		const profileBtn = ctx.contentEl.querySelector<HTMLElement>(".pt-profile-dropdown")!;
		click(profileBtn);
		const menu = lastMenu();
		// 两个预设 + 另存为
		expect(menu.items.length).toBe(3);
		expect(menu.items[0].title).toContain("A");
		expect(menu.items[0].title).toContain("（1）");
		expect(menu.items[2].title).toBe("profiles.saveAs.menu"); // 另存为项存在
		// 点击第二个预设（非当前组合）→ 触发 applyProfile + scheduleRender
		menu.items[1].cb!();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect(ctx.applyProfile).toHaveBeenCalled();
		expect(ctx.scheduleRender).toHaveBeenCalledWith(true);
	});

	it("组合预设菜单：已是当前组合时不重复切换（弹「当前生效」提示）", () => {
		const { ctx } = makeCtx({
			profiles: [{ id: "p1", name: "当前", enabled: ["x"] }],
			enabledIds: new Set(["x"]),
		});
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(ctx.contentEl.querySelector(".pt-profile-dropdown")!);
		lastMenu().items[0].cb!();
		expect(Notice).toHaveBeenCalledWith("profiles.alreadyActive");
		expect(ctx.applyProfile).not.toHaveBeenCalled();
	});

	it("足迹徽标：有评测笔记时显示数量徽标", () => {
		const { ctx } = makeCtx({ journalEntryIds: new Set(["a", "b"]) });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		const badge = ctx.contentEl.querySelector(".pt-header-footprint-badge");
		expect(badge?.textContent).toBe("2");
	});

	it("一键全更：有可更新项时触发进度层 + updateAll", () => {
		const { ctx } = makeCtx({ outdatedIds: new Set(["a", "b"]) });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(ctx.contentEl.querySelector(".pt-update-all")!);
		expect(ctx.track).toHaveBeenCalledWith("action:updateAll");
		expect(ctx.updateAll).toHaveBeenCalled();
	});

	it("一键全更：无可更新项时仅提示不触发", () => {
		const { ctx } = makeCtx({ outdatedIds: new Set<string>() });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(ctx.contentEl.querySelector(".pt-update-all")!);
		expect(ctx.updateAll).not.toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith("action.update.none");
	});

	it("AI 一键翻译：未处于 original 时先切筛选再翻译", () => {
		const { ctx } = makeCtx({ sourceFilter: "all" });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		expect(ctx.aiTranslateBtnEl).toBeInstanceOf(HTMLElement);
		click(ctx.aiTranslateBtnEl!);
		expect(ctx.saveSettings).toHaveBeenCalled();
		expect(ctx.aiTranslateAllPending).toHaveBeenCalled();
	});

	it("AI 一键翻译：处于 original 时不重复切筛选，直接翻译", () => {
		const { ctx } = makeCtx({ sourceFilter: "original" });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(ctx.aiTranslateBtnEl!);
		expect(ctx.saveSettings).not.toHaveBeenCalled();
		expect(ctx.aiTranslateAllPending).toHaveBeenCalled();
	});

	it("检查更新：检测后按可更新数提示", async () => {
		const { ctx, contentEl } = makeCtx({ outdatedIds: new Set(["a"]) });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(contentEl.querySelector(".pt-check-update")!);
		// refreshOutdated 是 mock 的 resolved promise，链路回调在微任务中执行
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(Notice).toHaveBeenCalledWith("action.checkUpdate.available");
	});

	it("清除搜索：清空输入并回到全量列表", () => {
		const { ctx, contentEl } = makeCtx();
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		const input = contentEl.querySelector<HTMLInputElement>(".pt-search-input")!;
		input.value = "abc";
		const clearBtn = contentEl.querySelector<HTMLElement>(".pt-search-clear")!;
		click(clearBtn);
		expect(input.value).toBe("");
		expect(ctx.searchQuery).toBe("");
		expect(ctx.aiSearchResult).toBeNull();
		expect(ctx.scheduleRender).toHaveBeenCalled();
	});

	it("设置入口：先 open 再 openTabById 本插件设置页", () => {
		const { ctx, contentEl } = makeCtx();
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(contentEl.querySelector(".pt-open-settings")!);
		const setting = (ctx.app as unknown as { setting: { open: () => void; openTabById: (s: string) => void } }).setting;
		expect(setting.open).toHaveBeenCalled();
		expect(setting.openTabById).toHaveBeenCalledWith("chinese-plugin-market");
	});

	it("溢出菜单：窄屏折叠的「检查更新 / 一键全更 / 刷新」等汇聚于此", () => {
		const { ctx, contentEl } = makeCtx({ outdatedIds: new Set(["a"]) });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(contentEl.querySelector(".pt-overflow-btn")!);
		const menu = lastMenu();
		const titles = menu.items.map((i) => i.title);
		expect(titles.some((t) => t.includes("checkUpdate") || t.includes("updateAll") || t.includes("refresh"))).toBe(true);
	});

	it("模式切换：keyword → ai 临时切相关度 + 清 AI 结果；keyword → local 清本地/AI 结果", () => {
		const { ctx, contentEl } = makeCtx({ searchMode: "keyword", searchQuery: "主题" });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		// keyword → ai
		click(contentEl.querySelector('.pt-mode-menu-item[data-mode="ai"]')!);
		expect(ctx.searchMode).toBe("ai");
		expect(ctx.semanticSortBackup).toBe("downloads");
		expect(ctx.sortBy).toBe("relevance");
		expect(ctx.filterCache.reset).toHaveBeenCalled();
		// 回到 keyword 再切 local（覆盖 local 分支：清掉上次 AI/语义结果）
		click(contentEl.querySelector('.pt-mode-menu-item[data-mode="keyword"]')!);
		click(contentEl.querySelector('.pt-mode-menu-item[data-mode="local"]')!);
		expect(ctx.searchMode).toBe("local");
		expect(ctx.aiSearchResult).toBeNull();
	});

	it("AI 模式且无 Key 时，点击徽章跳本插件设置页", () => {
		const { ctx, contentEl } = makeCtx({ searchMode: "ai", aiSearchEnabled: false });
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		click(contentEl.querySelector(".pt-ai-badge")!);
		expect((ctx.app as unknown as { setting: { openTabById: (s: string) => void } }).setting.openTabById).toHaveBeenCalledWith("chinese-plugin-market");
	});

	it("折叠面板：展开后触发列表重测 + 标签列重新对齐", () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
		const { ctx, contentEl } = makeCtx();
		buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
		const toggle = contentEl.querySelector<HTMLElement>(".pt-toggle-filters")!;
		click(toggle);
		expect(ctx.renderFeaturedSection).toHaveBeenCalled();
		// measureLayout / updateWindow 在 200ms 收尾定时器里（动画结束后补测，避免卡顿）
		vi.advanceTimersByTime(250);
		expect(ctx.measureLayout).toHaveBeenCalled();
		expect(ctx.updateWindow).toHaveBeenCalled();
		// 收起方向也能切换不抛错
		click(toggle);
		expect(ctx.renderFeaturedSection).toHaveBeenCalledTimes(2);
		vi.useRealTimers();
	});
});

describe("alignFacetLabels", () => {
	it("无标签直接返回", () => {
		const scope = document.createElement("div");
		expect(() => alignFacetLabels(scope)).not.toThrow();
	});
	it("取最大宽度统一设 flex 基值", () => {
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
		mk(80);
		alignFacetLabels(scope);
		expect(a.style.flex).toBe("0 0 80px");
	});
});

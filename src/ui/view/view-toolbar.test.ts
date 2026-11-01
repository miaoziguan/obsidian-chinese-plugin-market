import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildToolbar } from "@ui/view/view-toolbar";
import { applySearchInput } from "@ui/view/view-data";
import { runAISearch } from "@ui/view/view-ai-search";
import { PluginTagService } from "@domain/catalog/plugin-tags";
import type { Translator } from "@domain/catalog/translator";
import { makeMockContext, makeMockPlugin } from "@shared/test-utils";
import type { ViewContext } from "@ui/view/view-context";

type ElementInfo = { cls?: string; text?: string; attr?: Record<string, string> };
// 只补工具栏需要的 Obsidian DOM 扩展，仍执行真实事件处理器。
Object.assign(HTMLElement.prototype, {
	createEl(this: HTMLElement, tag: keyof HTMLElementTagNameMap, info?: ElementInfo) {
		const el = document.createElement(tag);
		if (info?.cls) el.className = info.cls;
		if (info?.text !== undefined) el.textContent = info.text;
		for (const [key, value] of Object.entries(info?.attr ?? {})) el.setAttribute(key, value);
		this.append(el);
		return el;
	},
	createDiv(this: HTMLElement, info?: ElementInfo) { return this.createEl("div", info); },
	createSpan(this: HTMLElement, info?: ElementInfo) { return this.createEl("span", info); },
	setText(this: HTMLElement, text: string) { this.textContent = text; },
});
const disposers: (() => void)[] = [];
beforeEach(() => {
	vi.useFakeTimers();
	vi.stubGlobal("ResizeObserver", class { observe() {} disconnect() {} });
});
afterEach(() => {
	for (const dispose of disposers.splice(0)) dispose();
	document.body.textContent = "";
	vi.clearAllTimers();
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

function setup(mode: ViewContext["searchMode"] = "ai") {
	const plugin = makeMockPlugin({ settings: { aiSearchEnabled: true, aiSearchBaseURL: "http://localhost", embeddingSource: "keyword" } });
	const translator = { cache: {}, tagService: new PluginTagService(), getVectorIndex: () => null, aiSearchLocal: vi.fn().mockResolvedValue({ rankedIds: ["calendar"] }) } as unknown as Translator;
	const ctx = makeMockContext({
		plugin, settings: plugin.settings, translator, searchMode: mode, searchQuery: "calendar",
		contentEl: document.createElement("div"),
		plugins: [{ id: "calendar", name: "Calendar", description: "Daily notes", author: "a" }],
		selectedCategories: [], enabledIds: new Set(), profiles: [],
		aiSearchPending: false, aiSearchResult: null, aiSearchQueryCache: "",
		sourceFilter: "all", installFilter: "all", favoriteFilter: "all",
		chineseEcoFilter: "all", seriesFilter: "all", sortBy: "downloads",
		t: key => key, register: cb => { disposers.push(cb); return cb; },
		track: vi.fn(), announceStatus: vi.fn(), updateGuidance: vi.fn(),
		updateAiTranslateButton: vi.fn(), updateRefreshTooltip: vi.fn(),
		renderAuthorFacet: vi.fn(), updateFacetVisibility: vi.fn(), scheduleRender: vi.fn(),
		showAIPendingHint: vi.fn(), renderPluginList: vi.fn(), ensureDataLoaded: vi.fn().mockResolvedValue(true),
	});
	ctx.filterCache = { reset: vi.fn() } as unknown as ViewContext["filterCache"];
	ctx.applySearchInput = () => applySearchInput(ctx);
	const submitted: string[] = [];
	ctx.runAISearch = vi.fn(async () => { submitted.push(ctx.searchQuery); });
	const { searchInput } = buildToolbar(ctx, { suppressResizeMeasure: false, advancedAnimTimer: 0 });
	searchInput.value = ctx.searchQuery;
	document.body.append(ctx.contentEl);
	return { ctx, searchInput, submitted };
}

describe("工具栏搜索提交边界", () => {
	it("200ms 防抖前按 Enter 提交最新输入，并取消旧定时任务", () => {
		const { ctx, searchInput, submitted } = setup();
		const apply = vi.spyOn(ctx, "applySearchInput");
		searchInput.value = "  GIT  ";
		searchInput.dispatchEvent(new Event("input", { bubbles: true }));
		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(submitted).toEqual(["git"]);
		vi.advanceTimersByTime(250);
		expect(apply).not.toHaveBeenCalled();
	});

	it.each(["keyword", "local"] as const)("%s 模式 Enter 同步最新查询", (mode) => {
		const { ctx, searchInput, submitted } = setup(mode);
		searchInput.value = " Git ";
		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(ctx.searchQuery).toBe("git");
		if (mode === "local") expect(submitted).toEqual(["git"]);
		else expect(ctx.scheduleRender).toHaveBeenCalled();
	});

	it("合成输入的 Enter/Escape 不搜索或清空，确认后再次 Enter 才提交", () => {
		const { searchInput, submitted } = setup();
		searchInput.value = "日历";
		searchInput.dispatchEvent(new CompositionEvent("compositionstart"));
		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", isComposing: true }));
		expect(searchInput.value).toBe("日历");
		expect(submitted).toEqual([]);
		searchInput.dispatchEvent(new CompositionEvent("compositionend"));
		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", isComposing: true }));
		expect(submitted).toEqual([]);
		searchInput.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter" }));
		expect(submitted).toEqual(["日历"]);
	});

	it("本地搜索后切到 AI 模式不复用本地结果", async () => {
		const { ctx, searchInput } = setup("local");
		await runAISearch(ctx, searchInput, document.createElement("span"));
		expect(ctx.aiSearchResult?.rankedIds).toEqual(["calendar"]);
		ctx.contentEl.querySelector<HTMLElement>('[data-mode=ai]')!.click();
		expect(ctx.searchMode).toBe("ai");
		expect(ctx.aiSearchResult).toBeNull();
	});

	it("防抖期间切模式也同步当前输入", () => {
		const { ctx, searchInput } = setup("keyword");
		searchInput.value = "Git";
		searchInput.dispatchEvent(new Event("input"));
		ctx.contentEl.querySelector<HTMLElement>('[data-mode=ai]')!.click();
		expect(ctx.searchQuery).toBe("git");
		vi.advanceTimersByTime(250);
		expect(ctx.searchQuery).toBe("git");
	});
});

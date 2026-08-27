import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notice } from "obsidian";
import { makeMockContext, makeMockPlugin } from "@shared/test-utils";
import { runAISearch } from "@ui/view/view-ai-search";
import type { ViewContext } from "@ui/view/view-context";

// 隔离 Notice：断言 AI 搜索编排的控制流，不依赖真实 toast。
vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
	return { ...actual, Notice: vi.fn() };
});

	function mkCtx(settingsOverrides: Record<string, unknown> = {}) {
	const settings = {
		aiSearchEnabled: true,
		aiSearchApiKey: "k",
		aiSearchBaseURL: "u",
		aiSearchModel: "m",
		embeddingSource: "keyword",
		embeddingBaseURL: "",
		embeddingApiKey: "",
		embeddingModel: "",
		embeddingLocalModel: "",
		embeddingLocalWasmPaths: "",
		aiSearchShowReason: false,
		...settingsOverrides,
	} as Partial<import("@ui/view/translator-view").ChinesePluginMarketSettings>;
	const plugin = makeMockPlugin({ settings, saveVectorIndex: vi.fn() });
	const translator = {
		aiSearch: vi.fn().mockResolvedValue({ rankedIds: ["a", "b"] }),
	} as any;
	const searchInput = { addClass: vi.fn(), removeClass: vi.fn() } as any;
	const aiBadge = { className: "", setAttribute: vi.fn(), setText: vi.fn(), setCssStyles: vi.fn() } as any;
	const ctx = makeMockContext({
		plugin,
		settings,
		saveVectorIndex: plugin.saveVectorIndex,
		translator,
		t: (k: string) => String(k),
		searchQuery: "vue",
		plugins: [],
		aiSearchPending: false,
		aiSearchResult: null,
		aiSearchQueryCache: "",
		lastAiSearchResult: null,
		lastAiSearchQuery: "",
		selectedCategories: [],
		ensureDataLoaded: vi.fn().mockResolvedValue(true),
		renderPluginList: vi.fn(),
		showAIConfigGuide: vi.fn(),
	} as any) as ViewContext;
	return { ctx, settings, plugin, translator, searchInput, aiBadge };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runAISearch (P2-1: 从 view-data 拆离 AI 搜索编排)", () => {
	it("未启用 AI 搜索 → 弹配置引导、不调用 translator.aiSearch", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx({ aiSearchEnabled: false });
		await runAISearch(ctx, searchInput, aiBadge);
		expect(ctx.showAIConfigGuide).toHaveBeenCalledWith("disabled");
		expect(translator.aiSearch).not.toHaveBeenCalled();
	});

	it("已启用但缺 API Key → 弹 noKey 引导、不调用 aiSearch", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx({ aiSearchApiKey: "" });
		await runAISearch(ctx, searchInput, aiBadge);
		expect(ctx.showAIConfigGuide).toHaveBeenCalledWith("noKey");
		expect(translator.aiSearch).not.toHaveBeenCalled();
	});

	it("空查询 → 直接 return，不调用 aiSearch", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		ctx.searchQuery = "";
		await runAISearch(ctx, searchInput, aiBadge);
		expect(translator.aiSearch).not.toHaveBeenCalled();
	});

	it("已在进行中（aiSearchPending）→ 直接 return，不重复调用", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		ctx.aiSearchPending = true;
		await runAISearch(ctx, searchInput, aiBadge);
		expect(translator.aiSearch).not.toHaveBeenCalled();
	});

	it("数据为空的首次触发：ensureDataLoaded 失败 → 提示并不调用 aiSearch", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		(ctx.ensureDataLoaded as any).mockResolvedValue(false);
		await runAISearch(ctx, searchInput, aiBadge);
		expect(Notice).toHaveBeenCalled();
		expect(translator.aiSearch).not.toHaveBeenCalled();
	});

	it("成功路径（keyword 嵌入）：写回结果、finally 重渲染、不落盘向量索引", async () => {
		const { ctx, translator, plugin, searchInput, aiBadge } = mkCtx();
		await runAISearch(ctx, searchInput, aiBadge);
		expect(translator.aiSearch).toHaveBeenCalledWith(
			"vue",
			[],
			expect.anything(),
			false,
			expect.any(Function),
			undefined
		);
		expect(ctx.aiSearchResult).toEqual({ rankedIds: ["a", "b"] });
		expect(ctx.aiSearchPending).toBe(false);
		expect(ctx.renderPluginList).toHaveBeenCalled();
		// embeddingSource === "keyword" 时无需保存向量索引（跨会话复用无意义）
		expect(plugin.saveVectorIndex).not.toHaveBeenCalled();
	});

	it("成功路径（非 keyword 嵌入）：调用 plugin.saveVectorIndex 落盘", async () => {
		const { ctx, plugin, searchInput, aiBadge } = mkCtx({ embeddingSource: "openai" });
		await runAISearch(ctx, searchInput, aiBadge);
		expect(plugin.saveVectorIndex).toHaveBeenCalled();
	});

	it("异常路径：aiSearch 抛错 → 清空结果、弹失败提示、finally 仍重渲染", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		translator.aiSearch.mockRejectedValue(new Error("boom"));
		await runAISearch(ctx, searchInput, aiBadge);
		expect(ctx.aiSearchResult).toBeNull();
		expect(Notice).toHaveBeenCalled();
		expect(ctx.renderPluginList).toHaveBeenCalled();
		expect(ctx.aiSearchPending).toBe(false);
	});
});

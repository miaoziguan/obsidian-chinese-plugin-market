import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notice } from "obsidian";
import { makeMockContext, makeMockPlugin } from "@shared/test-utils";
import { runAISearch } from "@ui/view/view-ai-search";
import type { ViewContext } from "@ui/view/view-context";
import { invalidateAISearch, restoreAISearch, validateAISearchResult } from "@ui/view/view-search-state";

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
		searchMode: "ai",
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
		buildLocalIndex: vi.fn().mockResolvedValue(undefined),
	} as any) as ViewContext;
	return { ctx, settings, plugin, translator, searchInput, aiBadge };
}

beforeEach(() => {
	vi.clearAllMocks();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason: Error) => void;
	const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
	return { promise, resolve, reject };
}

describe("语义请求生命周期与缓存边界", () => {
	it("首次加载期间重复提交只搜索一次，加载异常也释放 pending", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		const loading = deferred<boolean>();
		vi.mocked(ctx.ensureDataLoaded).mockReturnValue(loading.promise);
		const first = runAISearch(ctx, searchInput, aiBadge);
		expect(ctx.aiSearchPending).toBe(true);
		await runAISearch(ctx, searchInput, aiBadge);
		loading.resolve(true);
		await first;
		expect(translator.aiSearch).toHaveBeenCalledTimes(1);
		vi.mocked(ctx.ensureDataLoaded).mockRejectedValue(new Error("load failed"));
		await runAISearch(ctx, searchInput, aiBadge);
		expect(ctx.aiSearchPending).toBe(false);
	});

	it.each(["resolve", "reject"] as const)("旧请求 %s 不修改新请求的结果、徽章或 pending", async (completion) => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		ctx.plugins = [{ id: "a", name: "A", description: "d", author: "x" }];
		const old = deferred<{ rankedIds: string[] }>();
		const latest = deferred<{ rankedIds: string[] }>();
		translator.aiSearch.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
		const first = runAISearch(ctx, searchInput, aiBadge);
		ctx.searchQuery = "git";
		const second = runAISearch(ctx, searchInput, aiBadge);
		const titleCalls = aiBadge.setAttribute.mock.calls.length;
		const notices = vi.mocked(Notice).mock.calls.length;
		if (completion === "resolve") old.resolve({ rankedIds: ["stale"] });
		else old.reject(new Error("stale failure"));
		await first;
		expect(ctx.aiSearchResult).toBeNull();
		expect(ctx.aiSearchPending).toBe(true);
		expect(aiBadge.setAttribute).toHaveBeenCalledTimes(titleCalls);
		expect(Notice).toHaveBeenCalledTimes(notices);
		expect(ctx.renderPluginList).not.toHaveBeenCalled();
		latest.resolve({ rankedIds: ["latest"] });
		await second;
		expect(ctx.aiSearchResult?.rankedIds).toEqual(["latest"]);
		expect(ctx.aiSearchQueryCache).toBe("git");
		expect(ctx.aiSearchPending).toBe(false);
	});

	it.each(["query", "mode", "categories", "config", "translation", "disposed"])("等待期间 %s 改变时丢弃旧结果", async (change) => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx({ embeddingSource: "api" });
		ctx.plugins = [{ id: "a", name: "A", description: "d", author: "x" }];
		translator.cache = {};
		const waiting = deferred<{ rankedIds: string[] }>();
		translator.aiSearch.mockReturnValue(waiting.promise);
		const work = runAISearch(ctx, searchInput, aiBadge);
		if (change === "query") ctx.searchQuery = "git";
		if (change === "mode") ctx.searchMode = "keyword";
		if (change === "categories") ctx.selectedCategories.push("other");
		if (change === "config") ctx.settings.aiSearchModel = "new-model";
		if (change === "translation") translator.cache.a = { source: "custom", translatedName: "新译名", translatedDesc: "新描述" };
		if (change === "disposed") ctx.disposed = true;
		waiting.resolve({ rankedIds: ["stale"] });
		await work;
		expect(ctx.aiSearchResult).toBeNull();
		expect(ctx.aiSearchQueryCache).toBe("");
		expect(ctx.aiSearchPending).toBe(false);
		expect(ctx.saveVectorIndex).not.toHaveBeenCalled();
		expect(ctx.renderPluginList).not.toHaveBeenCalled();
		expect(Notice).not.toHaveBeenCalled();
	});

	it("加载期间取消后，不再启动搜索", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		const loading = deferred<boolean>();
		vi.mocked(ctx.ensureDataLoaded).mockReturnValue(loading.promise);
		const work = runAISearch(ctx, searchInput, aiBadge);
		invalidateAISearch(ctx);
		ctx.searchQuery = "";
		loading.resolve(true);
		await work;
		expect(translator.aiSearch).not.toHaveBeenCalled();
		expect(ctx.aiSearchPending).toBe(false);
	});

	it("新请求已成功后，旧请求失败也不清空新结果", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		ctx.plugins = [{ id: "a", name: "A", description: "d", author: "x" }];
		const old = deferred<{ rankedIds: string[] }>();
		translator.aiSearch.mockReturnValueOnce(old.promise).mockResolvedValueOnce({ rankedIds: ["latest"] });
		const first = runAISearch(ctx, searchInput, aiBadge);
		ctx.searchQuery = "git";
		await runAISearch(ctx, searchInput, aiBadge);
		old.reject(new Error("late failure"));
		await first;
		expect(ctx.aiSearchResult?.rankedIds).toEqual(["latest"]);
		expect(ctx.aiSearchQueryCache).toBe("git");
		expect(ctx.renderPluginList).toHaveBeenCalledTimes(1);
	});

	it("同一查询切回相同模式可复用，另一模式不复用", async () => {
		const { ctx, searchInput, aiBadge } = mkCtx();
		await runAISearch(ctx, searchInput, aiBadge);
		const result = ctx.aiSearchResult;
		invalidateAISearch(ctx);
		ctx.searchMode = "local";
		expect(restoreAISearch(ctx)).toBe(false);
		ctx.searchMode = "ai";
		expect(restoreAISearch(ctx)).toBe(true);
		expect(ctx.aiSearchResult).toBe(result);
	});

	it.each(["category", "model", "credentials", "embedding", "translation", "data", "stats", "tags"])("缓存对 %s 变化失效", async (change) => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		ctx.plugins = [{ id: "a", name: "A", description: "d", author: "x" }];
		translator.cache = {};
		translator.pluginTags = {};
		await runAISearch(ctx, searchInput, aiBadge);
		if (change === "category") ctx.selectedCategories = ["other"];
		if (change === "model") ctx.settings.aiSearchModel = "new-model";
		if (change === "credentials") ctx.settings.aiSearchApiKey = "changed-key";
		if (change === "embedding") ctx.settings.embeddingBaseURL = "http://localhost/new";
		if (change === "translation") translator.cache.a = { source: "custom", translatedName: "译名", translatedDesc: "描述" };
		if (change === "data") ctx.plugins[0].description = "changed";
		if (change === "stats") ctx.plugins[0].downloads = 100;
		if (change === "tags") translator.pluginTags.a = { category: "new", tags: [] };
		expect(restoreAISearch(ctx)).toBe(false);
		validateAISearchResult(ctx);
		expect(ctx.aiSearchResult).toBeNull();
	});
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

	it("本地语义首次触发：挂载模型下载进度条（设置页同款），且 finally 清理", async () => {
		// 构造支持 closest 的 searchInput：.pt-search-field 用于挂载进度条，.pt-search 用于 finally 移除 loading 类
		const field = {
			createDiv: vi.fn().mockReturnValue({
				createEl: vi.fn().mockReturnValue({ max: 0, value: 0, setCssStyles: vi.fn(), querySelector: () => ({ value: 0, setCssStyles: vi.fn() }) }),
				createSpan: vi.fn().mockReturnValue({ setText: vi.fn(), setCssStyles: vi.fn() }),
				querySelector: vi.fn().mockReturnValue({ value: 0, setCssStyles: vi.fn() }),
				remove: vi.fn(),
			}),
			removeClass: vi.fn(),
			addClass: vi.fn(),
		};
		const searchInput = { addClass: vi.fn(), removeClass: vi.fn(), closest: vi.fn().mockReturnValue(field) } as any;
		const aiBadge = { className: "", setAttribute: vi.fn(), setText: vi.fn(), setCssStyles: vi.fn() } as any;
		const translator = {
			aiSearchLocal: vi.fn().mockResolvedValue({ rankedIds: ["a", "b"] }),
			getVectorIndex: vi.fn().mockReturnValue(null),
		} as any;
		const plugin = makeMockPlugin({
			settings: { ...({ embeddingSource: "local" } as any), aiSearchEnabled: true, aiSearchApiKey: "k", aiSearchBaseURL: "u" },
			localModelState: { status: "idle", loaded: 0, total: 0 },
			saveVectorIndex: vi.fn(),
		});
		const ctx = makeMockContext({
			plugin,
			settings: plugin.settings,
			saveVectorIndex: plugin.saveVectorIndex,
			translator,
			t: (k: string) => String(k),
			searchQuery: "vue",
			searchMode: "local",
			plugins: [{ id: "a", name: "A", description: "d" }],
			aiSearchPending: false,
			aiSearchResult: null,
			aiSearchQueryCache: "",
			lastAiSearchResult: null,
			lastAiSearchQuery: "",
			selectedCategories: [],
			ensureDataLoaded: vi.fn().mockResolvedValue(true),
			renderPluginList: vi.fn(),
			showAIConfigGuide: vi.fn(),
			buildLocalIndex: vi.fn().mockResolvedValue(undefined),
		} as any) as ViewContext;

		await runAISearch(ctx, searchInput, aiBadge);
		// 进度条容器已被创建（与设置页同款 <progress class="pt-index-progress">）
		expect(field.createDiv).toHaveBeenCalled();
		expect(ctx.buildLocalIndex).toHaveBeenCalledWith(false);
		expect(translator.aiSearchLocal).toHaveBeenCalled();
		expect(ctx.aiSearchResult).toEqual({ rankedIds: ["a", "b"] });
	});

	it("已有 partial 索引时不等待整库构建，直接使用当前索引搜索", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx({ embeddingSource: "local" });
		ctx.searchMode = "local";
		ctx.plugins = [{ id: "a", name: "A", description: "d" }] as any;
		(ctx.plugin.localModelState as any) = { status: "ready", loaded: 0, total: 0 };
		(translator as any).getVectorIndex = vi.fn().mockReturnValue({
			ids: ["a"],
			vectors: [[1, 0]],
			model: "local:test",
			partial: true,
		});
		(translator as any).aiSearchLocal = vi.fn().mockResolvedValue({ rankedIds: ["a"] });

		await runAISearch(ctx, searchInput, aiBadge);

		expect(ctx.buildLocalIndex).not.toHaveBeenCalled();
		expect(translator.aiSearchLocal).toHaveBeenCalled();
	});

	it("pluginArgs 透传 downloads/updated（补丁 B 质量因子数据源，此前只在卡片展示）", async () => {
		const { ctx, translator, searchInput, aiBadge } = mkCtx();
		ctx.plugins.push({ id: "a", name: "A", description: "d", downloads: 123, updated: 456 } as any);
		await runAISearch(ctx, searchInput, aiBadge);
		const args = (translator.aiSearch as any).mock.calls[0][1];
		expect(args[0]).toMatchObject({ id: "a", downloads: 123, updated: 456 });
	});
});

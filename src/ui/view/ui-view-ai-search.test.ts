import { describe, it, expect, vi, beforeEach } from "vitest";
import { runAISearch } from "./view-ai-search";
import { isAISearchUsable } from "@shared/utils";
import type { ViewContext } from "./view-context";

vi.mock("@shared/utils", () => ({ isAISearchUsable: vi.fn(() => true) }));
vi.mock("@domain/search/query-sampling", () => ({ reportQuerySample: vi.fn(() => Promise.resolve()) }));
vi.mock("@shared/logger", () => ({ logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

// 局部补齐 Obsidian 对 HTMLElement 的 createEl/createDiv/createSpan/empty/setText 增强（与 dep-section 测试一致）
type ElOpts =
	| string
	| { cls?: string; text?: string | null; attr?: Record<string, string> };
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o?: ElOpts): HTMLElement {
			const el = document.createElement(tag);
			if (typeof o === "string") el.textContent = o;
			else if (o) {
				if (o.cls) el.className = o.cls;
				if (o.text != null) el.textContent = o.text;
				if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
			}
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o?: ElOpts): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, t: string): HTMLElement {
			this.textContent = t;
			return this;
		};
	}
}
ensureDomHelpers();

function makeCtx(over: Record<string, unknown> = {}): ViewContext {
	const translator = {
		cache: {} as Record<string, { source: string; translatedName?: string; translatedDesc?: string }>,
		getVectorIndex: vi.fn(() => null),
		aiSearch: vi.fn(),
		aiSearchLocal: vi.fn(),
	};
	const base = {
		aiSearchPending: false,
		searchQuery: "hello",
		searchMode: "ai" as "ai" | "local",
		settings: {
			aiSearchEnabled: true,
			aiSearchBaseURL: "https://api.openai.com",
			aiSearchApiKey: "sk-xxx",
			aiSearchModel: "gpt",
			aiSearchShowReason: false,
			embeddingSource: "api",
			embeddingBaseURL: "",
			embeddingApiKey: "",
			embeddingModel: "",
			embeddingLocalModel: "",
			embeddingLocalWasmPaths: "",
			embeddingRemoteHost: "",
			querySamplingEnabled: false,
			querySamplingEndpoint: "",
			querySamplingRate: 0,
		},
		plugins: [{ id: "p1", name: "P1", description: "d", downloads: 1, updated: 2 }],
		selectedCategories: [] as string[],
		showAIConfigGuide: vi.fn(),
		ensureDataLoaded: vi.fn(() => Promise.resolve(true)),
		buildLocalIndex: vi.fn(() => Promise.resolve()),
		saveVectorIndex: vi.fn(() => Promise.resolve()),
		renderPluginList: vi.fn(),
		translator,
		plugin: { localModelState: { status: "ready", loaded: 0, total: 0 } },
		manifest: { version: "1.0.0" },
		t: vi.fn((k: string, v?: Record<string, string>) => (v ? `${k}:${JSON.stringify(v)}` : k)),
		aiSearchQueryCache: "",
		aiSearchResult: undefined,
		lastAiSearchResult: undefined,
		lastAiSearchQuery: undefined,
	};
	return { ...base, ...over } as unknown as ViewContext;
}

const input = () => document.createElement("input");
const badge = () => document.createElement("div");

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runAISearch：早退守卫", () => {
	it("aiSearchPending 为真 → 直接返回（28）", async () => {
		const c = makeCtx({ aiSearchPending: true }) as unknown as ViewContext & { translator: any };
		await runAISearch(c, input(), badge());
		expect(c.translator.aiSearch).not.toHaveBeenCalled();
	});

	it("空查询（空白）→ 直接返回（29-30）", async () => {
		const c = makeCtx({ searchQuery: "   " }) as unknown as ViewContext & { translator: any };
		await runAISearch(c, input(), badge());
		expect(c.translator.aiSearch).not.toHaveBeenCalled();
	});

	it("AI 模式但 aiSearchEnabled 关 → showAIConfigGuide('disabled') 返回（38-41）", async () => {
		const c = makeCtx({ settings: { ...makeCtx().settings, aiSearchEnabled: false } }) as any;
		await runAISearch(c, input(), badge());
		expect(c.showAIConfigGuide).toHaveBeenCalledWith("disabled");
		expect(c.translator.aiSearch).not.toHaveBeenCalled();
	});

	it("AI 模式但鉴权不可用 → showAIConfigGuide('noKey') 返回（42-45）", async () => {
		vi.mocked(isAISearchUsable).mockReturnValue(false);
		const c = makeCtx() as any;
		await runAISearch(c, input(), badge());
		expect(c.showAIConfigGuide).toHaveBeenCalledWith("noKey");
		vi.mocked(isAISearchUsable).mockReturnValue(true);
	});

	it("无插件数据且 ensureDataLoaded 失败 → Notice + 返回（48-54）", async () => {
		const c = makeCtx({ plugins: [], ensureDataLoaded: vi.fn(() => Promise.resolve(false)) }) as any;
		await runAISearch(c, input(), badge());
		expect(c.translator.aiSearch).not.toHaveBeenCalled();
		// 数据加载失败在 try/finally 之前提前返回，不触发 renderPluginList，也不置 pending
		expect(c.aiSearchPending).toBe(false);
	});
});

describe("runAISearch：AI 模式成功/分支", () => {
	it("成功 → 写回 aiSearchResult/缓存 + badge done + saveVectorIndex + 重绘（134-201）", async () => {
		const c = makeCtx() as any;
		c.translator.aiSearch.mockResolvedValue({ rankedIds: [1, 2, 3], rankFallback: false });
		const b = badge();
		await runAISearch(c, input(), b);
		expect(c.aiSearchResult.rankedIds.length).toBe(3);
		expect(c.lastAiSearchResult).toBeDefined();
		expect(c.lastAiSearchQuery).toBe("hello");
		expect(b.className).toBe("pt-ai-badge pt-ai-done");
		expect(b.textContent).toBe("AI");
		expect(c.saveVectorIndex).toHaveBeenCalled();
		expect(c.renderPluginList).toHaveBeenCalled();
		expect(c.aiSearchPending).toBe(false);
	});

	it("rankFallback → 标题提示降级排序（179-190）", async () => {
		const c = makeCtx() as any;
		c.translator.aiSearch.mockResolvedValue({ rankedIds: [9], rankFallback: true });
		const b = badge();
		await runAISearch(c, input(), b);
		expect(b.getAttribute("title")).toContain("本地相关度排序");
	});

	it("embeddingSource=keyword → 不落盘向量索引（198-201）", async () => {
		const c = makeCtx({ settings: { ...makeCtx().settings, embeddingSource: "keyword" } }) as any;
		c.translator.aiSearch.mockResolvedValue({ rankedIds: [1], rankFallback: false });
		await runAISearch(c, input(), badge());
		expect(c.saveVectorIndex).not.toHaveBeenCalled();
	});
});

describe("runAISearch：本地模式", () => {
	it("成功 → badge 显示「本地」（135-178）", async () => {
		const c = makeCtx({ searchMode: "local" }) as any;
		c.translator.aiSearchLocal.mockResolvedValue({ rankedIds: [5], rankFallback: false });
		const b = badge();
		await runAISearch(c, input(), b);
		expect(b.textContent).toBe("本地");
		expect(b.getAttribute("title")).toBe("本地语义检索完成");
		expect(c.translator.aiSearchLocal).toHaveBeenCalled();
	});

	it("无向量索引 → 提示正在建索引（107-109）", async () => {
		const c = makeCtx({ searchMode: "local" }) as any;
		c.translator.getVectorIndex.mockReturnValue(null);
		c.translator.aiSearchLocal.mockResolvedValue({ rankedIds: [5], rankFallback: false });
		// 仅验证不抛错并走完（Notice 为 no-op）
		await runAISearch(c, input(), badge());
		expect(c.aiSearchResult).toBeDefined();
	});

	it("embedding=local 且索引缺失 → 先 buildLocalIndex（126-132）", async () => {
		const c = makeCtx({ searchMode: "local", settings: { ...makeCtx().settings, embeddingSource: "local" } }) as any;
		c.translator.getVectorIndex.mockReturnValue(null);
		c.translator.aiSearchLocal.mockResolvedValue({ rankedIds: [5], rankFallback: false });
		await runAISearch(c, input(), badge());
		expect(c.buildLocalIndex).toHaveBeenCalledWith(false);
	});
});

describe("runAISearch：异常路径与收尾", () => {
	it("aiSearch 抛错 → 捕获、badge ready、aiSearchResult 置空（202-221）", async () => {
		const c = makeCtx() as any;
		c.translator.aiSearch.mockRejectedValue(new Error("boom"));
		const b = badge();
		await runAISearch(c, input(), b);
		expect(c.aiSearchResult).toBeNull();
		expect(b.className).toBe("pt-ai-badge pt-ai-ready");
		expect(b.getAttribute("title")).toContain("AI 排序失败");
		expect(c.aiSearchPending).toBe(false);
		expect(c.renderPluginList).toHaveBeenCalled();
	});

	it("异常 NO_API_KEY → 专用提示文案（208-212）", async () => {
		const c = makeCtx() as any;
		c.translator.aiSearch.mockRejectedValue(new Error("NO_API_KEY"));
		const b = badge();
		await runAISearch(c, input(), b);
		expect(b.className).toBe("pt-ai-badge pt-ai-ready");
	});

	it("finally 始终清理 loading 态（222-230）", async () => {
		const c = makeCtx() as any;
		const inp = input();
		c.translator.aiSearch.mockResolvedValue({ rankedIds: [1], rankFallback: false });
		await runAISearch(c, inp, badge());
		expect(inp.classList.contains("ai-loading")).toBe(false);
		expect(c.aiSearchPending).toBe(false);
	});
});

describe("本地模型进度条（239-267）", () => {
	it("本地未就绪 → 挂载 <progress> 并轮询更新百分比", async () => {
		vi.useFakeTimers();
		const c = makeCtx({ searchMode: "local" }) as any;
		c.plugin.localModelState = { status: "downloading", loaded: 50, total: 100 };
		c.translator.getVectorIndex.mockReturnValue(null);
		let resolveSearch!: (v: unknown) => void;
		c.translator.aiSearchLocal.mockReturnValue(new Promise((res) => (resolveSearch = res)));
		const field = document.createElement("div");
		field.className = "pt-search-field";
		const inp = document.createElement("input");
		field.appendChild(inp);
		const b = badge();
		const p = runAISearch(c, inp, b);
		vi.advanceTimersByTime(160);
		const progress = field.querySelector("progress") as HTMLProgressElement | null;
		expect(progress).not.toBeNull();
		expect(progress!.value).toBe(50);
		expect(b.textContent).toContain("50%");
		resolveSearch({ rankedIds: [], rankFallback: false });
		await p;
		vi.useRealTimers();
	});
});

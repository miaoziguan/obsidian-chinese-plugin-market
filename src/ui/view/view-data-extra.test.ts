import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ViewContext } from "./view-context";
import {
	disposeViewDataCache,
	reportNewPluginDelta,
	refreshData,
	refreshOutdated,
	aiTranslateAllPending,
	setAIProgressDone,
	refreshCardTranslation,
} from "./view-data";
import { Notice } from "obsidian";

/**
 * view-data.ts 的「数据管线副作用」部分。
 *
 * 原 view-data.test.ts 已覆盖纯逻辑（ensureDataLoaded / buildSearchIndex /
 * buildAuthorFacet / snapshotInstalled / mergeStats* / applySearchInput /
 * renderAuthorFacet / toggleAuthorFilter 等），但以下 6 个带副作用的函数
 * 此前完全没跑到（约 360 条未覆盖语句）：
 *   - disposeViewDataCache（卸载清缓存）
 *   - reportNewPluginDelta（新增插件增量提示）
 *   - refreshData（手动刷新全管线，竞态修复 + 覆盖度统计 + 落盘）
 *   - refreshOutdated（可更新检测，并发 + 撤销旧标记修复）
 *   - aiTranslateAllPending（批量混合翻译，rAF 节流回填）
 *   - setAIProgressDone / refreshCardTranslation（进度与卡片就地更新）
 *
 * 错误模式多为「列表状态与持久层不同步」：刷新中并发两次拉取互相覆盖、
 * 更新成功后仍报「有更新」、翻译结果因防抖定时器未触发而静默丢失。
 * 都不抛错，靠覆盖率漏斗才抓得到。
 */

vi.mock("@shared/utils", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@shared/utils")>();
	return { ...actual, computePluginDelta: vi.fn() };
});
vi.mock("@domain/catalog/mirror", () => ({
	classifyNetworkError: vi.fn(() => ({ kind: "blocked", message: "网络错误", suggestMirror: false })),
}));
vi.mock("@domain/compare/plugin-insight", () => ({
	fetchManifest: vi.fn(),
}));
vi.mock("@shared/version", () => ({
	compareVersion: vi.fn((a: string, b: string) => (a > b ? 1 : a < b ? -1 : 0)),
}));
vi.mock("@shared/platform", () => ({
	requestIdle: vi.fn((cb: () => void) => {
		cb();
		return 0;
	}),
}));
vi.mock("@translation/lexicon/dictionary", () => ({
	computeCoverage: vi.fn(() => ({ coverage: 1 })),
}));
vi.mock("obsidian", async (importOriginal) => {
	const actual = await importOriginal<typeof import("obsidian")>();
	return { ...actual, Notice: vi.fn().mockImplementation((msg?: string) => ({ message: msg })) };
});

import { computePluginDelta } from "@shared/utils";
import { classifyNetworkError } from "@domain/catalog/mirror";
import { fetchManifest } from "@domain/compare/plugin-insight";
import { compareVersion } from "@shared/version";

/** 补齐 Obsidian 挂在 Element 实例上的构造/文本方法（与原有测试一致，不改共享 setup）。 */
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	const mk = (tag: string, o?: { cls?: string; text?: string } | string): HTMLElement => {
		const el = document.createElement(tag);
		if (typeof o === "string") el.textContent = o;
		else if (o) {
			if (o.cls) el.className = o.cls;
			if (o.text != null) el.textContent = o.text;
		}
		return el;
	};
	if (!proto.createEl) proto.createEl = function (this: HTMLElement, tag: string, o?: unknown) { const el = mk(tag, o as never); this.appendChild(el); return el; };
	if (!proto.createDiv) proto.createDiv = function (this: HTMLElement, o?: unknown) { return (this as never as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("div", o); };
	if (!proto.createSpan) proto.createSpan = function (this: HTMLElement, o?: unknown) { return (this as never as { createEl: (t: string, o?: unknown) => HTMLElement }).createEl("span", o); };
	if (!proto.setText) proto.setText = function (this: HTMLElement, text: string): void { this.textContent = text; };
	if (!proto.setCssStyles) proto.setCssStyles = function (this: HTMLElement, s: Record<string, string>): void { for (const [k, v] of Object.entries(s)) this.style.setProperty(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), v); };
}
ensureDomHelpers();

// jsdom 未提供 CSS.escape（refreshCardTranslation 用它拼选择器），补齐
if (!(window as unknown as { CSS?: { escape?: unknown } }).CSS) {
	(window as unknown as { CSS: { escape: (s: string) => string } }).CSS = { escape: (s: string) => s };
} else if (!(window as unknown as { CSS: { escape?: unknown } }).CSS.escape) {
	(window as unknown as { CSS: { escape: (s: string) => string } }).CSS.escape = (s: string) => s;
}

type Ctx = Record<string, unknown>;

const plugin = (id: string, over: Record<string, unknown> = {}) => ({ id, name: `插件${id}`, repo: `repo/${id}`, ...over });

function makeCtx(over: Ctx = {}): ViewContext {
	const translator = {
		getData: vi.fn(() => ({ cache: {} })),
		mergeOffline: vi.fn((_list: unknown) => ({ results: {} })),
		recordCoverage: vi.fn(),
		tmApproved: new Set<string>(),
		saveTranslatorData: vi.fn(),
		flushTranslatorData: vi.fn(),
		aiSearcher: { getBm25Index: vi.fn() },
		translateBatchIncremental: vi.fn(),
	} as Ctx;
	const base: Ctx = {
		plugins: [] as unknown[],
		visibleList: [] as unknown[],
		translatedResults: {},
		statsMap: new Map(),
		pluginsRev: 0,
		pluginMap: null,
		pluginMapSrc: null,
		searchIndex: new Map(),
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		installedVersions: new Map(),
		outdatedIds: new Set<string>(),
		outdatedInfo: new Map(),
		filterCache: { reset: vi.fn() },
		installFilter: "all",
		settings: { mirrorSource: "auto", mirrorCustomBase: "" },
		app: {},
		t: (k: string, vars?: Record<string, string>) => (vars ? `${k}:${JSON.stringify(vars)}` : k),
		refreshBtn: null,
		lastListFetchAt: null,
		translator,
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		plugin: { scheduleIndexRefresh: vi.fn() },
		mirrorConfig: vi.fn(() => ({ source: "auto", customBase: "" })),
		buildSearchIndex: vi.fn(),
		scheduleRender: vi.fn(),
		seenPluginIds: new Set<string>(),
		firstSeenMap: new Map<string, number>(),
		aiTranslateRunning: false,
		translatedThisSession: 0,
		...over,
	};
	return base as unknown as ViewContext;
}

const btn = () => ({ disabled: false, addClass: vi.fn(), removeClass: vi.fn() } as unknown as Ctx);

beforeEach(() => {
	vi.mocked(classifyNetworkError).mockReturnValue({ kind: "blocked", message: "网络错误", suggestMirror: false });
	vi.mocked(fetchManifest).mockImplementation(async () => ({ version: "2.0.0" }));
	vi.mocked(compareVersion).mockImplementation((a: string, b: string) => (a > b ? 1 : a < b ? -1 : 0));
	vi.mocked(computePluginDelta).mockImplementation((_cur, _seen, _src) => ({ newIds: [], translated: 0, untranslated: 0, isFirstLoad: false }));
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("disposeViewDataCache：卸载清缓存", () => {
	it("把 pluginMap / pluginMapSrc 置空（释放 5617 条映射）", () => {
		const ctx = makeCtx({ pluginMap: new Map([["a", plugin("a")]]), pluginMapSrc: 3 });
		disposeViewDataCache(ctx);
		expect((ctx as unknown as { pluginMap: unknown }).pluginMap).toBeNull();
		expect((ctx as unknown as { pluginMapSrc: unknown }).pluginMapSrc).toBeNull();
	});
});

describe("reportNewPluginDelta：新增插件增量提示", () => {
	it("首次加载或无新增 → 不弹提示", () => {
		const ctx = makeCtx({ seenPluginIds: new Set<string>() });
		vi.mocked(computePluginDelta).mockReturnValue({ newIds: [], translated: 0, untranslated: 0, isFirstLoad: true });
		reportNewPluginDelta(ctx, [plugin("a") as never], {});
		expect(Notice).not.toHaveBeenCalled();
	});

	it("有新增 → 弹组合提示，并维护 seen / firstSeenMap", () => {
		const ctx = makeCtx({ seenPluginIds: new Set<string>(["old"]) });
		vi.mocked(computePluginDelta).mockReturnValue({ newIds: ["a", "b"], translated: 1, untranslated: 1, isFirstLoad: false });
		reportNewPluginDelta(ctx, [plugin("a"), plugin("b"), plugin("old")] as never, { a: { source: "ai" } } as never);
		expect(Notice).toHaveBeenCalledTimes(1);
		// seen 集合更新为本轮全集
		expect((ctx as unknown as { seenPluginIds: Set<string> }).seenPluginIds).toEqual(new Set(["old", "a", "b"]));
		const fs = (ctx as unknown as { firstSeenMap: Map<string, number> }).firstSeenMap;
		expect(fs.has("a")).toBe(true); // 新 id 记时间戳
		expect(fs.has("old")).toBe(true); // 旧 id 保持 0
		expect(fs.get("old")).toBe(0);
	});
});

describe("refreshData：手动刷新全管线", () => {
	it("按钮不存在 / 已禁用 / 加载中 → 直接返回（竞态修复：忽略并发刷新）", async () => {
		const fetchPlugins = vi.fn().mockResolvedValue([]);
		// refreshBtn 为 null
		await refreshData(makeCtx({ fetchPlugins }));
		expect(fetchPlugins).not.toHaveBeenCalled();
		// 已禁用
		const b = btn();
		(b as unknown as { disabled: boolean }).disabled = true;
		await refreshData(makeCtx({ fetchPlugins, refreshBtn: b }));
		expect(fetchPlugins).not.toHaveBeenCalled();
		// 加载中
		await refreshData(makeCtx({ fetchPlugins, refreshBtn: btn(), dataLoading: true }));
		expect(fetchPlugins).not.toHaveBeenCalled();
	});

	it("成功路径：拉取 → 合并 → 落盘 → 重渲染，复位刷新锁", async () => {
		const data = [plugin("a"), plugin("b")];
		const fetchPlugins = vi.fn().mockResolvedValue(data);
		const cb = btn();
		const ctx = makeCtx({ fetchPlugins, refreshBtn: cb });
		// 把 refreshData 内部会调的 ctx 方法都做成 spy（确保按序执行不抛错）
		for (const m of ["buildAuthorFacet", "mergeStatsFromCache", "snapshotInstalled", "reportNewPluginDelta",
			"updateRefreshTooltip", "buildSearchIndex", "renderAuthorFacet", "updateFacetVisibility",
			"scheduleRender", "applyAIConfig", "saveTranslatorData"] as const) {
			(ctx as unknown as Record<string, unknown>)[m] = vi.fn();
		}
		// fetchStatsAndMerge 是 fire-and-forget（内部 .then），必须返回 resolved promise 才不会抛错被 catch 吞掉
		(ctx as unknown as Record<string, unknown>).fetchStatsAndMerge = vi.fn().mockResolvedValue(undefined);
		await refreshData(ctx);
		expect((ctx as unknown as { plugins: unknown[] }).plugins).toBe(data);
		expect((ctx as unknown as Record<string, unknown>).buildAuthorFacet).toHaveBeenCalled();
		expect((ctx as unknown as Record<string, unknown>).snapshotInstalled).toHaveBeenCalled();
		expect((ctx as unknown as Record<string, unknown>).reportNewPluginDelta).toHaveBeenCalledWith(data, ctx.translatedResults);
		expect((ctx as unknown as Record<string, unknown>).saveTranslatorData).toHaveBeenCalled();
		expect((ctx as unknown as { dataLoaded: boolean }).dataLoaded).toBe(true);
		expect((ctx as unknown as { lastListFetchAt: number }).lastListFetchAt).toBeGreaterThan(0);
		expect((ctx as unknown as Record<string, unknown>).scheduleRender).toHaveBeenCalled();
		expect(Notice).toHaveBeenCalledWith("action.refresh.done");
		expect((cb as unknown as { disabled: boolean }).disabled).toBe(false); // 锁复位
	});

	it("失败路径：保留已加载数据，仅复位锁，弹网络错误提示", async () => {
		const fetchPlugins = vi.fn().mockRejectedValue(new Error("boom"));
		vi.mocked(classifyNetworkError).mockReturnValue({ kind: "blocked", message: "被拦截", suggestMirror: false });
		const ctx = makeCtx({ fetchPlugins, refreshBtn: btn(), plugins: [plugin("x")] });
		await refreshData(ctx);
		// 已有数据 → dataLoaded 仍为真
		expect((ctx as unknown as { dataLoaded: boolean }).dataLoaded).toBe(true);
		expect(Notice).toHaveBeenCalledWith("action.refresh：被拦截");
	});
});

describe("refreshOutdated：可更新检测", () => {
	it("无可装版本 → 早退（不发起网络请求）", async () => {
		const ctx = makeCtx({ installedVersions: new Map() });
		await refreshOutdated(ctx);
		expect(fetchManifest).not.toHaveBeenCalled();
	});

	it("已固定版本的插件：撤销旧标记并跳过检测", async () => {
		const ctx = makeCtx({
			installedVersions: new Map([["a", "1.0.0"]]),
			plugins: [plugin("a", { repo: "repo/a" })],
			pluginVersionPins: { a: "1.0.0" },
			outdatedIds: new Set(["a"]),
			outdatedInfo: new Map([["a", { local: "1.0.0", latest: "2.0.0" }]]),
		});
		await refreshOutdated(ctx);
		expect(fetchManifest).not.toHaveBeenCalled();
		expect((ctx as unknown as { outdatedIds: Set<string> }).outdatedIds.has("a")).toBe(false);
	});

	it("有新版 → 登记可更新；版本未变 → 撤销旧标记（修复「更新后仍报有更新」）", async () => {
		const ctx = makeCtx({
			installedVersions: new Map([["a", "1.0.0"], ["b", "2.0.0"], ["c", "1.0.0"]]),
			plugins: [plugin("a", { repo: "repo/a" }), plugin("b", { repo: "repo/b" }), plugin("c", { repo: "repo/c" })],
			outdatedIds: new Set(["b", "c"]), // b/c 的旧标记应被撤销
		});
		// a→2.0.0(新)  b→2.0.0(同)  c→1.0.0(旧)
		vi.mocked(fetchManifest).mockImplementation(async (repo: string) => {
			if (repo === "repo/a") return { version: "2.0.0" };
			if (repo === "repo/b") return { version: "2.0.0" };
			return { version: "1.0.0" };
		});
		await refreshOutdated(ctx);
		const ids = (ctx as unknown as { outdatedIds: Set<string> }).outdatedIds;
		expect(ids.has("a")).toBe(true);
		expect(ids.has("b")).toBe(false); // 版本未变 → 撤销
		expect(ids.has("c")).toBe(false); // 仍落后但已被覆盖为旧版 → 撤销旧标记
	});

	it("拉取单个 manifest 失败 → 容错跳过，不影响整体", async () => {
		const ctx = makeCtx({
			installedVersions: new Map([["a", "1.0.0"]]),
			plugins: [plugin("a", { repo: "repo/a" })],
		});
		vi.mocked(fetchManifest).mockRejectedValue(new Error("timeout"));
		await expect(refreshOutdated(ctx)).resolves.toBeUndefined();
		expect((ctx as unknown as { outdatedIds: Set<string> }).outdatedIds.has("a")).toBe(false);
	});

	it("无「已装且有仓库」的插件 → 早退", async () => {
		const ctx = makeCtx({ installedVersions: new Map([["a", "1.0.0"]]), plugins: [plugin("a", { repo: undefined })] }); // a 无 repo
		await refreshOutdated(ctx);
		expect(fetchManifest).not.toHaveBeenCalled();
	});
});

describe("aiTranslateAllPending：批量混合翻译", () => {
	beforeEach(() => {
		// rAF 同步执行，去掉计时不确定性
		vi.stubGlobal("requestAnimationFrame", (cb: (t: number) => void) => { cb(0); return 1; });
		vi.stubGlobal("cancelAnimationFrame", () => {});
	});
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("正在翻译中 → 跳过本次点击（防并发）", async () => {
		const ctx = makeCtx({ aiTranslateRunning: true, visibleList: [plugin("a")] });
		await aiTranslateAllPending(ctx);
		expect((ctx.translator as unknown as Ctx).translateBatchIncremental).not.toHaveBeenCalled();
	});

	it("无需翻译（全部已译）→ 直接 setAIProgressDone(0)", async () => {
		const ctx = makeCtx({ visibleList: [plugin("a")], isTranslated: vi.fn(() => true) });
		(ctx as unknown as Record<string, unknown>).setAIProgressDone = vi.fn();
		await aiTranslateAllPending(ctx);
		expect((ctx as unknown as Record<string, unknown>).setAIProgressDone).toHaveBeenCalledWith(0);
		expect((ctx.translator as unknown as Ctx).translateBatchIncremental).not.toHaveBeenCalled();
	});

	it("有pending → 批量翻译，rAF 节流回填译文字段并落盘", async () => {
		const cache = { a: { source: "ai", translatedName: "甲", translatedDesc: "乙" } };
		const ctx = makeCtx({
			visibleList: [plugin("a")],
			isTranslated: vi.fn(() => false),
			translator: {
				getData: vi.fn(() => ({ cache })),
				translateBatchIncremental: vi.fn((_list: unknown, onProgress: (d: number, t: number) => void) => { onProgress(1, 1); return Promise.resolve(); }),
				aiSearcher: { getBm25Index: vi.fn() },
			},
		});
		(ctx as unknown as Record<string, unknown>).setAIProgressDone = vi.fn();
		(ctx as unknown as Record<string, unknown>).updateStats = vi.fn();
		(ctx as unknown as Record<string, unknown>).refreshCardTranslation = vi.fn();
		(ctx as unknown as Record<string, unknown>).updateAiTranslateButton = vi.fn();
		(ctx as unknown as Record<string, unknown>).flushTranslatorData = vi.fn();
		await aiTranslateAllPending(ctx);
		// 译文回填进 translatedResults
		expect((ctx as unknown as { translatedResults: Record<string, unknown> }).translatedResults.a).toBe(cache.a);
		expect((ctx as unknown as Record<string, unknown>).refreshCardTranslation).toHaveBeenCalledWith("a", cache.a);
		expect((ctx as unknown as { translatedThisSession: number }).translatedThisSession).toBe(1);
		expect((ctx as unknown as Record<string, unknown>).flushTranslatorData).toHaveBeenCalled(); // 立即落盘（防防抖丢失）
		expect((ctx as unknown as Record<string, unknown>).setAIProgressDone).toHaveBeenCalledWith(1);
		expect((ctx as unknown as { aiTranslateRunning: boolean }).aiTranslateRunning).toBe(false); // 锁复位
	});
});

describe("setAIProgressDone：进度收尾", () => {
	beforeEach(() => { vi.useFakeTimers(); });
	afterEach(() => { vi.useRealTimers(); });

	it("无进度元素 → 直接返回", () => {
		const ctx = makeCtx();
		expect(() => setAIProgressDone(ctx, 3)).not.toThrow();
	});

	it("n=0 → 隐藏且不排程淡出定时器", () => {
		const el = { setCssStyles: vi.fn(), setText: vi.fn(), addClass: vi.fn() } as unknown as Ctx;
		setAIProgressDone(makeCtx({ aiProgressEl: el }), 0);
		expect(el.setCssStyles).toHaveBeenCalledWith({ display: "none" });
		expect(el.addClass).not.toHaveBeenCalled();
	});

	it("n>0 → 显示文案 + 播报，4s 后淡出", () => {
		const el = { setCssStyles: vi.fn(), setText: vi.fn(), addClass: vi.fn(), removeClass: vi.fn() } as unknown as Ctx;
		const announceStatus = vi.fn();
		setAIProgressDone(makeCtx({ aiProgressEl: el, announceStatus }), 5);
		expect(el.setText).toHaveBeenCalledWith("ai.translate.done:{\"n\":\"5\"}");
		expect(announceStatus).toHaveBeenCalled();
		expect(el.addClass).toHaveBeenCalledWith("pt-ai-progress--done");
		vi.advanceTimersByTime(4000);
		expect(el.setCssStyles).toHaveBeenCalledWith({ display: "none" });
		expect(el.removeClass).toHaveBeenCalledWith("pt-ai-progress--done");
	});
});

describe("refreshCardTranslation：卡片译文就地更新", () => {
	it("无卡片层 → 直接返回", () => {
		const ctx = makeCtx();
		expect(() => refreshCardTranslation(ctx, "a", { translatedName: "甲", translatedDesc: "乙", source: "ai" } as never)).not.toThrow();
	});

	it("找不到对应卡片 → 返回", () => {
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollCardLayer: layer, plugins: [plugin("a")] });
		expect(() => refreshCardTranslation(ctx, "nope", { translatedName: "甲", translatedDesc: "乙", source: "ai" } as never)).not.toThrow();
	});

	it("命中卡片 → 更新名称/描述、撤掉 pending 态，并按 source 切换副标", () => {
		const layer = document.createElement("div");
		const card = document.createElement("div");
		card.className = "pt-card";
		card.setAttribute("data-plugin-id", "a");
		const name = document.createElement("span"); name.className = "pt-card-name";
		const desc = document.createElement("span"); desc.className = "pt-card-desc pt-desc-pending";
		const sub = document.createElement("span"); sub.className = "pt-card-original-name";
		card.append(name, desc, sub);
		layer.appendChild(card);
		const ctx = makeCtx({ scrollCardLayer: layer, plugins: [plugin("a")] });

		refreshCardTranslation(ctx, "a", { translatedName: "甲", translatedDesc: "乙", source: "ai" } as never);
		expect(name.textContent).toBe("甲");
		expect(desc.textContent).toBe("乙");
		expect(desc.classList.contains("pt-desc-pending")).toBe(false);
		expect(sub.textContent).toBe("插件a"); // 非 original → 副标显示原名

		refreshCardTranslation(ctx, "a", { translatedName: "甲", translatedDesc: "乙", source: "original" } as never);
		expect(sub.textContent).toBe("card.original.hint");
		expect(sub.className).toBe("pt-card-original-name pt-card-untranslated-hint");
	});
});

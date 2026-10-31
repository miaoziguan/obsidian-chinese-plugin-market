import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "./view-context";

/**
 * 专门补 view-cards.ts 里「事件委托与入口函数」的覆盖缺口。
 *
 * 既有 view-cards.test.ts / view-cards-interaction.test.ts 把 ctx.flashAction /
 * ctx.openDetailDrawer 等都 mock 成 vi.fn()，导致这 4 个真实函数体（openDetailDrawer、
 * computeSimilarFor、flashAction、openInsightModal）一行没跑到；onCardClick 也只覆盖了
 * copy/compare/detail/review/author/favorite/market/uninstall，漏了 insight / toggle-enabled /
 * favorite-取消无卡片 三个分支，onCardKeydown 漏了 Enter 开详情与 PageDown/PageUp。
 *
 * 本文件直接调用真实函数、对依赖做轻量 mock，把上述缺口吃掉。
 */

const drawerMock = vi.hoisted(() => ({ last: null as unknown, instances: [] as unknown[] }));
vi.mock("@ui/components/detail-drawer", () => ({
	PluginDetailDrawer: class {
		navigate = vi.fn();
		focusJournalArea = vi.fn();
		setSimilar = vi.fn();
		open = vi.fn();
		currentPluginId: string | null = null;
		constructor(opts: unknown) {
			drawerMock.last = opts;
			drawerMock.instances.push(this);
		}
	},
}));

const similarMock = vi.hoisted(() => ({ computeSimilar: vi.fn(() => []) }));
vi.mock("@domain/recommend/similar", () => similarMock);

const installerMock = vi.hoisted(() => ({
	installCommunityPlugin: vi.fn(async () => true),
	togglePluginEnabled: vi.fn(async () => true),
	uninstallCommunityPlugin: vi.fn(async () => true),
}));
vi.mock("@data/platform/plugin-installer", () => installerMock);

let cards: typeof import("./view-cards");

beforeEach(async () => {
	vi.clearAllMocks();
	drawerMock.last = null;
	drawerMock.instances = [];
	similarMock.computeSimilar = vi.fn(() => []);
	// jsdom 无 navigator.clipboard，onCardClick 的 copy 分支会 TypeError
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn().mockResolvedValue(undefined) },
		configurable: true,
	});
	vi.useFakeTimers({
		toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "setImmediate", "clearImmediate", "requestAnimationFrame", "cancelAnimationFrame"],
	});
	cards = await import("./view-cards");
});

afterEach(() => {
	vi.useRealTimers();
});

const plugin = (id = "p1", over: Partial<PluginInfo> = {}): PluginInfo => ({
	id,
	name: `插件${id}`,
	description: "",
	author: `作者-${id}`,
	...over,
});

type Ctx = Record<string, unknown>;

function makeCtx(over: Ctx = {}): ViewContext {
	const ctx: Ctx = {
		app: { setting: { openTabById: vi.fn() } },
		plugin: { id: "chinese-plugin-market", version: "1.0.0" } as never,
		contentEl: document.createElement("div"),
		t: (k: string) => k,
		translator: { enqueueOnlineTM: vi.fn() },
		translatedResults: {},
		plugins: [plugin("p1"), plugin("p2")],
		visibleList: [plugin("p1"), plugin("p2")],
		installedIds: new Set<string>(),
		installingIds: new Set<string>(),
		favoritesSet: new Set<string>(),
		enabledIds: new Set<string>(),
		installedVersions: new Map<string, string>(),
		allPlugins: [plugin("p1"), plugin("p2")],
		compareSet: new Set<string>(),
		compareMode: false,
		activeDrawer: undefined,
		colCount: 2,
		focusedCardIdx: 0,
		defaultRowH: 120,
		rowGap: 12,
		installFilter: "all",
		settings: { compare: [], favorites: [], favoriteGroupOf: {} } as never,
		pluginVersionPins: undefined,
		pluginDeps: undefined,
		listPluginVersions: vi.fn(async () => []),
		pinPluginVersion: vi.fn(),
		openDetailDrawer: vi.fn(),
		exitCompareMode: vi.fn(),
		enterDetailMode: vi.fn(),
		exitDetailMode: vi.fn(),
		toggleFavorite: vi.fn(() => true),
		refreshCardState: vi.fn(),
		snapshotInstalled: vi.fn(),
		flushSaveSettings: vi.fn(async () => {}),
		invalidateAndRender: vi.fn(),
		scheduleRender: vi.fn(),
		flashAction: vi.fn(),
		openInsightModal: vi.fn(),
		computeSimilarFor: vi.fn(() => []),
		...over,
	};
	return ctx as unknown as ViewContext;
}

describe("openDetailDrawer：复用/新建 + 互斥/焦点", () => {
	it("无活动抽屉 → 新建 PluginDetailDrawer、置 activeDrawer、进详情态、open", () => {
		const ctx = makeCtx();
		cards.openDetailDrawer(ctx, "p1");
		expect(ctx.activeDrawer).toBeTruthy();
		expect(ctx.enterDetailMode).toHaveBeenCalled();
		const inst = drawerMock.instances.at(-1) as { open: ReturnType<typeof vi.fn> };
		expect(inst.open).toHaveBeenCalled();
		// 选项里注入了依赖端口
		const opts = drawerMock.last as Record<string, unknown>;
		expect(opts.mode).toBe("page");
		expect(opts.container).toBe(ctx.contentEl);
	});

	it("对比模式下打开详情 → 先退出对比模式", () => {
		const ctx = makeCtx({ compareMode: true });
		cards.openDetailDrawer(ctx, "p1");
		expect(ctx.exitCompareMode).toHaveBeenCalled();
	});

	it("已有活动抽屉 → 复用 navigate，并回填相似推荐（rAF 后才算，避免阻塞打开帧）", async () => {
		const active = {
			navigate: vi.fn(),
			focusJournalArea: vi.fn(),
			setSimilar: vi.fn(),
			currentPluginId: "p1",
		} as unknown as Record<string, unknown> & { currentPluginId: string };
		const ctx = makeCtx({ activeDrawer: active, computeSimilarFor: vi.fn(() => [{ id: "p2" }]) });
		cards.openDetailDrawer(ctx, "p1");
		expect(active.navigate).toHaveBeenCalledWith("p1", expect.objectContaining({ id: "p1" }), undefined, []);
		// 推进双 rAF，fillSimilar 回调应执行并回填相似推荐
		await vi.advanceTimersByTimeAsync(50);
		expect(active.setSimilar).toHaveBeenCalledWith([{ id: "p2" }]);
	});

	it("focusJournal=true → 复用路径下聚焦评测区", () => {
		const active = {
			navigate: vi.fn(),
			focusJournalArea: vi.fn(),
			setSimilar: vi.fn(),
			currentPluginId: "p1",
		} as unknown as Record<string, unknown> & { currentPluginId: string };
		const ctx = makeCtx({ activeDrawer: active });
		cards.openDetailDrawer(ctx, "p1", null, true);
		expect(active.focusJournalArea).toHaveBeenCalled();
	});

	it("找不到插件 → 安全返回（不建抽屉）", () => {
		const ctx = makeCtx();
		cards.openDetailDrawer(ctx, "nope");
		expect(ctx.activeDrawer).toBeUndefined();
		expect(ctx.enterDetailMode).not.toHaveBeenCalled();
	});
});

describe("computeSimilarFor：标签索引打分", () => {
	it("无 tagService 或列表为空 → 返回 []（不崩溃）", () => {
		const ctx = makeCtx({ translator: { enqueueOnlineTM: vi.fn() } });
		expect(cards.computeSimilarFor(ctx, plugin("p1"))).toEqual([]);
	});

	it("有 tagService + 候选 → 调 computeSimilar 返回结果", () => {
		const tagService = { getAllTags: vi.fn(() => ({ p2: { category: "x", tags: ["a"] } })) };
		const ctx = makeCtx({ translator: { tagService, enqueueOnlineTM: vi.fn() } });
		similarMock.computeSimilar = vi.fn(() => [{ id: "p2" }] as never);
		const r = cards.computeSimilarFor(ctx, plugin("p1"));
		expect(similarMock.computeSimilar).toHaveBeenCalled();
		expect(r).toEqual([{ id: "p2" }]);
	});

	it("invertedIndex 未 build → 先懒 build 一次（避免重复开销）", () => {
		const tagService = { getAllTags: vi.fn(() => ({ p2: { category: "x", tags: ["a"] } })) };
		const idx = { isBuilt: false, build: vi.fn() };
		const ctx = makeCtx({ translator: { tagService, enqueueOnlineTM: vi.fn() }, invertedIndex: idx });
		similarMock.computeSimilar = vi.fn(() => []);
		cards.computeSimilarFor(ctx, plugin("p1"));
		expect(idx.build).toHaveBeenCalled();
	});

	it("invertedIndex 已 build → 跳过 build（保底逻辑）", () => {
		const tagService = { getAllTags: vi.fn(() => ({ p2: { category: "x", tags: ["a"] } })) };
		const idx = { isBuilt: true, build: vi.fn() };
		const ctx = makeCtx({ translator: { tagService, enqueueOnlineTM: vi.fn() }, invertedIndex: idx });
		similarMock.computeSimilar = vi.fn(() => []);
		cards.computeSimilarFor(ctx, plugin("p1"));
		expect(idx.build).not.toHaveBeenCalled();
	});
});

describe("flashAction：一次性完成态脉冲", () => {
	it("先加 done 类，1.2s 后自动移除", () => {
		const btn = document.createElement("button");
		cards.flashAction(makeCtx(), btn);
		expect(btn.classList.contains("pt-icon-btn--done")).toBe(true);
		vi.advanceTimersByTime(1300);
		expect(btn.classList.contains("pt-icon-btn--done")).toBe(false);
	});
});

describe("onCardClick：补遗漏分支（insight / toggle-enabled / favorite-取消无卡片）", () => {
	function cardWith(action: string, cardClass = "pt-card--clickable") {
		const el = document.createElement("div");
		el.className = cardClass;
		el.setAttribute("data-plugin-id", "p1");
		const btn = document.createElement("button");
		btn.setAttribute("data-action", action);
		el.appendChild(btn);
		document.body.appendChild(el);
		return { el, btn };
	}

	it("toggle-enabled 分支 → 走到 handleToggleEnabled（加锁→切换→释放）", async () => {
		const ctx = makeCtx({ installingIds: new Set<string>() });
		const { btn } = cardWith("toggle-enabled");
		const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
		btn.dispatchEvent(ev);
		cards.onCardClick(ctx, ev);
		// handleToggleEnabled 是 fire-and-forget，flush 微任务
		await Promise.resolve();
		await Promise.resolve();
		expect(installerMock.togglePluginEnabled).toHaveBeenCalled();
		// installFilter="all" → finally 走 else 分支（仅原地刷新本卡，避免整列重渲抖动）
		expect(ctx.refreshCardState).toHaveBeenCalled();
		btn.parentElement!.remove();
	});

	it("favorite 取消且开启收藏置顶但无 .pt-card 容器 → 直接 scheduleRender(true)", () => {
		const ctx = makeCtx({
			favoritesSet: new Set(["p1"]),
			sortFavoritesFirst: true,
			toggleFavorite: vi.fn(() => false),
		});
		// 只用 pt-card--clickable（不含 .pt-card），使 actionEl.closest('.pt-card') 为 null
		const { btn } = cardWith("favorite");
		const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
		btn.dispatchEvent(ev);
		cards.onCardClick(ctx, ev);
		expect(ctx.toggleFavorite).toHaveBeenCalledWith("p1");
		expect(ctx.scheduleRender).toHaveBeenCalledWith(true);
		btn.parentElement!.remove();
	});
});

describe("onCardKeydown：补遗漏分支（Enter 开详情 / PageDown·PageUp 大跨度跳转）", () => {
	it("Enter → 打开当前聚焦卡的详情（含 layer 取卡）", () => {
		const openDetailDrawer = vi.fn();
		const ctx = makeCtx({
			openDetailDrawer,
			focusedCardIdx: 0,
			visibleList: [plugin("p1")],
			scrollCardLayer: document.createElement("div"),
		});
		cards.onCardKeydown(ctx, new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
		expect(openDetailDrawer).toHaveBeenCalledWith("p1", expect.any(Object));
	});

	it("PageDown / PageUp 按视口行数跳焦点（不越界）", () => {
		const focusCardByIdx = vi.fn();
		const viewport = document.createElement("div");
		const ctx = makeCtx({
			focusCardByIdx,
			focusedCardIdx: 0,
			visibleList: [plugin("p1"), plugin("p2"), plugin("p3")],
			colCount: 2,
			defaultRowH: 120,
			rowGap: 12,
			scrollViewport: viewport,
		});
		// clientHeight 默认 0，走兜底 600；rowH=(120+12)=132；jump=floor(600/132)*2=8
		cards.onCardKeydown(ctx, new KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true }));
		expect(focusCardByIdx).toHaveBeenCalled();
		expect(ctx.focusedCardIdx).toBe(2); // min(0+8, 2)
		// PageUp：从 2 跳回 0
		cards.onCardKeydown(ctx, new KeyboardEvent("keydown", { key: "PageUp", bubbles: true, cancelable: true }));
		expect(ctx.focusedCardIdx).toBe(0); // max(2-8, 0)
	});
});

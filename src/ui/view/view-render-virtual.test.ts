import { describe, it, expect, vi, beforeEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "./view-context";
import { renderWindow, updateWindow, fillVisibleWindow } from "./view-render";
import { applyCardState, createCardElement } from "@ui/components/card-render";
import { clearAllFilters } from "@ui/view/active-filters";
import { resolveEmptyState } from "@domain/filter/filter";

/**
 * 真·虚拟滚动渲染路径：renderWindow 的非空分支（399-533）、updateWindowImpl（558-627）、
 * fillVisibleWindow（683-717）——约 200 行，此前只覆盖了「无视口时降级」的早退分支。
 *
 * 这段的错误模式不是崩溃，而是**白屏 / 列表缺卡 / 读屏器报数差两个数量级**：
 * 例如全量重建前若不把 windowStart/End 置 -1，窗口守卫会误判「没越界」直接 return，
 * layer 只剩两个空 spacer；或 aria-posinset/setsize 没写，虚拟滚动下读屏器把
 * 5600 项的列表报成「共 ~窗口大小 项」。都不抛错，只让用户拿到坏界面。
 *
 * 为了断言确定、且不与 jsdom 的布局度量打架：
 * - computeWindowRange / computeSpacerHeights 用可控 mock（数学本身另有单测覆盖），
 *   这里只验证「窗口怎么被消费」：换入换出、spacer 高度、DOM 顺序。
 * - createCardElement / applyCardState 用 mock（真卡片渲染成本与本轮目标无关）。
 * - resolveEmptyState / activeFilters 用 mock：聚焦 renderWindow 的 DOM 行为，
 *   尤其是「清除筛选」按钮与跨模式桥接按钮这两个曾出过 bug 的交互。
 */

const vsMock = vi.hoisted(() => ({
	range: { start: 0, end: 2, firstRow: 0, lastRow: 0, totalRows: 1 } as {
		start: number;
		end: number;
		firstRow: number;
		lastRow: number;
		totalRows: number;
	},
	spacers: { top: 100, bottom: 200 } as { top: number; bottom: number },
}));

const emptyMock = vi.hoisted(() => ({
	state: {
		titleKey: "empty.noResult",
		hintKey: "empty.hint",
		showClearAction: false,
		bridgeAction: null as null | { labelKey: string; mode: string },
	},
}));

const idleMock = vi.hoisted(() => ({ tasks: [] as Array<() => void> }));

vi.mock("@shared/platform", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@shared/platform")>();
	return {
		...actual,
		requestIdle: (fn: () => void) => {
			idleMock.tasks.push(fn);
			return 1; // 非 null 句柄，符合 fillIdleHandle 的判空语义
		},
	};
});

vi.mock("@ui/dom/virtual-scroll", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ui/dom/virtual-scroll")>();
	return {
		...actual,
		computeWindowRange: vi.fn(() => vsMock.range),
		computeSpacerHeights: vi.fn(() => vsMock.spacers),
	};
});

vi.mock("@ui/components/card-render", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ui/components/card-render")>();
	return {
		...actual,
		createCardElement: vi.fn(() => document.createElement("div")),
		applyCardState: vi.fn(),
	};
});

vi.mock("@domain/filter/filter", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@domain/filter/filter")>();
	return {
		...actual,
		resolveEmptyState: vi.fn(() => emptyMock.state),
	};
});

vi.mock("@ui/view/active-filters", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@ui/view/active-filters")>();
	return { ...actual, activeFilters: vi.fn(() => [] as never[]), clearAllFilters: vi.fn() };
});

// Obsidian 全局：createFragment 在 setup.ts 里没提供（只给了 createEl/createDiv/createSpan），
// 而 updateWindowImpl 用它批量拼装窗口卡片。这里局部补齐，不动共享 setup。
if (!(window as unknown as { createFragment?: unknown }).createFragment) {
	(window as unknown as { createFragment: () => DocumentFragment }).createFragment = () =>
		document.createDocumentFragment();
}
if (!(window as unknown as { createDiv?: unknown }).createDiv) {
	(window as unknown as { createDiv: (o?: { cls?: string; text?: string }) => HTMLElement }).createDiv = (o) => {
		const el = document.createElement("div");
		if (o?.cls) el.className = o.cls;
		if (o?.text != null) el.textContent = o.text;
		return el;
	};
}
// Obsidian 也把这三个挂到 HTMLElement.prototype（源码以 layer.createDiv(...) 调用），
// 共享 setup 只给了全局函数。这里局部补齐，不动共享 setup（避免跨文件泄漏）。
type ElInfo = { cls?: string | string[]; text?: string } | string | undefined;
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

type Ctx = Record<string, unknown>;

const plugin = (id: string): PluginInfo => ({ id, name: `插件${id}`, description: "", author: "作者" } as PluginInfo);

const makeViewport = (clientHeight = 600, scrollTop = 0) => {
	const vp = document.createElement("div");
	Object.defineProperty(vp, "clientHeight", { value: clientHeight, configurable: true });
	Object.defineProperty(vp, "clientWidth", { value: 800, configurable: true });
	vp.scrollTop = scrollTop;
	return vp;
};

function makeCtx(over: Ctx = {}): ViewContext {
	const layer = document.createElement("div");
	const contentEl = document.createElement("div");
	const ctx: Ctx = {
		visibleList: [] as PluginInfo[],
		plugins: [] as PluginInfo[],
		scrollViewport: makeViewport(),
		scrollCardLayer: layer,
		contentEl,
		colCount: 2,
		cachedRowH: 100,
		rowGap: 0,
		layoutDirty: false,
		scrollVelocity: 0,
		renderRAF: 0,
		pendingCards: new Set<HTMLElement>(),
		cardById: new Map<string, HTMLElement>(),
		cardPool: [] as HTMLElement[],
		windowStart: -1,
		windowEnd: -1,
		fillIdleHandle: null,
		disposed: false,
		// 空态判定相关
		dataLoaded: true,
		listState: "list",
		aiSearchPending: false,
		searchMode: "keyword",
		searchQuery: "",
		aiSearchResult: null,
		sourceFilter: "all",
		installFilter: "all",
		favoriteFilter: false,
		settings: { aiSearchEnabled: false, aiSearchApiKey: "" },
		translatedResults: {} as Record<string, unknown>,
		// 卡片渲染上下文所需集合
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		compareSet: new Set<string>(),
		favoritesSet: new Set<string>(),
		smartSignals: new Map(),
		outdatedIds: new Set<string>(),
		outdatedInfo: new Map(),
		installingIds: new Set<string>(),
		updatingIds: new Set<string>(),
		journalTriedIds: new Set<string>(),
		journalEntryIds: new Set<string>(),
		firstSeenMap: new Map(),
		yulinPicksSet: new Set<string>(),
		getRecommendedIds: () => [] as string[],
		translator: { persistSystemTranslation: vi.fn() },
		saveTranslatorData: vi.fn(),
		updatePlugin: vi.fn(),
		measureLayoutIfNeeded: vi.fn(),
		t: (k: string) => k,
		app: {} as never,
		...over,
	};
	return ctx as unknown as ViewContext;
}

/** 造 n 个窗口内 pending 卡片（data-idx / data-plugin-id 与 visibleList 对齐） */
function seedPending(ctx: ViewContext, count: number) {
	const c = ctx as unknown as { visibleList: PluginInfo[]; pendingCards: Set<HTMLElement> };
	for (let i = 0; i < count; i++) {
		const card = document.createElement("div");
		card.setAttribute("data-idx", String(i));
		card.setAttribute("data-plugin-id", c.visibleList[i].id);
		card.setAttribute("data-fill-pending", "1");
		c.pendingCards.add(card);
	}
}

beforeEach(() => {
	document.body.innerHTML = "";
	vsMock.range = { start: 0, end: 2, firstRow: 0, lastRow: 0, totalRows: 1 };
	vsMock.spacers = { top: 100, bottom: 200 };
	emptyMock.state = { titleKey: "empty.noResult", hintKey: "empty.hint", showClearAction: false, bridgeAction: null };
	idleMock.tasks = [];
	vi.mocked(applyCardState).mockClear();
	vi.mocked(createCardElement).mockClear();
	vi.mocked(clearAllFilters).mockClear();
	vi.mocked(resolveEmptyState).mockClear();
});

describe("renderWindow 空态分支：不覆盖既有界面", () => {
	it("数据未加载完成 → 保留加载动画，不渲染空态", () => {
		const ctx = makeCtx({ dataLoaded: false });
		const layer = ctx.scrollCardLayer!;
		layer.appendChild(document.createElement("div")); // 模拟加载动画
		const before = layer.children.length;
		renderWindow(ctx);
		// 不该被「暂无数据」覆盖
		expect(layer.querySelector(".pt-empty")).toBeNull();
		expect(layer.children.length).toBe(before);
	});

	it("非列表态（引导 / 错误 / AI 等待）→ 不渲染通用空态", () => {
		const ctx = makeCtx({ listState: "guide" });
		const layer = ctx.scrollCardLayer!;
		layer.createDiv({ cls: "pt-guide" });
		renderWindow(ctx);
		expect(layer.querySelector(".pt-empty")).toBeNull();
		expect(layer.querySelector(".pt-guide")).not.toBeNull();
	});

	it("AI 搜索进行中 → 渲染醒目加载态，本地模式用本地文案", () => {
		const ctx = makeCtx({ aiSearchPending: true, searchMode: "local" });
		const layer = ctx.scrollCardLayer!;
		renderWindow(ctx);
		const box = layer.querySelector(".pt-ai-loading-state")!;
		expect(box).not.toBeNull();
		// 本地首载要下模型+建索引，文案必须指路设置页（2026-09-16 用户截图反馈）
		expect(box.querySelector(".pt-empty-title")!.textContent).toBe("notice.local.analyzing");
		expect(box.querySelector(".pt-empty-hint")!.textContent).toBe("notice.local.analyzing.hint");
	});

	it("AI 搜索进行中（云端模式）→ 用 AI 文案", () => {
		const ctx = makeCtx({ aiSearchPending: true, searchMode: "ai" });
		renderWindow(ctx);
		expect(ctx.scrollCardLayer!.querySelector(".pt-empty-title")!.textContent).toBe("notice.ai.analyzing");
	});

	it("空态清层后必须让窗口守卫失效（否则下次渲染会白屏）", () => {
		const ctx = makeCtx({ windowStart: 3, windowEnd: 5 });
		renderWindow(ctx);
		expect(ctx.windowStart).toBe(-1);
		expect(ctx.windowEnd).toBe(-1);
	});
});

describe("renderWindow 空态交互：清除筛选 / 跨模式桥接", () => {
	it("有生效筛选 → 渲染「清除筛选」按钮，点击走单一入口 clearAllFilters", () => {
		emptyMock.state = {
			titleKey: "empty.noResult",
			hintKey: "empty.hint",
			showClearAction: true,
			bridgeAction: null,
		};
		const ctx = makeCtx({ searchQuery: "foo" });
		// 页面上的搜索输入框与清除按钮
		const input = document.createElement("input");
		input.className = "pt-search-input";
		input.value = "foo";
		const clearBtn = document.createElement("div");
		clearBtn.className = "pt-search-clear";
		ctx.contentEl.appendChild(input);
		ctx.contentEl.appendChild(clearBtn);
		renderWindow(ctx);

		const btn = ctx.scrollCardLayer!.querySelector<HTMLElement>(".pt-empty-clear")!;
		expect(btn).not.toBeNull();
		btn.click();
		// 搜索词 + 全部筛选维度都清（曾只清 4 个维度导致「列表 0 条但胶囊还亮着」）
		expect(clearAllFilters).toHaveBeenCalledWith(ctx);
		expect(ctx.searchQuery).toBe("");
		expect(input.value).toBe("");
		expect(clearBtn.style.display).toBe("none");
	});

	it("提供跨模式桥接 → 点击切换搜索模式下拉并派发 change", () => {
		emptyMock.state = {
			titleKey: "empty.noResult",
			hintKey: "empty.hint",
			showClearAction: false,
			bridgeAction: { labelKey: "empty.bridge.ai", mode: "ai" },
		};
		const ctx = makeCtx();
		const select = document.createElement("select");
		select.className = "pt-search-mode";
		// 真实 <select> 没有对应 option 时赋值会被忽略（value 仍为空），必须建出目标选项
		const opt = document.createElement("option");
		opt.value = "ai";
		select.appendChild(opt);
		ctx.contentEl.appendChild(select);
		let changed = 0;
		select.addEventListener("change", () => changed++);
		renderWindow(ctx);

		const bridge = ctx.scrollCardLayer!.querySelector<HTMLElement>(".pt-guide-chip--bridge")!;
		expect(bridge).not.toBeNull();
		expect(bridge.textContent).toBe("empty.bridge.ai");
		bridge.click();
		expect(select.value).toBe("ai");
		expect(changed).toBe(1);
	});
});

describe("renderWindow 非空分支：全量虚拟化重建", () => {
	const listOf = (n: number) => Array.from({ length: n }, (_, i) => plugin(`p${i}`));

	it("生成上下 spacer 并缓存引用，窗口守卫先置 -1 再写入实际窗口", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		const layer = ctx.scrollCardLayer!;
		renderWindow(ctx);
		expect(layer.querySelector(".pt-list-spacer-top")).not.toBeNull();
		expect(layer.querySelector(".pt-list-spacer-bottom")).not.toBeNull();
		expect(ctx.spacerTop).toBe(layer.querySelector(".pt-list-spacer-top"));
		expect(ctx.spacerBottom).toBe(layer.querySelector(".pt-list-spacer-bottom"));
		// 窗口已被 updateWindowImpl 写为实际值（0..2）
		expect(ctx.windowStart).toBe(0);
		expect(ctx.windowEnd).toBe(2);
	});

	it("只把窗口内卡片入 DOM，并写入无障碍位置信息（posinset / setsize）", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		renderWindow(ctx);
		const byId = ctx.cardById as Map<string, HTMLElement>;
		// 窗口 [0,2) → 只有 p0 / p1 两卡片
		expect(byId.size).toBe(2);
		expect([...byId.keys()].sort()).toEqual(["p0", "p1"]);
		const card1 = byId.get("p1")!;
		expect(card1.getAttribute("data-idx")).toBe("1");
		// 虚拟滚动下 DOM 里只有窗口卡片，必须显式告知读屏器这是第 x/n 项，
		// 否则会被报成「共 ~窗口大小 项」
		expect(card1.getAttribute("aria-posinset")).toBe("2");
		expect(card1.getAttribute("aria-setsize")).toBe("5");
	});

	it("layer 子节点顺序为 [spacerTop, ...窗口卡, spacerBottom]", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		const layer = ctx.scrollCardLayer!;
		renderWindow(ctx);
		expect(layer.children.length).toBe(4); // 2 spacer + 2 卡片
		expect(layer.children[0].className).toContain("pt-list-spacer-top");
		expect(layer.children[3].className).toContain("pt-list-spacer-bottom");
	});

	it("重建时旧卡片回池后被复用（不是丢弃），并清掉遗留的非卡片节点", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		const layer = ctx.scrollCardLayer!;
		const old = document.createElement("div");
		old.setAttribute("data-idx", "0");
		(ctx.cardById as Map<string, HTMLElement>).set("old", old);
		layer.createDiv({ cls: "pt-guide" }); // 遗留占位
		vi.mocked(createCardElement).mockClear();
		renderWindow(ctx);
		// 池化语义：先回池、再由新窗口取用 → 旧节点被复用成 p0 的卡片
		const byId = ctx.cardById as Map<string, HTMLElement>;
		expect(byId.get("p0")).toBe(old);
		expect(old.getAttribute("data-plugin-id")).toBe("p0");
		expect(layer.querySelector(".pt-guide")).toBeNull();
		// 池里只有 1 张可复用，p1 才是新建
		expect(createCardElement).toHaveBeenCalledTimes(1);
	});

	it("首次渲染加 pt-list-in 入场类，二次渲染不重复添加", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		const layer = ctx.scrollCardLayer!;
		const addSpy = vi.spyOn(layer.classList, "add");
		renderWindow(ctx);
		expect(layer.classList.contains("pt-list-in")).toBe(true);
		expect(addSpy).toHaveBeenCalledWith("pt-list-in");
		addSpy.mockClear();
		renderWindow(ctx);
		expect(addSpy).not.toHaveBeenCalled();
	});
});

describe("updateWindow：滚动增量换入换出", () => {
	const listOf = (n: number) => Array.from({ length: n }, (_, i) => plugin(`p${i}`));

	it("窗口未越界 → 跳过整轮重写（滚动静止不重排）", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		renderWindow(ctx); // 建立窗口 [0,2)
		const layer = ctx.scrollCardLayer!;
		const snapshot = Array.from(layer.children);
		vsMock.range = { start: 0, end: 2, firstRow: 0, lastRow: 0, totalRows: 2 };
		updateWindow(ctx);
		expect(Array.from(layer.children)).toEqual(snapshot);
	});

	it("滚动到新窗口 → 屏外卡片回收入池，屏内新卡片入 DOM", () => {
		const ctx = makeCtx({ visibleList: listOf(6) });
		renderWindow(ctx); // 窗口 [0,2)
		const byId = ctx.cardById as Map<string, HTMLElement>;
		expect(byId.size).toBe(2);
		// 滚到 [2,4)
		vsMock.range = { start: 2, end: 4, firstRow: 1, lastRow: 1, totalRows: 3 };
		updateWindow(ctx);
		expect(ctx.windowStart).toBe(2);
		expect(ctx.windowEnd).toBe(4);
		expect([...byId.keys()].sort()).toEqual(["p2", "p3"]);
		// 池化：旧的两张先回收、随即被新窗口取用复用，故池被排空（而非堆积）
		expect((ctx.cardPool as HTMLElement[]).length).toBe(0);
		expect(byId.get("p2")!.getAttribute("aria-posinset")).toBe("3");
	});

	it("spacer 高度按窗口与行高计算结果写入", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		vsMock.spacers = { top: 300, bottom: 900 };
		renderWindow(ctx);
		const top = ctx.spacerTop as HTMLElement;
		const bottom = ctx.spacerBottom as HTMLElement;
		expect(top.style.height).toBe("300px");
		expect(bottom.style.height).toBe("900px");
	});

	it("新入窗卡片从池复用而非新建（节点数稳定）", () => {
		const ctx = makeCtx({ visibleList: listOf(6) });
		renderWindow(ctx);
		vi.mocked(createCardElement).mockClear();
		vsMock.range = { start: 2, end: 4, firstRow: 1, lastRow: 1, totalRows: 3 };
		updateWindow(ctx);
		// 池里有两张可复用 → 不应再新建
		expect(createCardElement).not.toHaveBeenCalled();
	});
});

describe("fillVisibleWindow：懒填充与单帧预算", () => {
	const listOf = (n: number) => Array.from({ length: n }, (_, i) => plugin(`p${i}`));

	it("pending 为空 → 短路返回，不调用卡片填充", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		renderWindow(ctx); // renderWindow 末尾已经填过
		vi.mocked(applyCardState).mockClear();
		ctx.pendingCards.clear();
		fillVisibleWindow(ctx);
		expect(applyCardState).not.toHaveBeenCalled();
	});

	it("填充窗口内 pending 卡片，并移除 data-fill-pending", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		vsMock.range = { start: 0, end: 3, firstRow: 0, lastRow: 1, totalRows: 2 };
		seedPending(ctx, 3);
		const cards = [...ctx.pendingCards];
		fillVisibleWindow(ctx);
		expect(applyCardState).toHaveBeenCalledTimes(3);
		expect(ctx.pendingCards.size).toBe(0);
		expect(cards.every((c) => !c.hasAttribute("data-fill-pending"))).toBe(true);
	});

	it("屏外 pending 卡片不在本帧填充", () => {
		const ctx = makeCtx({ visibleList: listOf(5) });
		vsMock.range = { start: 0, end: 1, firstRow: 0, lastRow: 0, totalRows: 5 };
		seedPending(ctx, 3); // idx 0..2，但窗口只有 [0,1)
		fillVisibleWindow(ctx);
		expect(applyCardState).toHaveBeenCalledTimes(1);
	});

	it("单帧预算 20：超出部分挂 requestIdle 空闲续填", () => {
		const ctx = makeCtx({ visibleList: listOf(30) });
		vsMock.range = { start: 0, end: 30, firstRow: 0, lastRow: 14, totalRows: 15 };
		seedPending(ctx, 25);
		fillVisibleWindow(ctx);
		// 一帧最多填 20，剩 5 张仍 pending
		expect(applyCardState).toHaveBeenCalledTimes(20);
		expect(ctx.pendingCards.size).toBe(5);
		expect(idleMock.tasks.length).toBe(1);
		// 空闲回调触发后续填完剩余
		idleMock.tasks[0]();
		expect(applyCardState).toHaveBeenCalledTimes(25);
		expect(ctx.pendingCards.size).toBe(0);
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "./view-context";

/**
 * 卡片的交互层：点击分发、键盘漫游、焦点定位。
 *
 * onCardClick 是一个 9 分支的意图分发器（复制/对比/详情/评测/洞察/启用/卸载/
 * 安装/作者/收藏）。它的错误模式很具体：**分支串味**——把"点按钮"当成"点卡片"，
 * 或反过来把"点空白"漏掉。这类 bug 不会抛错，只会让用户觉得"点了没反应"或
 * "怎么突然开了详情"。
 */
const installerMock = vi.hoisted(() => ({
	installCommunityPlugin: vi.fn(async () => true),
	togglePluginEnabled: vi.fn(async () => true),
	uninstallCommunityPlugin: vi.fn(async () => true),
}));
const modalMock = vi.hoisted(() => ({ last: null as null | Record<string, unknown> }));

vi.mock("@data/platform/plugin-installer", () => installerMock);
vi.mock("@ui/modals/confirm-modal", () => ({
	ConfirmModal: class {
		constructor(opts: unknown) {
			modalMock.last = opts as never;
		}
		open() {}
	},
}));
// 洞察弹窗会拉 GitHub 信号，交互测试里隔离掉
vi.mock("@domain/compare/plugin-insight", () => ({
	gatherInsightSources: vi.fn(async () => null),
	fetchMainSignals: vi.fn(async () => ({ commands: [] })),
	fetchManifest: vi.fn(async () => null),
	fetchReadmeText: vi.fn(async () => ""),
	generateInsight: vi.fn(async () => ""),
}));

let cards: typeof import("./view-cards");

beforeEach(async () => {
	vi.clearAllMocks();
	modalMock.last = null;
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
		app: {},
		t: (k: string) => k,
		plugins: [plugin("p1"), plugin("p2")],
		visibleList: [plugin("p1"), plugin("p2")],
		colCount: 2,
		focusedCardIdx: -1,
		containerEl: document.createElement("div"),
		scrollCardLayer: null,
		scrollViewport: null,
		defaultRowH: 120,
		rowGap: 12,
		cachedRowH: 0,
		compareSet: new Set<string>(),
		installedIds: new Set<string>(),
		installingIds: new Set<string>(),
		favoritesSet: new Set<string>(),
		settings: { compare: [] as string[], favorites: [] as string[] },
		translator: { enqueueOnlineTM: vi.fn() },
		saveSettings: vi.fn(async () => {}),
		flushSaveSettings: vi.fn(async () => {}),
		openDetailDrawer: vi.fn(),
		openReviewDrawer: vi.fn(),
		updateCompareTray: vi.fn(),
		track: vi.fn(),
		flashAction: vi.fn(),
		refreshCardState: vi.fn(),
		scheduleRender: vi.fn(),
		snapshotInstalled: vi.fn(),
		invalidateAndRender: vi.fn(),
		renderAuthorFacet: vi.fn(),
		updateFacetVisibility: vi.fn(),
		toggleFavorite: vi.fn(() => true),
		focusCardByIdx: vi.fn(),
		updateWindow: vi.fn(),
		authorFilter: null,
		searchQuery: "旧词",
		aiSearchResult: { hits: [1] },
		aiSearchQueryCache: "旧词",
		sortFavoritesFirst: false,
		...over,
	};
	return ctx as unknown as ViewContext;
}

/** 构造一张带操作按钮的卡片（closest 依赖父链，不必挂到 document） */
function makeCard(pid: string, actions: string[] = [], withSwitch = false) {
	const card = document.createElement("div");
	card.className = "pt-card pt-card--clickable";
	card.setAttribute("data-plugin-id", pid);
	if (withSwitch) {
		const sw = document.createElement("button");
		sw.className = "pt-card-toggle-switch";
		card.appendChild(sw);
	}
	const row = document.createElement("div");
	row.className = "pt-card-actions-row";
	for (const a of actions) {
		const btn = document.createElement("button");
		btn.setAttribute("data-action", a);
		const icon = document.createElement("span");
		btn.appendChild(icon);
		row.appendChild(btn);
	}
	card.appendChild(row);
	return {
		card,
		row,
		btn: (a: string) => row.querySelector(`[data-action="${a}"]`) as HTMLElement,
		icon: (a: string) => row.querySelector(`[data-action="${a}"] span`) as HTMLElement,
	};
}

const click = (target: HTMLElement) =>
	({ target, stopPropagation: vi.fn() }) as unknown as MouseEvent;

const key = (k: string, target: HTMLElement = document.createElement("div")) =>
	({ key: k, target, preventDefault: vi.fn(), stopPropagation: vi.fn() }) as unknown as KeyboardEvent;

describe("onCardClick：整卡点击与空白区防护", () => {
	it("点卡片空白 → 打开详情抽屉", () => {
		const { card } = makeCard("p1", ["detail"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(card));

		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("p1", card);
		expect(ctx.saveSettings).toHaveBeenCalled();
	});

	it("点卡片内的普通按钮（无 data-action）→ 不打开详情", () => {
		const { card } = makeCard("p1", ["detail"]);
		const plain = document.createElement("button");
		card.appendChild(plain);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(plain));

		expect(ctx.openDetailDrawer).not.toHaveBeenCalled();
	});

	it("点按钮内的图标仍算点该按钮（走同一 action 分支）", () => {
		const { card, icon } = makeCard("p1", ["detail"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(icon("detail")));

		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("p1", card);
	});

	it("点操作行空白处且卡片有开关 → 不跳详情（避免误点图标间隙）", () => {
		const { row } = makeCard("p1", ["toggle-enabled"], true);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(row));

		expect(ctx.openDetailDrawer).not.toHaveBeenCalled();
	});

	it("找不到卡片时安全返回", () => {
		const orphan = document.createElement("div");
		const ctx = makeCtx();
		expect(() => cards.onCardClick(ctx, click(orphan))).not.toThrow();
	});
});

describe("onCardClick：各 data-action 分支", () => {
	it("copy：写剪贴板并把 tooltip 临时改为「已复制」，1.2s 后还原", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const writeText = vi.fn(async () => {});
		Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
		const { btn } = makeCard("p1", ["copy"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("copy")));

		expect(writeText).toHaveBeenCalledWith("p1");
		expect(ctx.flashAction).toHaveBeenCalled();
		expect(btn("copy").getAttribute("title")).toBe("card.copy.done");

		await vi.advanceTimersByTimeAsync(1200);
		expect(btn("copy").getAttribute("title")).toBe("card.copy");
	});

	it("compare 未选中：加入对比并投递晋升队列，持久化对比集", () => {
		const { btn } = makeCard("p1", ["compare"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("compare")));

		expect((ctx.compareSet as Set<string>).has("p1")).toBe(true);
		expect(ctx.translator.enqueueOnlineTM).toHaveBeenCalledWith("p1");
		expect(ctx.updateCompareTray).toHaveBeenCalled();
		expect(ctx.settings.compare).toEqual(["p1"]);
		expect(ctx.flushSaveSettings).toHaveBeenCalled();
	});

	it("compare 已选中：移出对比，不再投递晋升队列", () => {
		const { btn } = makeCard("p1", ["compare"]);
		const ctx = makeCtx({ compareSet: new Set(["p1"]) });

		cards.onCardClick(ctx, click(btn("compare")));

		expect((ctx.compareSet as Set<string>).has("p1")).toBe(false);
		expect(ctx.translator.enqueueOnlineTM).not.toHaveBeenCalled();
	});

	it("detail：打开详情抽屉", () => {
		const { card, btn } = makeCard("p1", ["detail"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("detail")));

		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("p1", card);
	});

	it("review：打开抽屉并聚焦评测区", () => {
		const { card, btn } = makeCard("p1", ["review"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("review")));

		expect(ctx.openReviewDrawer).toHaveBeenCalledWith("p1", card);
	});

	it("author：按作者钻取，清空搜索词与 AI 结果并重渲染", () => {
		const { btn } = makeCard("p1", ["author"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("author")));

		expect(ctx.authorFilter).toBe("作者-p1");
		expect(ctx.searchQuery).toBe("");
		expect(ctx.aiSearchResult).toBeNull();
		expect(ctx.aiSearchQueryCache).toBe("");
		expect(ctx.track).toHaveBeenCalledWith("filter:author");
		expect(ctx.scheduleRender).toHaveBeenCalled();
	});

	it("favorite 新增：切换收藏并提示", () => {
		const { btn } = makeCard("p1", ["favorite"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("favorite")));

		expect(ctx.toggleFavorite).toHaveBeenCalledWith("p1");
		expect(ctx.flashAction).toHaveBeenCalled();
		expect(String((ctx.toggleFavorite as ReturnType<typeof vi.fn>).mock.calls.length)).toBe("1");
	});

	it("favorite 取消且开启「收藏置顶」：200ms 后重建列表（带过渡）", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
		const { btn } = makeCard("p1", ["favorite"]);
		const ctx = makeCtx({ sortFavoritesFirst: true, toggleFavorite: vi.fn(() => false) });

		cards.onCardClick(ctx, click(btn("favorite")));
		expect(ctx.scheduleRender).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(200);
		expect(ctx.scheduleRender).toHaveBeenCalledWith(true);
	});

	it("market：走一键安装流程", async () => {
		const { btn } = makeCard("p1", ["market"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("market")));
		await new Promise((r) => window.setTimeout(r, 0));

		expect(installerMock.installCommunityPlugin).toHaveBeenCalled();
	});

	it("uninstall：先弹二次确认，未确认不卸载", async () => {
		const { btn } = makeCard("p1", ["uninstall"]);
		const ctx = makeCtx();

		cards.onCardClick(ctx, click(btn("uninstall")));
		await new Promise((r) => window.setTimeout(r, 0));

		expect(modalMock.last).not.toBeNull();
		expect(installerMock.uninstallCommunityPlugin).not.toHaveBeenCalled();
	});
});

describe("onCardKeydown：键盘漫游", () => {
	it("列表为空时不处理", () => {
		const ctx = makeCtx({ visibleList: [] });
		const ev = key("ArrowRight");
		cards.onCardKeydown(ctx, ev);
		expect(ev.preventDefault).not.toHaveBeenCalled();
	});

	it("焦点在输入控件内时不拦截（避免抢走方向键）", () => {
		const ctx = makeCtx();
		const input = document.createElement("input");
		const ev = key("ArrowRight", input);
		cards.onCardKeydown(ctx, ev);
		expect(ev.preventDefault).not.toHaveBeenCalled();
	});

	it("无关按键放行", () => {
		const ctx = makeCtx();
		const ev = key("a");
		cards.onCardKeydown(ctx, ev);
		expect(ev.preventDefault).not.toHaveBeenCalled();
	});

	it("Tab 不拦截（保留卡片内 focusable 元素间的切换）", () => {
		const ctx = makeCtx();
		const ev = key("Tab");
		cards.onCardKeydown(ctx, ev);
		expect(ev.preventDefault).not.toHaveBeenCalled();
	});

	it("方向键按列数移动焦点", () => {
		const ctx = makeCtx({ focusedCardIdx: 0, visibleList: [plugin("a"), plugin("b"), plugin("c"), plugin("d")] });

		cards.onCardKeydown(ctx, key("ArrowRight"));
		expect(ctx.focusedCardIdx).toBe(1);

		cards.onCardKeydown(ctx, key("ArrowDown"));
		expect(ctx.focusedCardIdx).toBe(3);
	});

	it("向上/向左不会越界到负下标", () => {
		const ctx = makeCtx({ focusedCardIdx: 0 });
		cards.onCardKeydown(ctx, key("ArrowUp"));
		expect(ctx.focusedCardIdx).toBe(0);
		cards.onCardKeydown(ctx, key("ArrowLeft"));
		expect(ctx.focusedCardIdx).toBe(0);
	});

	it("Home / End 跳到首尾", () => {
		const ctx = makeCtx({ focusedCardIdx: 1 });
		cards.onCardKeydown(ctx, key("End"));
		expect(ctx.focusedCardIdx).toBe(1); // total=2 → 末位 1
		cards.onCardKeydown(ctx, key("Home"));
		expect(ctx.focusedCardIdx).toBe(0);
	});

	it("尚未聚焦时按方向键，先聚焦到第一张", () => {
		const ctx = makeCtx({ focusedCardIdx: -1 });
		cards.onCardKeydown(ctx, key("ArrowDown"));
		expect(ctx.focusedCardIdx).toBe(0);
	});

	it("Enter 打开当前聚焦卡的详情", () => {
		const ctx = makeCtx({ focusedCardIdx: 1 });
		cards.onCardKeydown(ctx, key("Enter"));
		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("p2", null);
	});

	it("已聚焦时 Enter 之后仍会调用 focusCardByIdx（保持焦点可见）", () => {
		const ctx = makeCtx({ focusedCardIdx: 0 });
		cards.onCardKeydown(ctx, key("ArrowRight"));
		expect(ctx.focusCardByIdx).toHaveBeenCalledWith(1);
	});
});

describe("focusCardByIdx：跨窗口聚焦", () => {
	const makeLayer = () => {
		const layer = document.createElement("div");
		for (let i = 0; i < 3; i++) {
			const card = document.createElement("div");
			card.className = "pt-card";
			card.setAttribute("data-idx", String(i));
			card.focus = vi.fn();
			card.scrollIntoView = vi.fn();
			layer.appendChild(card);
		}
		return layer;
	};

	it("没有卡片层时安全返回", () => {
		const ctx = makeCtx({ scrollCardLayer: null });
		expect(() => cards.focusCardByIdx(ctx, 0)).not.toThrow();
	});

	it("先清除旧的聚焦态，再给目标卡加聚焦 class", async () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
		const layer = makeLayer();
		(layer.children[0] as HTMLElement).classList.add("pt-card--focused");
		const ctx = makeCtx({ scrollCardLayer: layer });

		cards.focusCardByIdx(ctx, 1);
		await vi.advanceTimersByTimeAsync(16);

		expect(layer.children[0].classList.contains("pt-card--focused")).toBe(false);
		expect(layer.children[1].classList.contains("pt-card--focused")).toBe(true);
	});

	it("焦点定位前会先换入窗口（大跨度跳转时目标卡可能已从 DOM 回收）", async () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
		const layer = makeLayer();
		const ctx = makeCtx({ scrollCardLayer: layer });

		cards.focusCardByIdx(ctx, 2);
		await vi.advanceTimersByTimeAsync(16);

		expect(ctx.updateWindow).toHaveBeenCalled();
		expect((layer.children[2] as HTMLElement).focus).toHaveBeenCalled();
	});

	it("有视口时按行居中滚动", async () => {
		vi.useFakeTimers({ toFake: ["requestAnimationFrame"] });
		const layer = makeLayer();
		const vp = document.createElement("div");
		Object.defineProperty(vp, "clientHeight", { value: 600, configurable: true });
		const ctx = makeCtx({
			scrollCardLayer: layer,
			scrollViewport: vp,
			cachedRowH: 120,
			// 滚动分支要求 idx < visibleList.length，这里给足量列表
			visibleList: Array.from({ length: 20 }, (_, i) => plugin(`p${i}`)),
		});

		// 下标 10 → 第 5 行，远超首屏（2 行），必须滚动
		cards.focusCardByIdx(ctx, 10);
		await vi.advanceTimersByTimeAsync(16);

		expect(vp.scrollTop).toBeGreaterThan(0);
	});
});

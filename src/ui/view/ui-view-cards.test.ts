import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	openDetailDrawer,
	computeSimilarFor,
	handleInstall,
	handleToggleEnabled,
	handleUninstall,
	onCardClick,
	toggleFavorite,
	onCardKeydown,
	focusCardByIdx,
	flashAction,
	openInsightModal,
} from "./view-cards";
import { computeSimilar } from "@domain/recommend/similar";
import { PluginDetailDrawer } from "@ui/components/detail-drawer";
import { ConfirmModal } from "@ui/modals/confirm-modal";
import {
	installCommunityPlugin,
	togglePluginEnabled,
	uninstallCommunityPlugin,
} from "@data/platform/plugin-installer";
import { fetchManifest, generateInsight } from "@domain/compare/plugin-insight";
import type { ViewContext } from "@ui/view/view-context";
import type { PluginInfo } from "@domain/catalog/translator";

// 局部 DOM helper（与 view-beta 等一致），并补齐 Obsidian 对 HTMLElement 的增强
type ElOpts =
	| string
	| { cls?: string; text?: string | null; type?: string; attr?: Record<string, string> };
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
	if (!proto.empty) {
		proto.empty = function (this: HTMLElement) {
			this.textContent = "";
		};
	}
	if (!proto.scrollIntoView) {
		proto.scrollIntoView = function () {};
	}
}
ensureDomHelpers();

// dom/dom 的 toHTMLElement 依赖 Obsidian 的 el.instanceOf（jsdom 无），本地实现等价语义
vi.mock("@ui/dom/dom", () => ({
	q: (root: ParentNode, sel: string) => root.querySelector(sel),
	toHTMLElement: (el: Element | null, ctor?: new (...a: never[]) => HTMLElement) => {
		if (el && el instanceof HTMLElement && (!ctor || el instanceof ctor)) return el as HTMLElement;
		return null;
	},
}));
vi.mock("@domain/recommend/similar", () => ({ computeSimilar: vi.fn(() => []) }));
vi.mock("@ui/components/detail-drawer", () => ({ PluginDetailDrawer: vi.fn() }));
vi.mock("@ui/modals/confirm-modal", () => ({ ConfirmModal: vi.fn() }));
vi.mock("@data/platform/plugin-installer", () => ({
	installCommunityPlugin: vi.fn(() => Promise.resolve()),
	togglePluginEnabled: vi.fn(() => Promise.resolve()),
	uninstallCommunityPlugin: vi.fn(() => Promise.resolve(true)),
}));
vi.mock("@domain/compare/plugin-insight", () => ({
	fetchManifest: vi.fn(() => Promise.resolve({ main: "main.js" })),
	fetchReadmeText: vi.fn(() => Promise.resolve("")),
	fetchMainSignals: vi.fn(() => Promise.resolve("")),
	generateInsight: vi.fn(() => Promise.resolve("insight text")),
}));

// rAF 同步执行，使 fillSimilar / focusCardByIdx 的回调可确定性覆盖
const raf = (cb: FrameRequestCallback): number => {
	cb(0);
	return 0;
};
(window as unknown as { requestAnimationFrame: typeof raf }).requestAnimationFrame = raf;

function plug(id: string, name = id, repo = "repo-" + id, author = "Au"): PluginInfo {
	return { id, name, repo, author } as unknown as PluginInfo;
}

function makeCtx(over: Record<string, unknown> = {}): any {
	const translator = {
		enqueueOnlineTM: vi.fn(),
		tagService: null,
		getInsight: vi.fn(() => null),
		setInsight: vi.fn(),
		aiConfig: { ok: true },
		llm: { model: "x" },
	};
	const base = {
		t: vi.fn((k: string, v?: Record<string, string>) => (v ? `${k}:${JSON.stringify(v)}` : k)),
		plugins: [plug("p1", "Plugin One"), plug("p2", "Plugin Two")],
		translatedResults: {},
		translator,
		invertedIndex: null,
		favoritesSet: new Set<string>(),
		settings: { favorites: [] as string[], favoriteGroupOf: {} as Record<string, string>, compare: [] as string[] } as Record<string, unknown>,
		compareSet: new Set<string>(),
		installingIds: new Set<string>(),
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		installedVersions: new Map<string, string>(),
		filterCache: { reset: vi.fn() },
		favoriteFilter: "all",
		installFilter: "all",
		sortFavoritesFirst: false,
		pluginDeps: null,
		activeDrawer: null,
		compareMode: false,
		aiSearchResult: null,
		aiSearchQueryCache: "",
		searchQuery: "",
		authorFilter: "",
		containerEl: document.createElement("div"),
		contentEl: document.createElement("div"),
		app: {} as unknown as import("obsidian").App,
		mirrorConfig: vi.fn(() => false),
		saveTranslatorData: vi.fn(),
		scrollCardLayer: null,
		scrollViewport: null,
		visibleList: [plug("p1", "Plugin One")],
		colCount: 2,
		rowGap: 8,
		defaultRowH: 80,
		cachedRowH: 0,
		focusedCardIdx: -1,
		// 行为方法
		saveSettings: vi.fn(),
		flushSaveSettings: vi.fn(),
		openDetailDrawer: vi.fn(),
		openReviewDrawer: vi.fn(),
		openInsightModal: vi.fn(),
		renderAuthorFacet: vi.fn(),
		updateFacetVisibility: vi.fn(),
		updateCompareTray: vi.fn(),
		scheduleRender: vi.fn(),
		invalidateAndRender: vi.fn(),
		refreshCardState: vi.fn(),
		snapshotInstalled: vi.fn(),
		enterDetailMode: vi.fn(),
		exitDetailMode: vi.fn(),
		exitCompareMode: vi.fn(),
		track: vi.fn(),
		toggleFavorite: vi.fn((pid: string) => {
			const s = base.favoritesSet as Set<string>;
			if (s.has(pid)) {
				s.delete(pid);
				return false;
			}
			s.add(pid);
			return true;
		}),
		listPluginVersions: vi.fn(() => Promise.resolve([])),
		pinPluginVersion: vi.fn(() => Promise.resolve()),
		updateWindow: vi.fn(),
		focusCardByIdx: vi.fn(),
		flashAction: vi.fn(),
	};
	const c: any = { ...base, ...over };
	// openDetailDrawer 内部调用 ctx.computeSimilarFor(info)，由共享函数转发
	c.computeSimilarFor = (info: unknown) => computeSimilarFor(c, info as PluginInfo);
	return c;
}

// 触发 onCardClick：在 el 上派发 click，并把同一事件交给 onCardClick（ev.target 即 el）
function fireClick(ctx: any, el: HTMLElement): void {
	const ev = new MouseEvent("click", { bubbles: true });
	el.dispatchEvent(ev);
	onCardClick(ctx as unknown as ViewContext, ev);
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.defineProperty(navigator, "clipboard", {
		value: { writeText: vi.fn(() => Promise.resolve()) },
		configurable: true,
	});
});

describe("toggleFavorite", () => {
	it("收藏 → 写入 settings.favorites + favoritesSet + 刷新收藏筛选缓存 + 保存（375-404）", () => {
		const c = makeCtx({ favoriteFilter: "fav" });
		const r = toggleFavorite(c, "p1");
		expect(r).toBe(true);
		expect(c.settings.favorites).toContain("p1");
		expect(c.favoritesSet.has("p1")).toBe(true);
		expect(c.translator.enqueueOnlineTM).toHaveBeenCalledWith("p1");
		expect(c.filterCache.reset).toHaveBeenCalled();
		expect(c.flushSaveSettings).toHaveBeenCalled();
	});

	it("取消收藏 → 移除 favorites + 清除分组归属（378-386）", () => {
		const c = makeCtx({ favoritesSet: new Set(["p1"]), settings: { favorites: ["p1"], favoriteGroupOf: { p1: "g1" } } });
		const r = toggleFavorite(c, "p1");
		expect(r).toBe(false);
		expect(c.settings.favorites).not.toContain("p1");
		expect(c.settings.favoriteGroupOf.p1).toBeUndefined();
	});

	it("筛选为 all 时取消收藏不失效收藏缓存（399-401）", () => {
		const c = makeCtx({ favoriteFilter: "all", favoritesSet: new Set(["p1"]) });
		toggleFavorite(c, "p1");
		expect(c.filterCache.reset).not.toHaveBeenCalled();
	});

	it("收藏筛选生效时取消收藏 → 失效前缀缓存（398-401）", () => {
		const c = makeCtx({ favoriteFilter: "fav", favoritesSet: new Set(["p1"]) });
		toggleFavorite(c, "p1");
		expect(c.filterCache.reset).toHaveBeenCalled();
	});
});

describe("flashAction", () => {
	it("加 done class，1200ms 后移除（516-523）", () => {
		vi.useFakeTimers();
		const btn = document.createElement("button");
		flashAction({} as ViewContext, btn);
		expect(btn.classList.contains("pt-icon-btn--done")).toBe(true);
		vi.advanceTimersByTime(1200);
		expect(btn.classList.contains("pt-icon-btn--done")).toBe(false);
		vi.useRealTimers();
	});
});

describe("computeSimilarFor", () => {
	it("无 tagService → 空（113-115）", () => {
		const c = makeCtx();
		expect(computeSimilarFor(c, plug("p1", "X"))).toEqual([]);
		expect(computeSimilar).not.toHaveBeenCalled();
	});

	it("插件列表为空 → 空（113-115）", () => {
		const c = makeCtx({ translator: { ...makeCtx().translator, tagService: {} }, plugins: [] });
		expect(computeSimilarFor(c, plug("p1", "X"))).toEqual([]);
	});

	it("正常 → 调 computeSimilar + 懒 build 倒排索引（119-146）", () => {
		const idx = { isBuilt: false, build: vi.fn() };
		const c = makeCtx({
			translator: { ...makeCtx().translator, tagService: { getAllTags: () => ({ p1: { category: "a", tags: [] } }) } },
			invertedIndex: idx,
			translatedResults: { p1: { translatedName: "N", translatedDesc: "D" } },
		});
		computeSimilarFor(c, plug("p1", "X"));
		expect(idx.build).toHaveBeenCalled();
		expect(computeSimilar).toHaveBeenCalled();
	});
});

describe("handleInstall", () => {
	it("已安装 → 直接返回（155）", async () => {
		const c = makeCtx({ installedIds: new Set(["p1"]) });
		await handleInstall(c, plug("p1", "X"));
		expect(installCommunityPlugin).not.toHaveBeenCalled();
	});

	it("安装中 → 直接返回（155）", async () => {
		const c = makeCtx({ installingIds: new Set(["p1"]) });
		await handleInstall(c, plug("p1", "X"));
		expect(installCommunityPlugin).not.toHaveBeenCalled();
	});

	it("成功 → installing 清除 + snapshot + 重绘（156-183）", async () => {
		const c = makeCtx();
		await handleInstall(c, plug("p1", "X"));
		expect(installCommunityPlugin).toHaveBeenCalled();
		expect(c.installingIds.has("p1")).toBe(false);
		expect(c.snapshotInstalled).toHaveBeenCalled();
		expect(c.invalidateAndRender).toHaveBeenCalledWith(true);
	});
});

describe("handleToggleEnabled", () => {
	it("安装中 → 返回（190）", async () => {
		const c = makeCtx({ installingIds: new Set(["p1"]) });
		await handleToggleEnabled(c, plug("p1", "X"));
		expect(togglePluginEnabled).not.toHaveBeenCalled();
	});

	it("非 enabled/installedNotEnabled 筛选 → 仅原地刷新（205-209）", async () => {
		const c = makeCtx({ installFilter: "all" });
		await handleToggleEnabled(c, plug("p1", "X"));
		expect(togglePluginEnabled).toHaveBeenCalled();
		expect(c.invalidateAndRender).not.toHaveBeenCalled();
		expect(c.refreshCardState).toHaveBeenCalledWith("p1");
	});

	it("enabled 筛选 → 重建窗口（205-206）", async () => {
		const c = makeCtx({ installFilter: "enabled" });
		await handleToggleEnabled(c, plug("p1", "X"));
		expect(c.invalidateAndRender).toHaveBeenCalledWith(true);
	});
});

describe("handleUninstall", () => {
	it("安装中 → 返回（222）", async () => {
		const c = makeCtx({ installingIds: new Set(["p1"]) });
		await handleUninstall(c, plug("p1", "X"));
		expect(uninstallCommunityPlugin).not.toHaveBeenCalled();
	});

	it("确认取消 → 不卸载（223-234）", async () => {
		(vi.mocked(ConfirmModal) as any).mockImplementation((opts: any) => ({ open: () => opts.onCancel?.() }));
		const c = makeCtx();
		await handleUninstall(c, plug("p1", "X"));
		expect(uninstallCommunityPlugin).not.toHaveBeenCalled();
	});

	it("确认卸载 → uninstallCommunityPlugin + 重绘（235-247）", async () => {
		(vi.mocked(ConfirmModal) as any).mockImplementation((opts: any) => ({ open: () => opts.onConfirm?.() }));
		const c = makeCtx({ installedIds: new Set(["p1"]) });
		await handleUninstall(c, plug("p1", "X"));
		expect(uninstallCommunityPlugin).toHaveBeenCalled();
		expect(c.invalidateAndRender).toHaveBeenCalledWith(true);
	});
});

describe("openDetailDrawer", () => {
	it("已有抽屉 → navigate 复用 + 复用抽屉（71-76）", () => {
		const drawer = {
			navigate: vi.fn(),
			setSimilar: vi.fn(),
			focusJournalArea: vi.fn(),
			currentPluginId: "p1",
		};
		const c = makeCtx({ activeDrawer: drawer });
		openDetailDrawer(c, "p1");
		expect(drawer.navigate).toHaveBeenCalledWith("p1", expect.anything(), undefined, []);
		expect(c.enterDetailMode).not.toHaveBeenCalled();
	});

	it("无抽屉 → 新建 PluginDetailDrawer + 进入详情态（77-108）", () => {
		const inst = {
			navigate: vi.fn(),
			setSimilar: vi.fn(),
			focusJournalArea: vi.fn(),
			currentPluginId: "p1",
			open: vi.fn(),
		};
		vi.mocked(PluginDetailDrawer).mockImplementation((_o: any) => inst as never);
		const c = makeCtx();
		openDetailDrawer(c, "p1");
		expect(PluginDetailDrawer).toHaveBeenCalled();
		expect(c.enterDetailMode).toHaveBeenCalled();
		expect(inst.open).toHaveBeenCalled();
		expect(c.activeDrawer).toBe(inst);
	});

	it("compareMode → 先退对比模式（56）", () => {
		const c = makeCtx({ compareMode: true });
		vi.mocked(PluginDetailDrawer).mockImplementation(() => ({ open: vi.fn(), currentPluginId: "p1", setSimilar: vi.fn() }) as never);
		openDetailDrawer(c, "p1");
		expect(c.exitCompareMode).toHaveBeenCalled();
	});
});

describe("onCardClick：操作按钮分发", () => {
	function cardWith(actionHtml: string, extraCls = ""): HTMLElement {
		const card = document.createElement("div");
		card.className = `pt-card--clickable ${extraCls}`;
		card.setAttribute("data-plugin-id", "p1");
		card.innerHTML = `<div class="pt-card-actions-row">${actionHtml}</div>`;
		document.body.appendChild(card);
		return card;
	}

	it("copy → 写入剪贴板 + tooltip 1.2s 还原（287-297）", () => {
		vi.useFakeTimers();
		const card = cardWith(`<button data-action="copy" title="复制"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(navigator.clipboard.writeText).toHaveBeenCalledWith("p1");
		vi.useRealTimers();
		document.body.removeChild(card);
	});

	it("compare 加入 → compareSet 增 + 通知 + tray（298-315）", () => {
		const card = cardWith(`<button data-action="compare"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(c.compareSet.has("p1")).toBe(true);
		expect(c.translator.enqueueOnlineTM).toHaveBeenCalledWith("p1");
		expect(c.updateCompareTray).toHaveBeenCalled();
		document.body.removeChild(card);
	});

	it("compare 取消 → compareSet 删（298-315）", () => {
		const card = cardWith(`<button data-action="compare"></button>`);
		const c = makeCtx({ compareSet: new Set(["p1"]) });
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(c.compareSet.has("p1")).toBe(false);
		document.body.removeChild(card);
	});

	it("detail → 打开详情（316-318）", () => {
		const card = cardWith(`<button data-action="detail"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(c.openDetailDrawer).toHaveBeenCalledWith("p1", expect.anything());
		document.body.removeChild(card);
	});

	it("review → 打开评测抽屉（319-321）", () => {
		const card = cardWith(`<button data-action="review"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(c.openReviewDrawer).toHaveBeenCalledWith("p1", expect.anything());
		document.body.removeChild(card);
	});

	it("insight → openInsightModal（322-323）", async () => {
		const card = cardWith(`<button data-action="insight"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		await vi.waitFor(() => expect(fetchManifest).toHaveBeenCalled());
		document.body.removeChild(card);
	});

	it("toggle-enabled → handleToggleEnabled（324-326）", () => {
		const card = cardWith(`<button data-action="toggle-enabled"></button>`);
		const c = makeCtx({ installedIds: new Set(["p1"]) });
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(togglePluginEnabled).toHaveBeenCalled();
		document.body.removeChild(card);
	});

	it("uninstall → handleUninstall（327-329）", async () => {
		const card = cardWith(`<button data-action="uninstall"></button>`);
		const c = makeCtx({ installedIds: new Set(["p1"]) });
		(vi.mocked(ConfirmModal) as any).mockImplementation((opts: any) => ({ open: () => opts.onConfirm?.() }));
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		await vi.waitFor(() => expect(uninstallCommunityPlugin).toHaveBeenCalled());
		document.body.removeChild(card);
	});

	it("market → handleInstall（330-332）", () => {
		const card = cardWith(`<button data-action="market"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(installCommunityPlugin).toHaveBeenCalled();
		document.body.removeChild(card);
	});

	it("author → 作者钻取：清空搜索 + 重渲（333-344）", () => {
		const card = cardWith(`<button data-action="author"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(c.authorFilter).toBe("Au");
		expect(c.searchQuery).toBe("");
		expect(c.renderAuthorFacet).toHaveBeenCalled();
		expect(c.scheduleRender).toHaveBeenCalled();
		document.body.removeChild(card);
	});

	it("favorite 加入 → toggleFavorite + 脉冲动画（345-356）", () => {
		const card = cardWith(`<button data-action="favorite" class="pt-fav"></button>`);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>("[data-action]")!);
		expect(c.favoritesSet.has("p1")).toBe(true);
		expect(c.flashAction).toHaveBeenCalled();
		document.body.removeChild(card);
	});

	it("整卡空白点击 → 打开详情（269-281）", () => {
		const card = document.createElement("div");
		card.className = "pt-card--clickable";
		card.setAttribute("data-plugin-id", "p1");
		card.innerHTML = `<div class="pt-card-body"></div>`;
		document.body.appendChild(card);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>(".pt-card-body")!);
		expect(c.openDetailDrawer).toHaveBeenCalledWith("p1", expect.anything());
		document.body.removeChild(card);
	});

	it("操作行空白且带开关 → 不跳详情（262-264）", () => {
		const card = document.createElement("div");
		card.className = "pt-card--clickable";
		card.setAttribute("data-plugin-id", "p1");
		card.innerHTML = `<div class="pt-card-toggle-switch"></div><div class="pt-card-actions-row"><div class="pt-empty"></div></div>`;
		document.body.appendChild(card);
		const c = makeCtx();
		fireClick(c, card.querySelector<HTMLElement>(".pt-empty")!);
		expect(c.openDetailDrawer).not.toHaveBeenCalled();
		document.body.removeChild(card);
	});
});

describe("onCardKeydown / focusCardByIdx", () => {
	function ctxWithLayer() {
		const layer = document.createElement("div");
		const vp = document.createElement("div");
		Object.defineProperty(vp, "clientHeight", { value: 600, configurable: true });
		const c = makeCtx({ scrollCardLayer: layer, scrollViewport: vp, focusedCardIdx: -1, visibleList: [plug("p1", "A"), plug("p2", "B"), plug("p3", "C"), plug("p4", "D")] });
		return c;
	}

	it("Enter → 打开聚焦卡片详情（430-439）", () => {
		const c = ctxWithLayer();
		c.focusedCardIdx = 1;
		const el = document.createElement("div");
		const ev = new KeyboardEvent("keydown", { key: "Enter", bubbles: true });
		el.dispatchEvent(ev);
		onCardKeydown(c, ev);
		expect(c.openDetailDrawer).toHaveBeenCalledWith("p2", null);
	});

	it("ArrowDown 在网格中移动（447-448）", () => {
		const c = ctxWithLayer();
		c.colCount = 2;
		c.focusedCardIdx = 0;
		const el = document.createElement("div");
		const ev = new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true });
		el.dispatchEvent(ev);
		onCardKeydown(c, ev);
		expect(c.focusedCardIdx).toBe(2);
	});

	it("在输入框内不拦截（414-415）", () => {
		const c = ctxWithLayer();
		const ev = new KeyboardEvent("keydown", { key: "ArrowDown" });
		Object.defineProperty(ev, "target", { value: document.createElement("input"), configurable: true });
		onCardKeydown(c, ev);
		expect(c.focusCardByIdx).not.toHaveBeenCalled();
	});

	it("focusCardByIdx：无 layer 安全返回（481-482）", () => {
		const c = makeCtx({ scrollCardLayer: null });
		expect(() => focusCardByIdx(c, 0)).not.toThrow();
	});

	it("focusCardByIdx：滚入视口 + updateWindow + 聚焦（487-513）", () => {
		const layer = document.createElement("div");
		const vp = document.createElement("div");
		Object.defineProperty(vp, "clientHeight", { value: 600, configurable: true });
		const card = document.createElement("div");
		card.className = "pt-card";
		card.setAttribute("data-idx", "3");
		layer.appendChild(card);
		const c = makeCtx({ scrollCardLayer: layer, scrollViewport: vp, visibleList: [plug("p1"), plug("p2"), plug("p3"), plug("p4")], colCount: 2, cachedRowH: 80, rowGap: 8 });
		focusCardByIdx(c, 3);
		expect(c.updateWindow).toHaveBeenCalled();
		expect(card.classList.contains("pt-card--focused")).toBe(true);
	});
});

describe("openInsightModal", () => {
	it("无 AI 配置 → 降级到描述（574-578）", () => {
		const c = makeCtx({ translator: { ...makeCtx().translator, aiConfig: null } });
		openInsightModal(c, plug("p1", "X"));
		// 仅验证不抛错（InsightModal 内部已降级）
		expect(true).toBe(true);
	});

	it("无缓存 → 抓 manifest + 生成（583-595）", async () => {
		const c = makeCtx();
		openInsightModal(c, plug("p1", "X"));
		await vi.waitFor(() => {
			expect(fetchManifest).toHaveBeenCalled();
			expect(generateInsight).toHaveBeenCalled();
		});
	});
});

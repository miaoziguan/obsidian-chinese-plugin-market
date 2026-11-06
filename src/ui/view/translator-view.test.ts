import { describe, it, expect, vi, beforeEach } from "vitest";
import { ChinesePluginMarketView } from "@ui/view/translator-view";
import { VIEW_TYPE } from "@shared/constants";
import type ChinesePluginMarketPlugin from "@app/plugin";
import type { WorkspaceLeaf } from "obsidian";
import type { TranslateResult } from "@domain/catalog/translator";

// 测试环境下用可控 stub 替换 obsidian（与 direct-install.test 同模式），避免依赖 Obsidian 运行时的
// 真实 ItemView/Modal/MarkdownRenderer 等实现；同时覆盖委托模块（view-render/cards/detail-drawer 等）
// 顶层 import 所需的全部 obsidian 导出，确保模块链加载不崩。
vi.mock("obsidian", () => ({
	ItemView: class {
		leaf: unknown;
		app: unknown;
		contentEl: HTMLElement;
		containerEl: HTMLElement;
		constructor(leaf: unknown) {
			this.leaf = leaf;
			this.app = (leaf as { app?: unknown })?.app;
			this.contentEl = document.createElement("div");
			this.containerEl = document.createElement("div");
		}
	},
	WorkspaceLeaf: class {},
	Platform: { isMobile: false, isDesktop: true, isWin: false, isMacOS: false, isLinux: false },
	Notice: class {
		constructor(_m?: string, _o?: unknown) {}
	},
	App: class {},
	Modal: class {
		constructor(_app?: unknown) {}
	},
	Component: class {
		load() {}
		unload() {}
		registerEvent() {}
		registerDomEvent() {}
		addChild() {
			return this as unknown;
		}
		removeChild() {}
		onload() {}
		onunload() {}
	},
	Menu: class {
		addItem() {
			return this as unknown;
		}
		addSeparator() {
			return this as unknown;
		}
		showAtMouseEvent() {}
		showAtPosition() {}
	},
	MarkdownRenderer: { render: vi.fn(), renderMarkdown: vi.fn() },
	setIcon: vi.fn(),
	requestUrl: vi.fn(),
}));

const makeView = (opts: { translate?: boolean; cache?: unknown } = {}) => {
	const translator = { hasAnyTranslation: vi.fn().mockReturnValue(opts.translate ?? false) };
	const settings = {
		sourceFilter: "all",
		sortBy: "relevance",
		favorites: [] as string[],
		compare: [] as string[],
		defaultNewWithinDays: 7,
		defaultUpdatedWithinDays: 7,
	};
	const plugin = {
		translator,
		settings,
		lastListFetchAt: 0,
		loadPluginListCache: vi.fn().mockResolvedValue(opts.cache ?? null),
	} as unknown as ChinesePluginMarketPlugin;
	const leaf = { app: {} } as unknown as WorkspaceLeaf;
	const view = new ChinesePluginMarketView(leaf, plugin);
	return { view, translator, settings, plugin };
};

describe("ChinesePluginMarketView · 元数据与纯方法（不依赖完整 DOM 渲染）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("getViewType 返回 VIEW_TYPE", () => {
		const { view } = makeView();
		expect(view.getViewType()).toBe(VIEW_TYPE);
	});

	it("getDisplayText 返回「插件搜索」", () => {
		const { view } = makeView();
		expect(view.getDisplayText()).toBe("插件搜索");
	});

	it("getIcon 返回 languages", () => {
		const { view } = makeView();
		expect(view.getIcon()).toBe("languages");
	});

	it("isTranslated：会话已翻译（translatedResults.source≠original）→ true", () => {
		const { view } = makeView();
		view.translatedResults["a"] = {
			source: "online",
			translatedName: "n",
			translatedDesc: "d",
		} as unknown as TranslateResult;
		expect(view.isTranslated({ id: "a" } as never)).toBe(true);
	});

	it("isTranslated：无会话译文且 translator.hasAnyTranslation=true → true", () => {
		const { view } = makeView({ translate: true });
		expect(view.isTranslated({ id: "b", name: "B" } as never)).toBe(true);
	});

	it("isTranslated：无会话译文且 translator.hasAnyTranslation=false → false", () => {
		const { view } = makeView({ translate: false });
		expect(view.isTranslated({ id: "c", name: "C" } as never)).toBe(false);
	});

	it("removeCompareTray：有 compareTrayEl → remove 被调用并置 null", () => {
		const { view } = makeView();
		const remove = vi.fn();
		view.compareTrayEl = { remove } as unknown as HTMLElement;
		view.removeCompareTray();
		expect(remove).toHaveBeenCalled();
		expect(view.compareTrayEl).toBeNull();
	});

	it("removeCompareTray：compareTrayEl 为 null → 不抛", () => {
		const { view } = makeView();
		view.compareTrayEl = null;
		expect(() => view.removeCompareTray()).not.toThrow();
	});

	it("refreshCompareHighlights：无卡片 → 不抛（空路径覆盖）", () => {
		const { view } = makeView();
		expect(() => view.refreshCompareHighlights()).not.toThrow();
	});

	it("refreshCompareHighlights：卡片在 compareSet → toggle is-compare-on", () => {
		const { view } = makeView();
		view.contentEl.innerHTML =
			'<div class="pt-card" data-plugin-id="x"><div class="pt-card-compare"></div></div>';
		view.compareSet.add("x");
		view.refreshCompareHighlights();
		const el = view.contentEl.querySelector(".pt-card-compare")!;
		expect(el.classList.contains("is-compare-on")).toBe(true);
	});

	it("tryLoadCachedPluginList：缓存非空 → 返回列表", async () => {
		const { view } = makeView({ cache: [{ id: "a" }] });
		const r = await view.tryLoadCachedPluginList();
		expect(r).toEqual([{ id: "a" }]);
	});

	it("tryLoadCachedPluginList：缓存为 null → 返回 null", async () => {
		const { view } = makeView({ cache: null });
		expect(await view.tryLoadCachedPluginList()).toBeNull();
	});

	it("tryLoadCachedPluginList：缓存为空数组 → 返回 null", async () => {
		const { view } = makeView({ cache: [] });
		expect(await view.tryLoadCachedPluginList()).toBeNull();
	});
});

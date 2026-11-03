import { describe, it, expect, vi, beforeEach } from "vitest";
import { updateCompareTray, openCompareModal, enterCompareMode, exitCompareMode } from "@ui/view/view-compare";
import { renderComparePage, disposeComparePage } from "@ui/components/compare-view";

/**
 * 补 ui/view/view-compare.ts（此前 11.4%，行 11-201 共 5 个导出/内部函数）。该函数组以 ViewContext 为
 * 唯一输入，依赖真实 obsidian 的 HTMLElement 扩展（setCssStyles/createDiv/createEl/empty 在 jsdom 下可用），
 * 故不 mock obsidian；仅把 compare-view 的 renderComparePage/disposeComparePage 换成 no-op 桩，使测试聚焦
 * 本文件自身的托盘/模式切换/高亮刷新逻辑。
 *
 * 错误模式「对比托盘在空集/单集下仍渲染或按钮可用」「进入对比模式未互斥关闭详情 Drawer/未隐藏推荐区」
 * 「退出对比模式后推荐区/虚拟滚动层/对比高亮未恢复、列表不重渲」「移除插件后整页重建闪烁而非增量重绘」。
 *
 * 本文件自包含，用伪造 ViewContext；本轮绝不碰已有测试文件。
 */

vi.mock("@ui/components/compare-view", () => ({
	renderComparePage: vi.fn(),
	disposeComparePage: vi.fn(),
}));

function withHelpers(el: HTMLElement) {
	const n = el as unknown as Record<string, unknown>;
	const add = (child: HTMLElement) => withHelpers(child);
	n.empty = function (this: HTMLElement) {
		while (this.firstChild) this.removeChild(this.firstChild);
		return this;
	};
	n.createDiv = function (this: HTMLElement, opts: { cls?: string; text?: string } = {}) {
		const e = document.createElement("div");
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		this.appendChild(e);
		return add(e);
	};
	n.createSpan = function (this: HTMLElement, opts: { cls?: string; text?: string } = {}) {
		const e = document.createElement("span");
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		this.appendChild(e);
		return add(e);
	};
	n.createEl = function (this: HTMLElement, tag: string, opts: { cls?: string; text?: string; title?: string } = {}) {
		const e = document.createElement(tag);
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		if (opts.title) e.title = opts.title;
		this.appendChild(e);
		return add(e);
	};
	n.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		for (const k of Object.keys(styles)) this.style.setProperty(k, styles[k]);
		return this;
	};
	n.addClass = function (this: HTMLElement, cls: string) {
		this.classList.add(cls);
		return this;
	};
	return el;
}

function makeCtx(over: Record<string, unknown> = {}) {
	const featured = withHelpers(document.createElement("div"));
	featured.className = "pt-featured";
	const contentEl = withHelpers(document.createElement("div"));
	contentEl.appendChild(featured);
	const ctx: any = {
		contentEl,
		compareSet: new Set<string>(),
		compareTrayEl: null as HTMLElement | null,
		compareMode: false,
		settings: { compare: [] as string[] },
		plugins: [
			{ id: "a", name: "A", description: "da" },
			{ id: "b", name: "B", description: "db" },
		],
		translatedResults: {} as Record<string, unknown>,
		translator: { lookupTMApproved: vi.fn(() => null) },
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		mirrorConfig: {},
		scrollViewport: withHelpers(document.createElement("div")),
		activeDrawer: { close: vi.fn() },
		t: vi.fn((k: string) => k),
		track: vi.fn(),
		removeCompareTray: vi.fn(function (this: { compareTrayEl: HTMLElement | null }) {
			this.compareTrayEl = null;
		}),
		refreshCompareHighlights: vi.fn(),
		flushSaveSettings: vi.fn(async () => {}),
		openCompareModal: vi.fn(),
		enterCompareMode: vi.fn(),
		exitCompareMode: vi.fn(),
		updateCompareTray: vi.fn(),
		scheduleRender: vi.fn(),
		...over,
	};
	return ctx;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("updateCompareTray（view-compare.ts 11-53）", () => {
	it("空集 → 移除托盘并刷新高亮、不创建（14-18）", () => {
		const ctx = makeCtx();
		updateCompareTray(ctx);
		expect(ctx.removeCompareTray).toHaveBeenCalled();
		expect(ctx.refreshCompareHighlights).toHaveBeenCalled();
		expect((ctx.contentEl as HTMLElement).querySelector(".pt-compare-tray")).toBeNull();
	});

	it("单集 → 托盘渲染、open 按钮禁用（19-35）", () => {
		const ctx = makeCtx();
		(ctx.compareSet as Set<string>).add("a");
		updateCompareTray(ctx);
		const tray = (ctx.contentEl as HTMLElement).querySelector(".pt-compare-tray") as HTMLElement;
		expect(tray).toBeTruthy();
		const openBtn = tray.querySelector(".pt-compare-tray-open") as HTMLButtonElement;
		expect(openBtn.disabled).toBe(true);
	});

	it("双集 → open 按钮可用，点击触发 openCompareModal（28-36）", () => {
		const ctx = makeCtx();
		(ctx.compareSet as Set<string>).add("a");
		(ctx.compareSet as Set<string>).add("b");
		updateCompareTray(ctx);
		const tray = (ctx.contentEl as HTMLElement).querySelector(".pt-compare-tray") as HTMLElement;
		const openBtn = tray.querySelector(".pt-compare-tray-open") as HTMLButtonElement;
		expect(openBtn.disabled).toBe(false);
		openBtn.click();
		expect(ctx.openCompareModal).toHaveBeenCalled();
	});

	it("clear 按钮 → 清空对比集、落盘、移除托盘并刷新高亮（37-49）", () => {
		const ctx = makeCtx();
		(ctx.compareSet as Set<string>).add("a");
		(ctx.compareSet as Set<string>).add("b");
		updateCompareTray(ctx);
		const tray = (ctx.contentEl as HTMLElement).querySelector(".pt-compare-tray") as HTMLElement;
		const clearBtn = tray.querySelector(".pt-compare-tray-clear") as HTMLButtonElement;
		clearBtn.click();
		expect((ctx.compareSet as Set<string>).size).toBe(0);
		expect((ctx.settings as { compare: string[] }).compare).toEqual([]);
		expect(ctx.flushSaveSettings).toHaveBeenCalled();
		expect(ctx.removeCompareTray).toHaveBeenCalledTimes(1); // clear 处理器内一次
		expect(ctx.refreshCompareHighlights).toHaveBeenCalled();
	});
});

describe("openCompareModal（view-compare.ts 55-63）", () => {
	it("不足 2 个 → 直接返回、不触发 enterCompareMode（57-60）", () => {
		const ctx = makeCtx();
		(ctx.compareSet as Set<string>).add("a");
		openCompareModal(ctx);
		expect(ctx.enterCompareMode).not.toHaveBeenCalled();
	});

	it("≥2 个 → 触发 enterCompareMode（59-61）", () => {
		const ctx = makeCtx();
		(ctx.compareSet as Set<string>).add("a");
		(ctx.compareSet as Set<string>).add("b");
		openCompareModal(ctx);
		expect(ctx.enterCompareMode).toHaveBeenCalled();
	});
});

describe("enterCompareMode（view-compare.ts 65-110）", () => {
	it("不足 2 个 → 直接返回（67-69）", () => {
		const ctx = makeCtx();
		(ctx.compareSet as Set<string>).add("a");
		enterCompareMode(ctx);
		expect(ctx.compareMode).toBe(false);
		expect(ctx.track).not.toHaveBeenCalled();
	});

	it("≥2 个 → 互斥关 Drawer、置模式、埋点、隐藏推荐/滚动层、建容器、渲染（65-108）", () => {
		const ctx = makeCtx();
		const drawer = ctx.activeDrawer as { close: ReturnType<typeof vi.fn> };
		(ctx.compareSet as Set<string>).add("a");
		(ctx.compareSet as Set<string>).add("b");
		enterCompareMode(ctx);
		expect(ctx.compareMode).toBe(true);
		expect(drawer.close).toHaveBeenCalled();
		expect(ctx.activeDrawer).toBeNull();
		expect(ctx.track).toHaveBeenCalledWith("action:compare_open");
		// 推荐区被隐藏、滚动层被隐藏
		const featured = (ctx.contentEl as HTMLElement).querySelector(".pt-featured") as HTMLElement;
		expect(featured.style.display).toBe("none");
		expect((ctx.scrollViewport as HTMLElement).style.display).toBe("none");
		// 对比容器被创建并渲染
		const container = (ctx.contentEl as HTMLElement).querySelector(".pt-compare-container");
		expect(container).toBeTruthy();
		expect(renderComparePage).toHaveBeenCalled();
		expect(ctx.removeCompareTray).toHaveBeenCalled();
	});
});

describe("exitCompareMode（view-compare.ts 165-201）", () => {
	it("→ 退出模式、恢复推荐/滚动层、卸载对比页、重渲与刷新（165-200）", () => {
		const ctx = makeCtx();
		ctx.compareMode = true;
		// 模拟已进入对比态：contentEl 内有对比容器
		const container = (ctx.contentEl as HTMLElement).createDiv({ cls: "pt-compare-container" });
		exitCompareMode(ctx);
		expect(ctx.compareMode).toBe(false);
		const featured = (ctx.contentEl as HTMLElement).querySelector(".pt-featured") as HTMLElement;
		expect(featured.style.display).toBe("");
		expect((ctx.scrollViewport as HTMLElement).style.display).toBe("");
		expect(disposeComparePage).toHaveBeenCalledWith(container);
		expect(ctx.updateCompareTray).toHaveBeenCalled();
		expect(ctx.refreshCompareHighlights).toHaveBeenCalled();
		expect(ctx.scheduleRender).toHaveBeenCalledWith(true);
	});
});

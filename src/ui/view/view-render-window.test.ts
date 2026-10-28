import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "./view-context";
import {
	scheduleRender,
	measureLayout,
	measureLayoutIfNeeded,
	disposeRenderTimers,
	renderWindow,
	updateWindow,
	fillVisibleWindow,
} from "./view-render";

/**
 * 虚拟滚动的调度层：何时重渲、怎么量布局、窗口取哪一段。
 *
 * 这部分最容易出的不是崩溃，而是**性能退化**：多排一次 rAF、每帧读一次
 * getComputedStyle、或预取永远取满 5 行——单次都看不出来，累积起来就是
 * 滚动掉帧。所以断言重点放在「有没有多做」上。
 */

type Ctx = Record<string, unknown>;

function makeCtx(over: Ctx = {}): ViewContext {
	const ctx: Ctx = {
		visibleList: [] as PluginInfo[],
		scrollViewport: null,
		scrollCardLayer: null,
		colCount: 0,
		cachedRowH: 0,
		cachedScrollHeight: 0,
		rowGap: 0,
		layoutDirty: false,
		scrollVelocity: 0,
		renderRAF: 0,
		pendingCards: new Set<HTMLElement>(),
		fillIdleHandle: null,
		disposed: false,
		viewTab: "catalog",
		renderPluginList: vi.fn(),
		renderUpdatesList: vi.fn(),
		renderBetaList: vi.fn(),
		fillVisibleWindow: vi.fn(),
		updateWindow: vi.fn(),
		...over,
	};
	return ctx as unknown as ViewContext;
}

const makeViewport = (clientWidth: number, clientHeight = 600, scrollTop = 0) => {
	const vp = document.createElement("div");
	Object.defineProperty(vp, "clientWidth", { value: clientWidth, configurable: true });
	Object.defineProperty(vp, "clientHeight", { value: clientHeight, configurable: true });
	Object.defineProperty(vp, "scrollHeight", { value: 2000, configurable: true });
	vp.scrollTop = scrollTop;
	return vp;
};

beforeEach(() => {
	vi.useFakeTimers({ toFake: ["requestAnimationFrame", "cancelAnimationFrame", "setTimeout", "clearTimeout"] });
});

afterEach(() => {
	vi.useRealTimers();
});

describe("scheduleRender：按页签分流 + rAF 去重", () => {
	it("「更新」页签走专用列表渲染，不排虚拟卡片渲染", () => {
		const ctx = makeCtx({ viewTab: "updates" });
		scheduleRender(ctx);
		expect(ctx.renderUpdatesList).toHaveBeenCalled();
		expect(ctx.renderPluginList).not.toHaveBeenCalled();
	});

	it("「直链」页签同样分流", () => {
		const ctx = makeCtx({ viewTab: "beta" });
		scheduleRender(ctx);
		expect(ctx.renderBetaList).toHaveBeenCalled();
	});

	it("一帧内多次调度只执行一次（renderRAF 去重）", async () => {
		const ctx = makeCtx();
		scheduleRender(ctx);
		scheduleRender(ctx);
		scheduleRender(ctx);

		await vi.advanceTimersByTimeAsync(20);

		expect(ctx.renderPluginList).toHaveBeenCalledTimes(1);
	});

	it("执行后清除 renderRAF，允许下一帧继续调度", async () => {
		const ctx = makeCtx();
		scheduleRender(ctx);
		await vi.advanceTimersByTimeAsync(20);
		expect(ctx.renderRAF).toBe(0);

		scheduleRender(ctx);
		await vi.advanceTimersByTimeAsync(20);
		expect(ctx.renderPluginList).toHaveBeenCalledTimes(2);
	});

	it("preserveScroll 透传给渲染函数", async () => {
		const ctx = makeCtx();
		scheduleRender(ctx, true);
		await vi.advanceTimersByTimeAsync(20);
		expect(ctx.renderPluginList).toHaveBeenCalledWith(true);
	});
});

describe("measureLayout：布局测量与缓存", () => {
	it("缺少视口或卡片层时直接返回（不写脏数据）", () => {
		const ctx = makeCtx({ cachedRowH: 77 });
		measureLayout(ctx);
		expect(ctx.cachedRowH).toBe(77);
	});

	it("按可用宽度算出列数并同步 grid 模板", () => {
		const vp = makeViewport(1200);
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollViewport: vp, scrollCardLayer: layer });

		measureLayout(ctx);

		expect(ctx.colCount).toBeGreaterThan(0);
		expect(layer.style.gridTemplateColumns).toContain("repeat(");
	});

	it("缓存行高（卡片高 + 行距），供滚动时复用避免每帧 getComputedStyle", () => {
		const vp = makeViewport(1000);
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollViewport: vp, scrollCardLayer: layer });

		measureLayout(ctx);

		expect(ctx.cachedRowH).toBeGreaterThan(0);
	});

	it("缓存 scrollHeight，供滚动按钮每帧复用", () => {
		const vp = makeViewport(1000);
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollViewport: vp, scrollCardLayer: layer });

		measureLayout(ctx);

		expect(ctx.cachedScrollHeight).toBe(2000);
	});

	it("测量完成后清除 layoutDirty（否则每帧都会重测）", () => {
		const vp = makeViewport(1000);
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollViewport: vp, scrollCardLayer: layer, layoutDirty: true });

		measureLayout(ctx);

		expect(ctx.layoutDirty).toBe(false);
	});

	it("已有滚动位置时按比例恢复（列数变化后不跳回顶部）", async () => {
		const vp = makeViewport(1000, 600, 500);
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollViewport: vp, scrollCardLayer: layer });

		measureLayout(ctx);
		await vi.advanceTimersByTimeAsync(20);

		// ratio = 500 / 2000 = 0.25 → 0.25 * scrollHeight
		expect(vp.scrollTop).toBe(500);
	});
});

describe("measureLayoutIfNeeded：只在脏时测量", () => {
	it("未标脏时不测量", () => {
		const vp = makeViewport(1000);
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollViewport: vp, scrollCardLayer: layer, layoutDirty: false });

		measureLayoutIfNeeded(ctx);

		expect(ctx.colCount).toBe(0);
	});

	it("标脏时才测量", () => {
		const vp = makeViewport(1000);
		const layer = document.createElement("div");
		const ctx = makeCtx({ scrollViewport: vp, scrollCardLayer: layer, layoutDirty: true });

		measureLayoutIfNeeded(ctx);

		expect(ctx.colCount).toBeGreaterThan(0);
	});
});

describe("disposeRenderTimers：卸载清理", () => {
	it("清空行高缓存（per-view 状态，避免幽灵写入）", () => {
		const ctx = makeCtx({ cachedRowH: 140 });
		disposeRenderTimers(ctx);
		expect(ctx.cachedRowH).toBe(0);
	});
});

describe("renderWindow / updateWindow / fillVisibleWindow：无视口时的降级", () => {
	it("没有视口时 renderWindow 不崩溃", () => {
		const ctx = makeCtx();
		expect(() => renderWindow(ctx)).not.toThrow();
	});

	it("没有卡片层时 updateWindow 安全返回", () => {
		const ctx = makeCtx();
		expect(() => updateWindow(ctx)).not.toThrow();
	});

	it("没有卡片层时 fillVisibleWindow 安全返回", () => {
		const ctx = makeCtx();
		expect(() => fillVisibleWindow(ctx)).not.toThrow();
	});
});

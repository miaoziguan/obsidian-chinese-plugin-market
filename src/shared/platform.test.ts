import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { isMobileEnvironment, isTouchEnvironment, requestIdle, cancelIdle } from "./platform";

// Platform 是 obsidian 的命名导出，用 getter 动态返回以便逐例模拟 undefined / isMobile / 抛错
const h = vi.hoisted(() => ({ Platform: { isMobile: false } as unknown }));
vi.mock("obsidian", () => ({
	get Platform() {
		return h.Platform;
	},
}));

beforeEach(() => {
	vi.clearAllMocks();
	h.Platform = { isMobile: false };
});
afterEach(() => {
	vi.unstubAllGlobals();
	vi.useRealTimers();
});

describe("isMobileEnvironment", () => {
	it("Platform 未定义（jsdom 模拟）→ false", () => {
		h.Platform = undefined;
		expect(isMobileEnvironment()).toBe(false);
	});

	it("Platform.isMobile === true → true", () => {
		h.Platform = { isMobile: true };
		expect(isMobileEnvironment()).toBe(true);
	});

	it("isMobile 非 true → false", () => {
		h.Platform = { isMobile: false };
		expect(isMobileEnvironment()).toBe(false);
		h.Platform = {};
		expect(isMobileEnvironment()).toBe(false);
	});

	it("读取 Platform.isMobile 抛错 → catch 返回 false", () => {
		h.Platform = {
			get isMobile() {
				throw new Error("boom");
			},
		};
		expect(isMobileEnvironment()).toBe(false);
	});
});

describe("isTouchEnvironment", () => {
	it("window 未定义 → false", () => {
		vi.stubGlobal("window", undefined);
		expect(isTouchEnvironment()).toBe(false);
	});

	it("matchMedia 缺失 → false", () => {
		vi.stubGlobal("matchMedia", undefined);
		expect(isTouchEnvironment()).toBe(false);
	});

	it("matchMedia 非函数 → false", () => {
		vi.stubGlobal("matchMedia", "not-a-function");
		expect(isTouchEnvironment()).toBe(false);
	});

	it("matches === true → true，且查询的是 coarse pointer 媒体串", () => {
		const mm = vi.fn(() => ({ matches: true }));
		vi.stubGlobal("matchMedia", mm);
		expect(isTouchEnvironment()).toBe(true);
		expect(mm).toHaveBeenCalledWith("(hover: none) and (pointer: coarse)");
	});

	it("matches 非 true → false", () => {
		vi.stubGlobal("matchMedia", () => ({ matches: false }));
		expect(isTouchEnvironment()).toBe(false);
		vi.stubGlobal("matchMedia", () => ({ matches: 1 }));
		expect(isTouchEnvironment()).toBe(false);
	});

	it("matchMedia 抛错 → catch 返回 false", () => {
		vi.stubGlobal("matchMedia", () => {
			throw new Error("boom");
		});
		expect(isTouchEnvironment()).toBe(false);
	});
});

describe("requestIdle / cancelIdle", () => {
	it("原生 requestIdleCallback 可用 → 传 timeout 并回调", () => {
		const ric = vi.fn((cb: () => void) => {
			cb();
			return 7;
		});
		vi.stubGlobal("requestIdleCallback", ric);
		const cb = vi.fn();
		expect(requestIdle(cb, 200)).toBe(7);
		expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 200 });
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("默认 timeoutMs=100 透传", () => {
		const ric = vi.fn(() => 1);
		vi.stubGlobal("requestIdleCallback", ric);
		requestIdle(vi.fn());
		expect(ric).toHaveBeenCalledWith(expect.any(Function), { timeout: 100 });
	});

	it("缺失 rIC → 降级 setTimeout，超时封顶 50ms", () => {
		vi.useFakeTimers();
		vi.stubGlobal("requestIdleCallback", undefined);
		const cb = vi.fn();
		const handle = requestIdle(cb, 200);
		expect(handle).toBeDefined(); // fake timers 下句柄为 timer 对象而非 number
		expect(cb).not.toHaveBeenCalled();
		vi.advanceTimersByTime(49);
		expect(cb).not.toHaveBeenCalled();
		vi.advanceTimersByTime(1);
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("缺失 rIC 且 timeoutMs 小于 50 → 用较小的 timeoutMs", () => {
		vi.useFakeTimers();
		vi.stubGlobal("requestIdleCallback", undefined);
		const cb = vi.fn();
		requestIdle(cb, 10);
		vi.advanceTimersByTime(10);
		expect(cb).toHaveBeenCalledTimes(1);
	});

	it("cancelIdle 有原生 cancelIdleCallback → 调它", () => {
		const cic = vi.fn();
		vi.stubGlobal("cancelIdleCallback", cic);
		cancelIdle(42);
		expect(cic).toHaveBeenCalledWith(42);
	});

	it("cancelIdle 无原生 → 降级 clearTimeout", () => {
		vi.useFakeTimers();
		vi.stubGlobal("cancelIdleCallback", undefined);
		const clear = vi.spyOn(window, "clearTimeout");
		cancelIdle(99);
		expect(clear).toHaveBeenCalledWith(99);
	});
});

import { describe, it, expect, vi } from "vitest";
import { loadSettingsDataSafely, armTmApprovedSafetyValve } from "./startup-guards";

/**
 * 启动期的两个「沉默失败」防护。
 *
 * 这类代码平时不生效、出事才救命，最容易被后来的人当成冗余删掉——
 * 删了也不会有任何测试变红，直到某天用户报「插件打不开」。
 */

describe("loadSettingsDataSafely：data.json 损坏不阻断启动", () => {
	it("正常时原样返回数据", async () => {
		const data = { locale: "zh", profiles: [] };
		await expect(loadSettingsDataSafely({ load: async () => data, warn: vi.fn() })).resolves.toBe(data);
	});

	it("loadData 返回 null 时回退为空对象", async () => {
		await expect(loadSettingsDataSafely({ load: async () => null, warn: vi.fn() })).resolves.toEqual({});
	});

	it("解析抛错时回退为空对象且不向上抛（否则整个 onload 中止）", async () => {
		const warn = vi.fn();
		const boom = new SyntaxError("Unexpected token } in JSON");

		await expect(loadSettingsDataSafely({ load: async () => { throw boom; }, warn })).resolves.toEqual({});
		expect(warn).toHaveBeenCalledTimes(1);
		// 必须把原始错误传出去，否则日志里只剩一句话，无法定位
		expect(warn.mock.calls[0][1]).toBe(boom);
	});

	it("提示文案点明「原文件可能损坏」，便于用户自查", async () => {
		const warn = vi.fn();
		await loadSettingsDataSafely({ load: async () => { throw new Error("x"); }, warn });
		expect(String(warn.mock.calls[0][0])).toContain("原文件可能损坏");
	});
});

describe("armTmApprovedSafetyValve：30s 兜底放行", () => {
	function makeDeps() {
		let timerFn: (() => void) | null = null;
		let timerMs = -1;
		const deps = {
			originalResolve: vi.fn(),
			setResolve: vi.fn(),
			warn: vi.fn(),
			timer: (fn: () => void, ms: number) => {
				timerFn = fn;
				timerMs = ms;
				return 0;
			},
		};
		return {
			deps,
			fireTimer: () => timerFn?.(),
			getTimerMs: () => timerMs,
			wrappedResolve: () => deps.setResolve.mock.calls[0]?.[0] as () => void,
		};
	}

	it("用包装函数替换 resolve，原始实现只保留一份引用", () => {
		const { deps } = makeDeps();
		armTmApprovedSafetyValve(deps);

		expect(deps.setResolve).toHaveBeenCalledTimes(1);
		expect(deps.setResolve.mock.calls[0][0]).toBeTypeOf("function");
	});

	it("回灌正常完成时，到点不误报「兜底超时」", () => {
		const { deps, fireTimer, wrappedResolve } = makeDeps();
		armTmApprovedSafetyValve(deps);

		wrappedResolve()(); // 正常放行
		fireTimer(); // 30s 到点

		expect(deps.warn).not.toHaveBeenCalled();
		expect(deps.originalResolve).toHaveBeenCalledTimes(1);
	});

	it("超时未放行时告警并强制 resolve，避免视图永久停在加载页", () => {
		const { deps, fireTimer } = makeDeps();
		armTmApprovedSafetyValve(deps);

		fireTimer();

		expect(deps.warn).toHaveBeenCalledTimes(1);
		expect(String(deps.warn.mock.calls[0][0])).toContain("兜底超时");
		expect(deps.originalResolve).toHaveBeenCalledTimes(1);
	});

	it("默认等待 30s", () => {
		const { deps, getTimerMs } = makeDeps();
		armTmApprovedSafetyValve(deps);
		expect(getTimerMs()).toBe(30_000);
	});

	it("可配置超时时间（测试与特殊环境）", () => {
		const { deps, getTimerMs } = makeDeps();
		armTmApprovedSafetyValve({ ...deps, timeoutMs: 500 });
		expect(getTimerMs()).toBe(500);
	});

	it("超时后再调包装函数不会再次触发原始 resolve（幂等）", () => {
		const { deps, fireTimer, wrappedResolve } = makeDeps();
		armTmApprovedSafetyValve(deps);

		fireTimer();
		wrappedResolve()();

		// 超时一次 + 后续显式调用一次；不应因超时逻辑再多调
		expect(deps.originalResolve).toHaveBeenCalledTimes(2);
	});
});

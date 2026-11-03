import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startInstalledWatch } from "@ui/view/installed-watch";

/**
 * 补 ui/view/installed-watch.ts（16% → 整方法）。该文件只有一个导出函数 startInstalledWatch(ctx)，
 * 通过伪造 ViewContext 即可覆盖：无 vault 路径→空 disposer、桌面 fs.watch 分支、fs.watch 启动失败→
 * 降级轮询、移动端 60s 轮询、onChange 的快照+diff+recordInstallDiff+applyCardState+重渲、disposer 释放。
 * 错误模式「已安装插件状态（桌面监听/移动轮询）不刷新卡片徽标、卸载后列表成员不重渲」。
 *
 * 手法：applyCardState 经 vi.mock 替换以避免真 DOM 操作；logger 经 vi.mock 换带 spy 的桩；window.require
 * 在桌面用例里临时挂一个返回 fs.watch 的桩。本文件自包含，无需插件实例。本轮绝不碰已有测试文件。
 */

const applyCardStateMock = vi.hoisted(() => vi.fn());
vi.mock("@ui/components/card-render", () => ({ applyCardState: applyCardStateMock }));
const loggerMock = vi.hoisted(() => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", () => ({ logger: loggerMock }));

type Ctx = Record<string, any>;

function makeCtx(basePath: string | undefined, extra: Record<string, any> = {}) {
	const ctx: Ctx = {
		app: { vault: { adapter: { basePath } } },
		disposed: false,
		installedIds: new Set<string>(["a"]),
		snapshotInstalled: vi.fn(function () {
			// 模拟快照变化：新增 b（必须替换引用，否则 before/after 同一 Set → diff 为空）
			ctx.installedIds = new Set([...ctx.installedIds, "b"]);
		}),
		enabledIds: new Set<string>(),
		plugin: { recordInstallDiff: vi.fn(async () => {}) },
		cardPoolCtx: {},
		cardById: new Map<string, unknown>(),
		plugins: [{ id: "b" }],
		translatedResults: {},
		scheduleRender: vi.fn(),
		...extra,
	};
	return ctx;
}

beforeEach(() => {
	vi.clearAllMocks();
	applyCardStateMock.mockClear();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
	delete (window as unknown as { require?: unknown }).require;
});

describe("startInstalledWatch（installed-watch.ts 整方法）", () => {
	it("无 vault 路径 → 返回空 disposer、不启动任何监听（43-46）", () => {
		const ctx = makeCtx(undefined);
		const dispose = startInstalledWatch(ctx as never);
		expect(typeof dispose).toBe("function");
		expect(loggerMock.debug).toHaveBeenCalled();
		// 空 disposer 调用不应抛错
		expect(() => dispose()).not.toThrow();
	});

	it("桌面 fs.watch：启动监听；触发事件经 500ms 防抖后 onChange 刷新（102-111, 97-100, 54-95）", () => {
		let watchCb: (() => void) | null = null;
		const fakeWatch = vi.fn((_dir: string, cb: () => void) => {
			watchCb = cb;
			return { close: vi.fn() };
		});
		(window as unknown as { require: unknown }).require = vi.fn(() => ({ watch: fakeWatch }));
		const ctx = makeCtx("/vault");
		ctx.cardById.set("b", { dataset: {} });
		const dispose = startInstalledWatch(ctx as never);
		expect(fakeWatch).toHaveBeenCalled();
		// 触发一次文件系统事件
		watchCb!();
		// 500ms 防抖后 onChange 执行
		vi.advanceTimersByTime(500);
		expect(ctx.snapshotInstalled).toHaveBeenCalled();
		expect(ctx.plugin.recordInstallDiff).toHaveBeenCalled();
		expect(applyCardStateMock).toHaveBeenCalled();
		expect(ctx.scheduleRender).toHaveBeenCalled();
		dispose();
	});

	it("fs.watch 启动抛错 → 降级为 60s 轮询（107-110, 113-117）", () => {
		const fakeWatch = vi.fn(() => {
			throw new Error("cannot watch");
		});
		(window as unknown as { require: unknown }).require = vi.fn(() => ({ watch: fakeWatch }));
		const ctx = makeCtx("/vault");
		startInstalledWatch(ctx as never);
		expect(loggerMock.warn).toHaveBeenCalled();
	});

	it("移动端（无 require）→ 60s 轮询；到点 onChange 刷新后 dispose 清定时器（113-117, 119-130）", () => {
		const ctx = makeCtx("/vault");
		ctx.cardById.set("b", { dataset: {} });
		const dispose = startInstalledWatch(ctx as never);
		// 推进 60s 触发轮询回调
		vi.advanceTimersByTime(60_000);
		expect(ctx.snapshotInstalled).toHaveBeenCalled();
		expect(ctx.plugin.recordInstallDiff).toHaveBeenCalled();
		expect(applyCardStateMock).toHaveBeenCalled();
		expect(() => dispose()).not.toThrow();
	});

	it("onChange：快照无变化 → 仅计算 diff 后提前返回（75-79 跳过刷新）", () => {
		// snapshotInstalled 不改变集合（a→a），changed 为空
		const ctx = makeCtx("/vault", {
			snapshotInstalled: vi.fn(),
		});
		const dispose = startInstalledWatch(ctx as never);
		vi.advanceTimersByTime(60_000);
		expect(ctx.snapshotInstalled).toHaveBeenCalled();
		// 无变化：recordInstallDiff 不应被调用，scheduleRender 也不应被调用
		expect(ctx.plugin.recordInstallDiff).not.toHaveBeenCalled();
		expect(ctx.scheduleRender).not.toHaveBeenCalled();
		dispose();
	});

	it("disposed 为 true → onChange 直接跳过（55-56）", () => {
		const ctx = makeCtx("/vault", { disposed: true });
		startInstalledWatch(ctx as never);
		vi.advanceTimersByTime(60_000);
		expect(ctx.snapshotInstalled).not.toHaveBeenCalled();
	});
});

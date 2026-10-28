import { describe, it, expect, vi } from "vitest";
import {
	runScrollLayoutDiagnostic,
	runCheckUpdates,
	type MarketViewLike,
	type ScrollDiagnosticDeps,
	type CheckUpdatesDeps,
} from "./plugin-diagnostics";

/**
 * 两个诊断类命令体。
 *
 * 它们原先内联在 onload 的 addCommand callback 里——注册那层会被覆盖，
 * callback 内部却永远不执行。抽取后这里锁定最容易改坏的点：
 *   · 视图未打开时必须给出明确指引，而不是静默失败
 *   · 「检查失败」绝不能落到「已是最新」的文案（用户会误以为没问题）
 *   · 可滚动判定阈值是 +1px（避免 1px 误差导致误报"不可滚动"）
 */

function makeViewport(opts: { client: number; scroll: number; parent?: HTMLElement | null }) {
	const vp = document.createElement("div");
	Object.defineProperty(vp, "clientHeight", { value: opts.client, configurable: true });
	Object.defineProperty(vp, "scrollHeight", { value: opts.scroll, configurable: true });
	Object.defineProperty(vp, "scrollTop", { value: 0, configurable: true });
	if (opts.parent !== null) {
		const parent = opts.parent ?? document.createElement("div");
		parent.className = "root-container";
		parent.appendChild(vp);
	}
	return vp;
}

function makeScrollDeps(view: MarketViewLike | null) {
	const notify = vi.fn();
	const logDebug = vi.fn();
	const deps: ScrollDiagnosticDeps = {
		findView: () => view,
		notify,
		logDebug,
	};
	return { deps, notify, logDebug };
}

function makeUpdateDeps(view: MarketViewLike | null, refresh?: () => Promise<void>) {
	const notify = vi.fn();
	const refreshOutdated = vi.fn(refresh ?? (async () => {}));
	const deps: CheckUpdatesDeps = {
		findView: () => view,
		notify,
		refreshOutdated,
		t: (k, vars) => (vars ? `${k}|${JSON.stringify(vars)}` : k),
	};
	return { deps, notify, refreshOutdated };
}

describe("runScrollLayoutDiagnostic：视图守卫", () => {
	it("视图未打开时提示先打开视图", () => {
		const { deps, notify } = makeScrollDeps(null);
		runScrollLayoutDiagnostic(deps);
		expect(notify).toHaveBeenCalledWith("请先打开插件搜索视图");
	});

	it("视图存在但拿不到 scrollViewport 时单独提示（不是笼统报错）", () => {
		const { deps, notify } = makeScrollDeps({ ctx: {} });
		runScrollLayoutDiagnostic(deps);
		expect(notify).toHaveBeenCalledWith("scrollViewport 不存在");
	});
});

describe("runScrollLayoutDiagnostic：指标计算", () => {
	it("输出高度、样式与可滚动判定", () => {
		const vp = makeViewport({ client: 480, scroll: 1200 });
		const { deps, notify, logDebug } = makeScrollDeps({ scrollViewport: vp, ctx: {} });

		runScrollLayoutDiagnostic(deps);

		expect(logDebug).toHaveBeenCalled();
		const msg = String(notify.mock.calls[0][0]);
		expect(msg).toContain("列表高度=480px");
		expect(msg).toContain("内容总高=1200px");
		expect(msg).toContain("可滚动=true");
		expect(msg).toContain("viewport: display=");
		// 诊断提示需要停留足够久，便于截图
		expect(notify.mock.calls[0][1]).toBe(15000);
	});

	it("内容仅高 1px 时判定为不可滚动（阈值 +1 吸收像素误差）", () => {
		const vp = makeViewport({ client: 480, scroll: 481 });
		const { deps, notify } = makeScrollDeps({ scrollViewport: vp, ctx: {} });

		runScrollLayoutDiagnostic(deps);

		expect(String(notify.mock.calls[0][0])).toContain("可滚动=false");
	});

	it("内容高 2px 时判定为可滚动", () => {
		const vp = makeViewport({ client: 480, scroll: 482 });
		const { deps, notify } = makeScrollDeps({ scrollViewport: vp, ctx: {} });

		runScrollLayoutDiagnostic(deps);

		expect(String(notify.mock.calls[0][0])).toContain("可滚动=true");
	});

	it("父容器缺失时输出「(无)」而不是报错", () => {
		const vp = makeViewport({ client: 100, scroll: 200 });
		vp.remove(); // 脱离文档，parentElement 为 null
		const { deps, notify } = makeScrollDeps({ scrollViewport: vp, ctx: {} });

		runScrollLayoutDiagnostic(deps);

		expect(String(notify.mock.calls[0][0])).toContain("root(.(无))");
	});
});

describe("runCheckUpdates：三种出口", () => {
	it("视图未打开时提示先打开视图，且不触发检查", async () => {
		const { deps, notify, refreshOutdated } = makeUpdateDeps(null);
		await runCheckUpdates(deps);

		expect(notify).toHaveBeenCalledWith("请先打开插件搜索视图");
		expect(refreshOutdated).not.toHaveBeenCalled();
	});

	it("发现 3 个更新时报告数量", async () => {
		const ctx = { outdatedIds: { size: 3 } };
		const { deps, notify } = makeUpdateDeps({ ctx });

		await runCheckUpdates(deps);

		expect(String(notify.mock.calls[0][0])).toContain("action.checkUpdate.available");
		expect(String(notify.mock.calls[0][0])).toContain('"n":"3"');
	});

	it("没有更新时报告「已是最新」", async () => {
		const { deps, notify } = makeUpdateDeps({ ctx: { outdatedIds: { size: 0 } } });

		await runCheckUpdates(deps);

		expect(notify).toHaveBeenCalledWith("action.checkUpdate.upToDate");
	});

	it("outdatedIds 缺失时按 0 处理（首次检查尚未建立集合）", async () => {
		const { deps, notify } = makeUpdateDeps({ ctx: {} });

		await runCheckUpdates(deps);

		expect(notify).toHaveBeenCalledWith("action.checkUpdate.upToDate");
	});

	it("检查失败必须单独提示，不能落到「已是最新」", async () => {
		const { deps, notify } = makeUpdateDeps({ ctx: { outdatedIds: { size: 0 } } }, async () => {
			throw new Error("network down");
		});

		await runCheckUpdates(deps);

		expect(notify).toHaveBeenCalledWith("action.checkUpdate.failed");
		expect(notify).not.toHaveBeenCalledWith("action.checkUpdate.upToDate");
	});

	it("先刷新再去读结果（不能读旧集合）", async () => {
		const order: string[] = [];
		const ctx = { outdatedIds: { size: 1 } };
		const { deps } = makeUpdateDeps({ ctx }, async () => {
			order.push("refresh");
		});
		const originalNotify = deps.notify;
		deps.notify = (m, t) => {
			order.push("notify");
			originalNotify(m, t);
		};

		await runCheckUpdates(deps);

		expect(order).toEqual(["refresh", "notify"]);
	});
});

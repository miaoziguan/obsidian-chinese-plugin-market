import { describe, it, expect, vi } from "vitest";
import { reportMissingDeps } from "@ui/view/deps-report";
import { DepCheckModal } from "@ui/modals/dep-check-modal";
import type { ViewContext } from "@ui/view/view-context";
import type { DepGraph } from "@domain/deps/graph";

/** 用一份假的 DepGraph 行为构造最小 ctx，聚焦「何时弹窗 / 弹什么」 */
function makeCtx(over: Partial<ViewContext> = {}): ViewContext {
	return {
		app: {} as ViewContext["app"],
		t: ((k: string) => k) as ViewContext["t"],
		fixDep: vi.fn(),
		pluginDeps: null as DepGraph | null,
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		installedVersions: new Map<string, string>(),
		allPlugins: [],
		...over,
	} as unknown as ViewContext;
}

describe("reportMissingDeps", () => {
	it("依赖都齐了 → 不弹窗（零打扰）", () => {
		const open = vi.spyOn(DepCheckModal.prototype, "open").mockImplementation(() => {});
		const graph = {
			blockingOf: () => [],
		} as unknown as DepGraph;
		reportMissingDeps(makeCtx({ pluginDeps: graph }), "x", "X");
		expect(open).not.toHaveBeenCalled();
	});

	it("有必需依赖缺失 → 弹窗且正确映射动作（missing→install / disabled→enable / outdated→update）", () => {
		const open = vi.spyOn(DepCheckModal.prototype, "open").mockImplementation(() => {});
		const graph = {
			blockingOf: () => [
				{ dep: { id: "dv", name: "Dataview" }, status: "missing" as const },
				{ dep: { id: "tp", name: "Templater" }, status: "disabled" as const },
				{ dep: { id: "qt", name: "QuickAdd" }, status: "outdated" as const },
			],
		} as unknown as DepGraph;
		reportMissingDeps(makeCtx({ pluginDeps: graph }), "x", "X");
		expect(open).toHaveBeenCalledOnce();
	});

	it("仅 optional 未满足 → blockingOf 不返回 → 不弹窗", () => {
		const open = vi.spyOn(DepCheckModal.prototype, "open").mockImplementation(() => {});
		const graph = {
			blockingOf: () => [], // blockingOf 只返回 required，optional 不阻塞
		} as unknown as DepGraph;
		reportMissingDeps(makeCtx({ pluginDeps: graph }), "x", "X");
		expect(open).not.toHaveBeenCalled();
	});
});

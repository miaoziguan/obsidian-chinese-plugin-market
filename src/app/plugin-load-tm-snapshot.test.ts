import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的 loadTMApprovedSnapshot（2650-2675）——此前完全零覆盖（scan-vault-tm 测试把
 * 它整桩 stub 掉）。它是启动期 TM 记忆库快照的载入与 delta 合并入口，错误模式是「启动后 TM 记忆库
 * 整库丢失、或读取快照抛错时未兜底为全量重扫」。
 *
 * 手法：loadTMBaseline / loadTMDelta 经 Object.assign 打桩（绕开真实 adapter 读写），直接驱动
 * loadTMApprovedSnapshot 覆盖：基线 + 无 delta、基线 + delta 合并（mtimesPatch/idsByPathPatch/
 * entriesPatch/removed）、基线读取抛错→catch 兜底返回 null（2672-2674）。本方法自包含，无需 onload。
 * 私人方法/字段经 AnyPlugin 转型访问。
 */

type AnyPlugin = Record<string, any>;

const baseline = {
	version: 1 as const,
	mtimes: { "a.md": 1 },
	idsByPath: { "a.md": "a" },
	entries: { a: { id: "a", status: "approved" as const } },
};

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		loadTMBaseline: vi.fn(async () => baseline),
		loadTMDelta: vi.fn(async () => null),
		_snapshotBaselineEntries: undefined,
		_snapshotBaselineMtimes: undefined,
		_snapshotBaselineIdsByPath: undefined,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("loadTMApprovedSnapshot：载入并合并 TM 快照（2650-2675）", () => {
	it("基线 + 无 delta → 返回合并后完整快照并缓存基线（覆盖 2651-2671）", async () => {
		const plugin = makePlugin();
		const snap = await (plugin as AnyPlugin).loadTMApprovedSnapshot();
		expect(snap).not.toBeNull();
		expect(snap.entries.a).toEqual({ id: "a", status: "approved" });
		expect((plugin as AnyPlugin)._snapshotBaselineEntries).toBe(baseline.entries);
		expect((plugin as AnyPlugin)._snapshotBaselineMtimes).toBe(baseline.mtimes);
		expect((plugin as AnyPlugin)._snapshotBaselineIdsByPath).toBe(baseline.idsByPath);
	});

	it("基线 + delta → 合并 mtimes/idsByPath/entries 并应用 removed（覆盖 2662-2670）", async () => {
		const plugin = makePlugin({
			loadTMDelta: vi.fn(async () => ({
				mtimesPatch: { "b.md": 2 },
				idsByPathPatch: { "b.md": "b", "a.md": "" },
				entriesPatch: { b: { id: "b", status: "suggested" } },
				removed: ["a"],
			})),
		});
		const snap = await (plugin as AnyPlugin).loadTMApprovedSnapshot();
		expect(snap.mtimes["b.md"]).toBe(2);
		expect(snap.idsByPath["b.md"]).toBe("b");
		expect(snap.idsByPath["a.md"]).toBeUndefined();
		expect(snap.entries.b).toEqual({ id: "b", status: "suggested" });
		expect(snap.entries.a).toBeUndefined();
	});

	it("基线读取抛错 → catch 兜底返回 null（覆盖 2672-2674）", async () => {
		const plugin = makePlugin({
			loadTMBaseline: vi.fn(async () => {
				throw new Error("io");
			}),
		});
		const snap = await (plugin as AnyPlugin).loadTMApprovedSnapshot();
		expect(snap).toBeNull();
	});
});

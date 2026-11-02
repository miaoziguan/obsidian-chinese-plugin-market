import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的「TM 快照增量落盘」saveTMApprovedSnapshot（2735-2799）。
 *
 * 既有 plugin*.test.ts 没直接驱动这个私有方法，错误模式是「大量 TM 翻译后增量 delta 文件
 * 无限膨胀、或首写基线/折叠回基线逻辑出错导致记忆库状态错位」。
 *
 * 折叠阈值分支（2782-2792）：delta 累积超 2000 时整库重写基线并清空 delta。
 * 手法：直接调私有方法（AnyPlugin 转型），用 2001 个不同条目制造 >2000 的 delta 触发折叠，
 * 并断言 adapter.write 写整库基线、adapter.remove 清 delta、基线被深拷贝重置。
 */

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const translator = { tmApproved: {} as Record<string, unknown> };
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { vault: { adapter: { write: vi.fn(async () => {}), remove: vi.fn(async () => {}), exists: vi.fn(async () => false), read: vi.fn(async () => "") } } },
		translator,
		_lastTMIdsByPath: {} as Record<string, string>,
		_snapshotBaselineEntries: undefined as Record<string, unknown> | undefined,
		_snapshotBaselineMtimes: undefined as Record<string, number> | undefined,
		_snapshotBaselineIdsByPath: undefined as Record<string, string> | undefined,
		...extra,
	});
	return plugin;
}

function genEntries(n: number): Record<string, { name: string }> {
	const o: Record<string, { name: string }> = {};
	for (let i = 0; i < n; i++) o["e" + i] = { name: "v" + i };
	return o;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("saveTMApprovedSnapshot：折叠阈值分支（2782-2792）", () => {
	it("delta > 2000 → 整库重写基线 + 清空 delta", async () => {
		const big = genEntries(2001);
		const plugin = makePlugin({
			translator: { tmApproved: big },
			_snapshotBaselineEntries: {},
			_snapshotBaselineMtimes: {},
			_snapshotBaselineIdsByPath: {},
		});
		await (plugin as AnyPlugin).saveTMApprovedSnapshot({});
		const adapter = (plugin as AnyPlugin).app.vault.adapter;
		// 整库写基线
		expect(adapter.write).toHaveBeenCalledTimes(1);
		const [snapPath, snapBody] = adapter.write.mock.calls[0];
		expect(snapPath).toBe(".obsidian/plugins/chinese-plugin-market/tm-approved-snapshot.json");
		const parsed = JSON.parse(snapBody);
		expect(parsed.version).toBe(1);
		expect(Object.keys(parsed.entries).length).toBe(2001);
		// 清空 delta
		expect(adapter.remove).toHaveBeenCalledWith(".obsidian/plugins/chinese-plugin-market/tm-approved-delta.json");
		// 基线被深拷贝重置（与原 tmApproved 引用断开）
		const base = (plugin as AnyPlugin)._snapshotBaselineEntries;
		expect(Object.keys(base).length).toBe(2001);
		(base as Record<string, { name: string }>).e0.name = "mutated";
		expect(big.e0.name).toBe("v0"); // 原对象不受影响
	});

	it("delta 较小 → 仅写极小 delta 文件", async () => {
		const plugin = makePlugin({
			translator: { tmApproved: { a: { name: "A" }, b: { name: "B" } } },
			_snapshotBaselineEntries: { a: { name: "A" } },
			_snapshotBaselineMtimes: {},
			_snapshotBaselineIdsByPath: {},
		});
		await (plugin as AnyPlugin).saveTMApprovedSnapshot({});
		const adapter = (plugin as AnyPlugin).app.vault.adapter;
		const [deltaPath, deltaBody] = adapter.write.mock.calls[0];
		expect(deltaPath).toBe(".obsidian/plugins/chinese-plugin-market/tm-approved-delta.json");
		expect(JSON.parse(deltaBody)).toEqual({
			mtimesPatch: {},
			idsByPathPatch: {},
			entriesPatch: { b: { name: "B" } },
			removed: [],
		});
	});
});

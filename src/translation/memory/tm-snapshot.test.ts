import { describe, it, expect, vi } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { Translator } from "@domain/catalog/translator";

/**
 * TM 快照增量落盘回归（基线 + delta）。
 * 验证：首次写整库基线、后续仅写极小 delta、重新载入时基线+delta 正确合并。
 */
function makePlugin() {
	const files: Record<string, string> = {};
	const adapter = {
		exists: vi.fn(async (p: string) => p in files),
		read: vi.fn(async (p: string) => {
			if (!(p in files)) throw new Error("not found: " + p);
			return files[p];
		}),
		write: vi.fn(async (p: string, c: string) => {
			files[p] = c;
		}),
		remove: vi.fn(async (p: string) => {
			delete files[p];
		}),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "test-plugin" },
		app: { vault: { adapter } },
		translator: new Translator(),
		_lastTMIdsByPath: {} as Record<string, string>,
	});
	// 提供访问私有字段/方法的手段
	const priv = plugin as unknown as Record<string, unknown> & {
		tmSnapshotFilePath: string;
		tmDeltaFilePath: string;
		translator: Translator;
		_lastTMIdsByPath: Record<string, string>;
		loadTMApprovedSnapshot(): Promise<unknown>;
		saveTMApprovedSnapshot(m: Record<string, number>): Promise<void>;
	};
	return { plugin, adapter, files, priv };
}

function entry(id: string, name: string) {
	return { id, name, description: "", source: "human" as const, status: "approved" as const, confidence: 0, created: 1 };
}

describe("TM 快照增量落盘（基线+delta）", () => {
	it("首次保存写整库基线、不生成 delta 文件", async () => {
		const { priv, files } = makePlugin();
		priv.translator.tmApproved = {
			a: entry("a", "A"),
			b: entry("b", "B"),
			c: entry("c", "C"),
		};
		priv._lastTMIdsByPath = { "m/a.md": "a", "m/b.md": "b", "m/c.md": "c" };
		await priv.saveTMApprovedSnapshot({ "m/a.md": 1, "m/b.md": 2, "m/c.md": 3 });

		expect(files[priv.tmSnapshotFilePath]).toBeDefined();
		expect(files[priv.tmDeltaFilePath]).toBeUndefined();
		const base = JSON.parse(files[priv.tmSnapshotFilePath]);
		expect(Object.keys(base.entries)).toEqual(["a", "b", "c"]);
	});

	it("仅变化少量条目时只写极小 delta，不重写基线", async () => {
		const { priv, files } = makePlugin();
		// 先建立基线
		priv.translator.tmApproved = {
			a: entry("a", "A"),
			b: entry("b", "B"),
			c: entry("c", "C"),
		};
		priv._lastTMIdsByPath = { "m/a.md": "a", "m/b.md": "b", "m/c.md": "c" };
		await priv.saveTMApprovedSnapshot({ "m/a.md": 1, "m/b.md": 2, "m/c.md": 3 });
		const baseRaw = files[priv.tmSnapshotFilePath];

		// 只修改 b（改名）、新增 d、删除 c
		priv.translator.tmApproved = {
			a: entry("a", "A"),
			b: entry("b", "B-mod"),
			d: entry("d", "D"),
		};
		priv._lastTMIdsByPath = { "m/a.md": "a", "m/b.md": "b", "m/d.md": "d" };
		await priv.saveTMApprovedSnapshot({ "m/a.md": 1, "m/b.md": 9, "m/d.md": 4 });

		// 基线未被重写（内容不变）
		expect(files[priv.tmSnapshotFilePath]).toBe(baseRaw);
		// delta 已生成且极小
		expect(files[priv.tmDeltaFilePath]).toBeDefined();
		const delta = JSON.parse(files[priv.tmDeltaFilePath]);
		expect(Object.keys(delta.entriesPatch)).toEqual(["b", "d"]); // 仅变化/新增
		expect(delta.removed).toEqual(["c"]); // 删除的 id
		expect(delta.mtimesPatch["m/b.md"]).toBe(9);
		expect(delta.mtimesPatch["m/d.md"]).toBe(4);
	});

	it("载入时基线+delta 正确合并为完整快照", async () => {
		const { priv } = makePlugin();
		priv.translator.tmApproved = {
			a: entry("a", "A"),
			b: entry("b", "B"),
			c: entry("c", "C"),
		};
		priv._lastTMIdsByPath = { "m/a.md": "a", "m/b.md": "b", "m/c.md": "c" };
		await priv.saveTMApprovedSnapshot({ "m/a.md": 1, "m/b.md": 2, "m/c.md": 3 });
		// 变化
		priv.translator.tmApproved = {
			a: entry("a", "A"),
			b: entry("b", "B-mod"),
			d: entry("d", "D"),
		};
		priv._lastTMIdsByPath = { "m/a.md": "a", "m/b.md": "b", "m/d.md": "d" };
		await priv.saveTMApprovedSnapshot({ "m/a.md": 1, "m/b.md": 9, "m/d.md": 4 });

		// 重新载入（清空内存与缓存）
		priv.translator.tmApproved = {};
		(priv as unknown as { _snapshotBaselineEntries: unknown })._snapshotBaselineEntries = null;
		(priv as unknown as { _snapshotBaselineMtimes: unknown })._snapshotBaselineMtimes = null;
		const snap = (await priv.loadTMApprovedSnapshot()) as {
			entries: Record<string, { name: string }>;
			mtimes: Record<string, number>;
		};
		expect(Object.keys(snap.entries).sort()).toEqual(["a", "b", "d"].sort());
		expect(snap.entries.b.name).toBe("B-mod"); // delta 覆盖
		expect(snap.mtimes["m/b.md"]).toBe(9); // delta mtime
		expect(snap.mtimes["m/d.md"]).toBe(4);
	});
});

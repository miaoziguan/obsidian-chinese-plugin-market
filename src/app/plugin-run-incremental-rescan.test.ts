import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { parseTMNote } from "@translation/memory/translation-memory";

/**
 * 补 app/plugin.ts 的 runIncrementalRescan（2583-2627），重点是既有测试从没触发的
 * 「状态变化 → 从已采纳层移除」else 分支（2608-2610）。错误模式是「把一条 TM 笔记从
 * approved 改回 suggested 后，内存里仍残留已采纳条目，译名与高亮错位」。
 *
 * 手法：@translation/memory/translation-memory 的 parseTMNote 经 vi.mock 替换以可控构造条目；
 * noteStorage.readNote/statMtime、translator.tmApproved、saveTMApprovedSnapshot、waitMetadataResolved
 * 经 Object.assign 打桩；私有方法经 AnyPlugin 转型访问。approved / suggested / null 三态全跑一遍。
 */

vi.mock("@translation/memory/translation-memory", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	parseTMNote: vi.fn(),
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		noteStorage: {
			readNote: vi.fn(async () => "# content"),
			statMtime: vi.fn(async () => 111),
		},
		translator: { tmApproved: {} as Record<string, unknown> },
		_lastTMIdsByPath: {} as Record<string, string>,
		waitMetadataResolved: vi.fn(async () => {}),
		saveTMApprovedSnapshot: vi.fn(async () => {}),
		tmProgress: {} as Record<string, unknown>,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("runIncrementalRescan：增量重扫（2583-2627）", () => {
	it("状态变 suggested → 从已采纳层删除（覆盖 2608-2610）", async () => {
		const plugin = makePlugin({
			translator: { tmApproved: { x: { id: "x", status: "approved" } } },
		});
		(parseTMNote as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({
			id: "x",
			status: "suggested",
		});

		await (plugin as AnyPlugin).runIncrementalRescan(["p1.md"], {}, null);

		expect((plugin as AnyPlugin).translator.tmApproved.x).toBeUndefined();
		expect((plugin as AnyPlugin)._lastTMIdsByPath["p1.md"]).toBe("x");
		expect((plugin as AnyPlugin).saveTMApprovedSnapshot).toHaveBeenCalled();
	});

	it("状态 approved → 以笔记覆盖内存索引（覆盖 2605-2607）", async () => {
		const plugin = makePlugin({ translator: { tmApproved: {} } });
		const entry = { id: "y", status: "approved", name: "Y" };
		(parseTMNote as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(entry);

		await (plugin as AnyPlugin).runIncrementalRescan(["p2.md"], {}, null);

		expect((plugin as AnyPlugin).translator.tmApproved.y).toBe(entry);
	});

	it("解析为空 → 提前返回（覆盖 2603 的 return）", async () => {
		const plugin = makePlugin({ translator: { tmApproved: { z: { id: "z" } } } });
		(parseTMNote as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(null);

		await (plugin as AnyPlugin).runIncrementalRescan(["p3.md"], {}, null);

		expect((plugin as AnyPlugin).translator.tmApproved.z).toBeDefined();
		expect((plugin as AnyPlugin).saveTMApprovedSnapshot).toHaveBeenCalled();
	});
});

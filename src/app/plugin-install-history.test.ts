import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的安装历史记账（146-207）：recordInstallDiff / backfillInstallHistory。
 *
 * 既有 plugin*.test.ts 未覆盖这段「台账书写路径」——本插件自己发起的安装/卸载若只靠
 * fs.watch 的目录 diff，几乎记不上（写盘后立刻 snapshot，diff 恒为空），足迹表里这些插件的
 * 首次/最近动态永远是「—」。修复靠「动作发生处直接记账」，本批测的就是这两条记账路径。
 *
 * 错误模式是「装了插件足迹却一片空白 / 跨会话卸载不补写卸载时间 / 记账抛错拖垮整个插件」。
 */

// mergeInstallDiff 是纯函数，这里换成可控桩，便于断言 journalTriedIds 与 saveInstallHistory 入参
const mergeInstallDiffMock = vi.hoisted(() => ({
	fn: (base: { entries?: Record<string, unknown> }, diff: { added?: Set<string>; removed?: Set<string> }) => {
		const entries: Record<string, unknown> = { ...(base?.entries ?? {}) };
		for (const id of diff.added ?? []) entries[id] = { id, added: true };
		for (const id of diff.removed ?? []) delete entries[id];
		return entries;
	},
}));
vi.mock("@domain/journal/install-history", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	mergeInstallDiff: (b: unknown, d: unknown) => mergeInstallDiffMock.fn(b as never, d as never),
}));

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	logger: loggerMock,
}));

type AnyPlugin = Record<string, any>;

function makeStorage() {
	return {
		loadInstallHistory: vi.fn(async () => ({ entries: { existing: { id: "existing" } } })),
		saveInstallHistory: vi.fn(async () => {}),
	};
}

function makePlugin(extra: Record<string, unknown> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as unknown as AnyPlugin;
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		settings: { profiles: [] as PluginProfile[] } as Record<string, unknown>,
		app: { vault: { adapter: {} }, workspace: { getLeavesOfType: vi.fn(() => []) } },
		storage: makeStorage(),
		journalHistory: null,
		journalTriedIds: new Set<string>(),
		installedSnapshot: vi.fn(() => ({
			installed: new Set(["a", "b"]),
			enabled: new Set(["a"]),
			nameOf: (id: string) => id,
		})),
		refreshPluginToggleCommands: vi.fn(),
		estimateTimesFromDisk: vi.fn(async () => ({ firstInstalled: 1, lastInstalled: 2 })),
		hasStaleInstalledRecord: vi.fn(() => false),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	mergeInstallDiffMock.fn = (base: { entries?: Record<string, unknown> }, diff: { added?: Set<string>; removed?: Set<string> }) => {
		const entries: Record<string, unknown> = { ...(base?.entries ?? {}) };
		for (const id of diff.added ?? []) entries[id] = { id, added: true };
		for (const id of diff.removed ?? []) delete entries[id];
		return entries;
	};
});

describe("recordInstallDiff：安装/卸载后落盘记账（同步「切换插件」命令）", () => {
	it("内存无历史 → 先读盘取基，merge 后保存并缓存到内存，journalTriedIds 含新增 id", async () => {
		const storage = makeStorage();
		const plugin = makePlugin({ storage });
		await plugin.recordInstallDiff(new Set(["x", "y"]), new Set());
		expect(storage.loadInstallHistory).toHaveBeenCalledTimes(1);
		expect(storage.saveInstallHistory).toHaveBeenCalled();
		expect(plugin.journalHistory).not.toBeNull();
		expect([...(plugin.journalTriedIds as Set<string>)]).toEqual(expect.arrayContaining(["x", "y"]));
		expect(plugin.refreshPluginToggleCommands).toHaveBeenCalled();
	});

	it("内存已有历史 → 直接用内存基，不重复读盘", async () => {
		const storage = makeStorage();
		const plugin = makePlugin({ storage, journalHistory: { entries: { a: {} } } });
		await plugin.recordInstallDiff(new Set(["z"]), new Set());
		expect(storage.loadInstallHistory).not.toHaveBeenCalled();
		expect(storage.saveInstallHistory).toHaveBeenCalled();
	});

	it("显式传入 installedIds/enabledIds → merge 的 diff 用传入值", async () => {
		const storage = makeStorage();
		const installedIds = new Set(["p1"]);
		const enabledIds = new Set(["p1"]);
		const plugin = makePlugin({ storage });
		await plugin.recordInstallDiff(new Set(["p1"]), new Set(), installedIds, enabledIds);
		expect(storage.saveInstallHistory).toHaveBeenCalled();
	});

	it("保存抛错 → 不冒泡（catch 记日志），但仍刷新切换命令", async () => {
		const storage = {
			loadInstallHistory: vi.fn(async () => ({ entries: {} })),
			saveInstallHistory: vi.fn(async () => {
				throw new Error("disk full");
			}),
		};
		const plugin = makePlugin({ storage });
		loggerMock.warn.mockClear();
		await plugin.recordInstallDiff(new Set(["z"]), new Set());
		expect(loggerMock.warn).toHaveBeenCalled();
		expect(plugin.refreshPluginToggleCommands).toHaveBeenCalled();
	});
});

describe("backfillInstallHistory：补齐已装但未记录的插件（跨会话卸载补写卸载时间）", () => {
	it("installed 为空 → 早返回，不读盘不记账", async () => {
		const storage = makeStorage();
		const recordInstallDiff = vi.fn();
		const plugin = makePlugin({
			storage,
			installedSnapshot: vi.fn(() => ({ installed: new Set(), enabled: new Set() })),
			recordInstallDiff,
		});
		await plugin.backfillInstallHistory();
		expect(storage.loadInstallHistory).not.toHaveBeenCalled();
		expect(recordInstallDiff).not.toHaveBeenCalled();
	});

	it("全部已记录且无过期记录 → 走一次 merge 但不触发记账", async () => {
		const storage = makeStorage();
		const recordInstallDiff = vi.fn();
		const plugin = makePlugin({
			storage,
			journalHistory: { entries: { a: {}, b: {} } },
			installedSnapshot: vi.fn(() => ({ installed: new Set(["a", "b"]), enabled: new Set(["a"]) })),
			hasStaleInstalledRecord: vi.fn(() => false),
			recordInstallDiff,
		});
		await plugin.backfillInstallHistory();
		expect(recordInstallDiff).not.toHaveBeenCalled();
	});

	it("存在缺失插件 → 对每个 missing 估时并触发记账（added=missing）", async () => {
		const storage = makeStorage();
		const recordInstallDiff = vi.fn();
		const estimateTimesFromDisk = vi.fn(async () => ({ firstInstalled: 1, lastInstalled: 2 }));
		const plugin = makePlugin({
			storage,
			journalHistory: { entries: { a: {} } },
			installedSnapshot: vi.fn(() => ({ installed: new Set(["a", "b"]), enabled: new Set(["a"]) })),
			hasStaleInstalledRecord: vi.fn(() => false),
			estimateTimesFromDisk,
			recordInstallDiff,
		});
		await plugin.backfillInstallHistory();
		expect(estimateTimesFromDisk).toHaveBeenCalledWith("b");
		expect(recordInstallDiff).toHaveBeenCalledWith(new Set(["b"]), new Set(), new Set(["a", "b"]), new Set(["a"]), expect.any(Object));
	});

	it("有跨会话卸载的过期记录 → 即使无缺失也触发记账", async () => {
		const storage = makeStorage();
		const recordInstallDiff = vi.fn();
		const estimateTimesFromDisk = vi.fn(async () => ({ firstInstalled: 1 }));
		const plugin = makePlugin({
			storage,
			journalHistory: { entries: { a: {} } },
			installedSnapshot: vi.fn(() => ({ installed: new Set(["a"]), enabled: new Set(["a"]) })),
			hasStaleInstalledRecord: vi.fn(() => true),
			estimateTimesFromDisk,
			recordInstallDiff,
		});
		await plugin.backfillInstallHistory();
		expect(estimateTimesFromDisk).not.toHaveBeenCalled();
		expect(recordInstallDiff).toHaveBeenCalled();
	});

	it("读盘抛错 → 不冒泡（catch 记日志）", async () => {
		const storage = {
			loadInstallHistory: vi.fn(async () => {
				throw new Error("read fail");
			}),
			saveInstallHistory: vi.fn(async () => {}),
		};
		const recordInstallDiff = vi.fn();
		const plugin = makePlugin({
			storage,
			installedSnapshot: vi.fn(() => ({ installed: new Set(["a"]), enabled: new Set() })),
			recordInstallDiff,
		});
		loggerMock.warn.mockClear();
		await plugin.backfillInstallHistory();
		expect(loggerMock.warn).toHaveBeenCalled();
	});
});

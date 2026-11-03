import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的 backfillInstallHistory（189-208），重点是既有测试从没触发的
 * 「journalHistory 为空 → 从 storage 载入安装历史」分支（196-199）。错误模式是
 * 「启动/打开足迹前，已装但从未记录的插件，其首次安装/最近动态时间永远缺失」。
 *
 * 手法：installedSnapshot / storage.loadInstallHistory / estimateTimesFromDisk /
 * hasStaleInstalledRecord / recordInstallDiff 全部经 Object.assign 打桩；journalHistory 设为
 * undefined 触发 loadInstallHistory 分支；私人方法经 AnyPlugin 转型访问。本方法自包含，无需 onload。
 */

vi.mock("@shared/logger", () => ({
	logger: { warn: vi.fn() },
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		installedSnapshot: vi.fn(() => ({ installed: new Set(["p1", "p2"]), enabled: new Set(["p1"]) })),
		journalHistory: undefined as unknown,
		storage: { loadInstallHistory: vi.fn(async () => ({ entries: {} })) },
		estimateTimesFromDisk: vi.fn(async () => ({ firstInstalled: 1, lastInstalled: 2 })),
		hasStaleInstalledRecord: vi.fn(() => false),
		recordInstallDiff: vi.fn(async () => {}),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("backfillInstallHistory：台账历史回填（189-208）", () => {
	it("journalHistory 为空 → 载入存储历史并补齐缺失（覆盖 196-199 / 201 / 204）", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).backfillInstallHistory();
		expect((plugin as AnyPlugin).storage.loadInstallHistory).toHaveBeenCalled();
		expect((plugin as AnyPlugin).journalHistory).toEqual({ entries: {} });
		expect((plugin as AnyPlugin).estimateTimesFromDisk).toHaveBeenCalledTimes(2);
		expect((plugin as AnyPlugin).recordInstallDiff).toHaveBeenCalled();
	});

	it("已安装集合为空 → 提前返回（覆盖 194）", async () => {
		const plugin = makePlugin({
			installedSnapshot: vi.fn(() => ({ installed: new Set<string>(), enabled: new Set<string>() })),
		});
		await (plugin as AnyPlugin).backfillInstallHistory();
		expect((plugin as AnyPlugin).storage.loadInstallHistory).not.toHaveBeenCalled();
		expect((plugin as AnyPlugin).recordInstallDiff).not.toHaveBeenCalled();
	});

	it("全部已有记录且无过期记录 → 提前返回（覆盖 202）", async () => {
		const plugin = makePlugin({
			journalHistory: { entries: { p1: {}, p2: {} } },
			hasStaleInstalledRecord: vi.fn(() => false),
		});
		await (plugin as AnyPlugin).backfillInstallHistory();
		expect((plugin as AnyPlugin).recordInstallDiff).not.toHaveBeenCalled();
	});

	it("载入历史抛错 → 记日志不崩（覆盖 205-207）", async () => {
		const plugin = makePlugin({
			storage: { loadInstallHistory: vi.fn(async () => { throw new Error("io"); }) },
		});
		await expect((plugin as AnyPlugin).backfillInstallHistory()).resolves.toBeUndefined();
		expect((plugin as AnyPlugin).recordInstallDiff).not.toHaveBeenCalled();
	});
});

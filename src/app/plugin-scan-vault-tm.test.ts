import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的 scanVaultTM（2506-2577）整体编排——既有 plugin*.test.ts 没驱动这个私有
 * 方法，错误模式是「启动期 TM 记忆库回灌错乱：快照不灌入、删除的笔记残留索引、首屏被重扫阻塞」。
 * 手法：loadTMApprovedSnapshot / runIncrementalRescan / noteStorage.listMarkdown / statMtime /
 * tmFolderEffective 经 Object.assign 打桩，直接调私有方法（AnyPlugin 转型），覆盖：空文件夹提前返回、
 * 快照灌入 tmApproved + 初始化 path→id、删除检测、有快照时增量重扫放后台、无快照时同步等重扫。
 */

type AnyPlugin = Record<string, any>;

function makePlugin(mtimes: Record<string, number>, extra: Record<string, any> = {}) {
	const translator = { tmApproved: {} as Record<string, unknown> };
	const noteStorage = {
		listMarkdown: vi.fn(async () => Object.keys(mtimes)),
		statMtime: vi.fn((p: string) => Promise.resolve(mtimes[p])),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		translator,
		noteStorage,
		tmFolderEffective: vi.fn(() => "TranslationMemory"),
		loadTMApprovedSnapshot: vi.fn(async () => null),
		runIncrementalRescan: vi.fn(async () => {}),
		tmProgress: null as unknown,
		_lastTMIdsByPath: {} as Record<string, string>,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("scanVaultTM：TM 记忆库双向回灌（2506-2577）", () => {
	it("空文件夹 → 标记 done 提前返回，不读 mtime", async () => {
		const plugin = makePlugin({});
		await (plugin as AnyPlugin).scanVaultTM();
		expect((plugin as AnyPlugin).tmProgress).toEqual({ phase: "done", current: 0, total: 0 });
		expect((plugin as AnyPlugin).noteStorage.statMtime).not.toHaveBeenCalled();
	});

	it("有快照且无变化 → 灌入 tmApproved + 初始化 path→id，不触发重扫", async () => {
		const snap = { entries: { a: { name: "A" } }, idsByPath: { "p1.md": "a" }, mtimes: { "p1.md": 111 } };
		const plugin = makePlugin({ "p1.md": 111 }, { loadTMApprovedSnapshot: vi.fn(async () => snap) });
		await (plugin as AnyPlugin).scanVaultTM();
		expect((plugin as AnyPlugin).translator.tmApproved.a).toEqual({ name: "A" });
		expect((plugin as AnyPlugin)._lastTMIdsByPath).toEqual({ "p1.md": "a" });
		expect((plugin as AnyPlugin).runIncrementalRescan).not.toHaveBeenCalled();
		expect((plugin as AnyPlugin).tmProgress).toEqual({ phase: "done", current: 1, total: 1 });
	});

	it("快照里记录过、但当前文件已不存在 → 从 tmApproved 删除", async () => {
		const snap = {
			entries: { a: {}, b: {} },
			idsByPath: { "p1.md": "a", "p2.md": "b" },
			mtimes: { "p1.md": 111, "p2.md": 222 },
		};
		const plugin = makePlugin({ "p1.md": 111 }, {
			translator: { tmApproved: { a: {}, b: {} } },
			loadTMApprovedSnapshot: vi.fn(async () => snap),
		});
		await (plugin as AnyPlugin).scanVaultTM();
		expect((plugin as AnyPlugin).translator.tmApproved.a).toBeDefined();
		expect((plugin as AnyPlugin).translator.tmApproved.b).toBeUndefined();
		expect((plugin as AnyPlugin).runIncrementalRescan).not.toHaveBeenCalled();
	});

	it("有快照且 mtime 变化 → 增量重扫放后台（不阻塞首屏）", async () => {
		const snap = { entries: { a: {} }, idsByPath: { "p1.md": "a" }, mtimes: { "p1.md": 111 } };
		const plugin = makePlugin({ "p1.md": 999 }, { loadTMApprovedSnapshot: vi.fn(async () => snap) });
		await (plugin as AnyPlugin).scanVaultTM();
		expect((plugin as AnyPlugin).runIncrementalRescan).toHaveBeenCalledWith(["p1.md"], { "p1.md": 111 }, snap);
	});

	it("无快照且有待重扫文件 → 同步等重扫完成（无兜底译名，必须同步）", async () => {
		const plugin = makePlugin({ "p1.md": 111 }, { loadTMApprovedSnapshot: vi.fn(async () => null) });
		await (plugin as AnyPlugin).scanVaultTM();
		expect((plugin as AnyPlugin)._lastTMIdsByPath).toEqual({});
		expect((plugin as AnyPlugin).runIncrementalRescan).toHaveBeenCalledWith(["p1.md"], {}, null);
	});
});

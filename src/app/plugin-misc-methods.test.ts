import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notice } from "obsidian";
import { parseTMNote } from "@translation/memory/translation-memory";
import { estimateInstallTimes } from "@domain/journal/install-history";
import ChinesePluginMarketPlugin from "@app/plugin";

vi.mock("obsidian", async (importOriginal) => {
	const orig = await importOriginal<typeof import("obsidian")>();
	return { ...orig, Notice: vi.fn() };
});

vi.mock("@translation/memory/translation-memory", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@translation/memory/translation-memory")>();
	return { ...orig, parseTMNote: vi.fn() };
});

vi.mock("@domain/journal/install-history", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@domain/journal/install-history")>();
	return { ...orig, estimateInstallTimes: vi.fn(() => ({ firstInstalled: 1, lastInstalled: 2 })) };
});

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const translator = {
		loadData: vi.fn(),
		saveData: vi.fn(),
		setApiConfig: vi.fn(),
		setBaiduConfig: vi.fn(),
		setSelfHostedTranslators: vi.fn(),
		setAIConfig: vi.fn(),
		setPluginTags: vi.fn(),
		setVectorIndex: vi.fn(),
		buildPluginTagMap: vi.fn(),
		removeTMApproved: vi.fn(),
		tmApproved: {} as Record<string, unknown>,
		getPluginTags: vi.fn(() => ({})),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {
			vault: {
				configDir: ".obsidian",
				adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => ""), stat: vi.fn() },
			},
			workspace: { getLeavesOfType: vi.fn(() => []) },
		},
		storage: { getPluginData: vi.fn(async () => ({})), savePluginData: vi.fn(async () => {}) },
		translator,
		noteStorage: { readNote: vi.fn(async () => "") },
		settings: { profiles: [], market: { plugins: [], lastSync: 0, syncStatus: "idle" }, betaAutoUpdate: false } as any,
		tmFolderEffective: vi.fn(() => "TranslationMemory"),
		scanVaultTM: vi.fn(async () => {}),
		migrateTMFiles: vi.fn(async () => ({ done: 0, total: 0, timedOut: false })),
		_lastTMIdsByPath: {} as Record<string, string>,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("estimateTimesFromDisk：从磁盘推断安装时间（218-233）", () => {
	it("adapter 无 stat 能力 → 返回空对象", async () => {
		const plugin = makePlugin({ app: { vault: { configDir: ".obsidian", adapter: { exists: vi.fn(), read: vi.fn() } }, workspace: { getLeavesOfType: vi.fn(() => []) } } });
		const r = await (plugin as AnyPlugin).estimateTimesFromDisk("id1");
		expect(r).toEqual({});
	});

	it("dir/manifest stat 成功 → 经 estimateInstallTimes 产出时间", async () => {
		const adapter = { configDir: ".obsidian", adapter: { stat: vi.fn(async () => ({ ctime: 100, mtime: 200 })) } };
		const plugin = makePlugin({ app: { vault: adapter, workspace: { getLeavesOfType: vi.fn(() => []) } } });
		const r = await (plugin as AnyPlugin).estimateTimesFromDisk("id1");
		expect(estimateInstallTimes).toHaveBeenCalledWith(100, 200, expect.any(Number));
		expect(r).toEqual({ firstInstalled: 1, lastInstalled: 2 });
	});

	it("estimateInstallTimes 抛错 → catch 返回空对象（不崩）", async () => {
		(estimateInstallTimes as unknown as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
			throw new Error("boom");
		});
		const adapter = { configDir: ".obsidian", adapter: { stat: vi.fn(async () => ({ ctime: 100, mtime: 200 })) } };
		const plugin = makePlugin({ app: { vault: adapter, workspace: { getLeavesOfType: vi.fn(() => []) } } });
		const r = await (plugin as AnyPlugin).estimateTimesFromDisk("id1");
		expect(r).toEqual({});
	});
});

describe("getInstallFacts：同步读取自动记录事实（361-375）", () => {
	it("缓存未就绪 → undefined", () => {
		const plugin = makePlugin({ journalHistory: undefined });
		expect((plugin as AnyPlugin).getInstallFacts("id1")).toBeUndefined();
	});

	it("命中条目 → 映射出只读事实", () => {
		const plugin = makePlugin({
			journalHistory: { entries: { id1: { firstInstalled: 5, lastInstalled: 6, uninstalled: null, installCount: 3 } } },
		});
		expect((plugin as AnyPlugin).getInstallFacts("id1")).toEqual({
			firstInstalled: 5,
			lastInstalled: 6,
			uninstalled: null,
			installCount: 3,
		});
	});

	it("无该 id → undefined", () => {
		const plugin = makePlugin({ journalHistory: { entries: {} } });
		expect((plugin as AnyPlugin).getInstallFacts("nope")).toBeUndefined();
	});
});

describe("migrateTMFromDefault：手动迁移记忆库（840-852）", () => {
	it("生效路径已是默认 → 仅重扫，不迁移、不弹通知", async () => {
		const plugin = makePlugin({ tmFolderEffective: vi.fn(() => "插件翻译记忆库") });
		await (plugin as AnyPlugin).migrateTMFromDefault();
		expect((plugin as AnyPlugin).scanVaultTM).toHaveBeenCalled();
		expect((plugin as AnyPlugin).migrateTMFiles).not.toHaveBeenCalled();
		expect(Notice).not.toHaveBeenCalled();
	});

	it("生效路径不同 → 迁移 + 重扫 + 弹通知", async () => {
		const plugin = makePlugin({ migrateTMFiles: vi.fn(async () => ({ done: 7, total: 7, timedOut: false })) });
		await (plugin as AnyPlugin).migrateTMFromDefault();
		expect((plugin as AnyPlugin).migrateTMFiles).toHaveBeenCalledWith("插件翻译记忆库", "TranslationMemory");
		expect((plugin as AnyPlugin).scanVaultTM).toHaveBeenCalled();
		expect(Notice).toHaveBeenCalled();
	});
});

describe("resolveTMFileIntoIndex：单文件解析回灌 tmApproved（931-942）", () => {
	it("approved → 写入 tmApproved 并记录 path→id", async () => {
		(parseTMNote as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: "x", status: "approved" });
		const plugin = makePlugin();
		await (plugin as AnyPlugin).resolveTMFileIntoIndex("TranslationMemory/a.md");
		expect(plugin.translator.tmApproved.x).toBeDefined();
		expect((plugin as AnyPlugin)._lastTMIdsByPath["TranslationMemory/a.md"]).toBe("x");
	});

	it("非 approved → 从 tmApproved 移除并仍记录 path→id", async () => {
		(parseTMNote as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: "x", status: "rejected" });
		const plugin = makePlugin({ translator: { tmApproved: { x: { name: "X" } } } });
		await (plugin as AnyPlugin).resolveTMFileIntoIndex("TranslationMemory/a.md");
		expect(plugin.translator.tmApproved.x).toBeUndefined();
		expect((plugin as AnyPlugin)._lastTMIdsByPath["TranslationMemory/a.md"]).toBe("x");
	});

	it("解析失败 → 不动索引", async () => {
		(parseTMNote as unknown as ReturnType<typeof vi.fn>).mockReturnValue(null);
		const plugin = makePlugin();
		await (plugin as AnyPlugin).resolveTMFileIntoIndex("TranslationMemory/a.md");
		expect((plugin as AnyPlugin)._lastTMIdsByPath["TranslationMemory/a.md"]).toBeUndefined();
	});
});

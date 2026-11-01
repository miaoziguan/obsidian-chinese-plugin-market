import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Notice } from "obsidian";
import { removeTMNote } from "@translation/memory/translation-memory";
import ChinesePluginMarketPlugin from "@app/plugin";

// 覆盖 obsidian.Notice 为 spy（生产里是 class，非 spy），其余导出保持 mock 原样
vi.mock("obsidian", async (importOriginal) => {
	const orig = await importOriginal<typeof import("obsidian")>();
	return { ...orig, Notice: vi.fn() };
});

// removeTMNote 是真实 IO（删 vault 笔记），桩掉避免副作用、便于断言调用次数
vi.mock("@translation/memory/translation-memory", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@translation/memory/translation-memory")>();
	return { ...orig, removeTMNote: vi.fn(async () => {}) };
});

type AnyPlugin = Record<string, any>;

function makeTranslator() {
	return {
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
}

function makePlugin(extra: Record<string, any> = {}) {
	const translator = makeTranslator();
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { workspace: { getLeavesOfType: vi.fn(() => []) }, vault: { adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => "") } } },
		storage: { getPluginData: vi.fn(async () => ({})), savePluginData: vi.fn(async () => {}) },
		translator,
		noteStorage: { adapter: {} },
		settings: { profiles: [], market: { plugins: [], lastSync: 0, syncStatus: "idle" }, betaAutoUpdate: false } as any,
		// 数据加载/保存相关私有方法桩：让本组测试只验证编排，不触发真实 IO
		_saveTranslatorDataImmediate: vi.fn(async () => {}),
		tmFolderEffective: vi.fn(() => "TranslationMemory"),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("saveTranslatorData / flushTranslatorData：翻译缓存落盘（防抖 + 立即刷新）", () => {
	it("saveTranslatorData：安排 800ms 防抖，到点才真正落盘", () => {
		const plugin = makePlugin();
		plugin.saveTranslatorData();
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).not.toHaveBeenCalled();
		expect((plugin as AnyPlugin)._saveTranslatorDataTimer).not.toBeNull();
		vi.advanceTimersByTime(800);
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).toHaveBeenCalledTimes(1);
	});

	it("saveTranslatorData：连续调用只触发一次落盘（clearTimeout 合并）", () => {
		const plugin = makePlugin();
		plugin.saveTranslatorData();
		plugin.saveTranslatorData(); // 第二次应 clearTimeout 第一次的定时器
		vi.advanceTimersByTime(800);
		// 防抖合并：不论调用几次，只落盘一次
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).toHaveBeenCalledTimes(1);
	});

	it("flushTranslatorData：立即落盘并清掉待触发的定时器（不重复落盘）", () => {
		const plugin = makePlugin();
		plugin.saveTranslatorData(); // 挂起一个 800ms 定时器
		expect((plugin as AnyPlugin)._saveTranslatorDataTimer).not.toBeNull();
		plugin.flushTranslatorData();
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).toHaveBeenCalledTimes(1);
		expect((plugin as AnyPlugin)._saveTranslatorDataTimer).toBeNull();
		// 再推进时间不应再次落盘
		vi.advanceTimersByTime(800);
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).toHaveBeenCalledTimes(1);
	});

	it("flushTranslatorData：无挂起定时器也直接落盘", async () => {
		const plugin = makePlugin();
		await plugin.flushTranslatorData();
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).toHaveBeenCalledTimes(1);
	});
});

describe("clearApprovedTM：清空已采纳 TM（同步删索引 + vault 笔记）", () => {
	it("没有已采纳 → 仅提示，不删笔记、不落盘", async () => {
		const plugin = makePlugin({ translator: { ...makeTranslator(), tmApproved: {} } });
		await plugin.clearApprovedTM();
		expect(Notice).toHaveBeenCalled();
		expect(removeTMNote).not.toHaveBeenCalled();
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).not.toHaveBeenCalled();
	});

	it("有已采纳 → 逐个删笔记 + 移除索引 + 落盘 + 提示 N 条", async () => {
		const remove = removeTMNote as ReturnType<typeof vi.fn>;
		const plugin = makePlugin({
			translator: { ...makeTranslator(), tmApproved: { id1: { name: "A" }, id2: { name: "B" } } },
		});
		await plugin.clearApprovedTM();
		expect(remove).toHaveBeenCalledTimes(2);
		expect(plugin.translator.removeTMApproved).toHaveBeenCalledWith("id1");
		expect(plugin.translator.removeTMApproved).toHaveBeenCalledWith("id2");
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).toHaveBeenCalledTimes(1);
		expect(Notice).toHaveBeenCalled();
	});

	it("已采纳很多（>20）→ 分批并发删，全部清理", async () => {
		const remove = removeTMNote as ReturnType<typeof vi.fn>;
		const ids: Record<string, unknown> = {};
		for (let i = 0; i < 45; i++) ids[`id${i}`] = { name: `N${i}` };
		const plugin = makePlugin({ translator: { ...makeTranslator(), tmApproved: ids } });
		await plugin.clearApprovedTM();
		expect(remove).toHaveBeenCalledTimes(45);
		expect(plugin.translator.removeTMApproved).toHaveBeenCalledTimes(45);
	});
});

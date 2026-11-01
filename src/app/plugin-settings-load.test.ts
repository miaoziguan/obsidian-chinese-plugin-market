import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的数据加载 / 设置迁移（2007-2173）：loadTranslatorData 的译名装载 +
 * 翻译源配置同步、migrateTranslatorCacheFromData 一次性迁移、loadPluginTags 离线分类索引装载。
 *
 * 既有 plugin*.test.ts 没覆盖这段「启动期配置落到 translator 端口」的逻辑——错误模式是
 * 「重启后已配置的翻译源/AI 静默失效、内联译名迁移丢失、离线分类标签不加载」。
 */

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	logger: loggerMock,
}));

type AnyPlugin = Record<string, any>;

function makeStorage(over: Record<string, unknown> = {}) {
	return {
		loadTranslatorCache: vi.fn(async () => ({
			cache: { a: { text: "x" } as unknown },
			aiDict: {},
			pluginInsights: {},
			compareInsights: {},
			coverageSnapshots: [] as unknown[],
			myMemoryBlockedDate: "",
			seenPluginIds: [] as string[],
			lastListFetchAt: 0,
		})),
		loadSeededTranslatorCache: vi.fn(async () => ({ cache: { seed: {} } as Record<string, unknown> })),
		saveTranslatorCache: vi.fn(async () => {}),
		noteTranslatorCacheLoaded: vi.fn(),
		...over,
	};
}

function makeTranslator() {
	return {
		loadData: vi.fn(),
		setApiConfig: vi.fn(),
		setUseMyMemory: vi.fn(),
		setUseTransmart: vi.fn(),
		setBaiduConfig: vi.fn(),
		setSelfHostedTranslators: vi.fn(),
		setAIConfig: vi.fn(),
		setPluginTags: vi.fn(),
		buildPluginTagMap: vi.fn(),
	};
}

function makePlugin(extra: Record<string, unknown> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as unknown as AnyPlugin;
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		settings: {
			profiles: [] as PluginProfile[],
			secretId: "sid",
			secretKey: "skey",
			region: "ap-gz",
			useMyMemory: false,
			useTransmart: false,
			baiduAppId: "bapp",
			baiduKey: "bkey",
			selfHostedTranslators: [] as unknown[],
			aiSearchEnabled: true,
			aiSearchBaseURL: "https://ai.example",
			aiSearchApiKey: "ak",
			aiSearchModel: "m",
			embeddingSource: "local",
		} as Record<string, unknown>,
		app: { vault: { adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => "") } } },
		storage: makeStorage(),
		translator: makeTranslator(),
		onPluginTagsLoaded: vi.fn(),
		buildPluginTagMap: vi.fn(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	loggerMock.warn.mockClear();
});

describe("loadTranslatorData：译名装载 + 翻译源配置同步", () => {
	it("正常装载：种子∪本地文件注入 translator，并把各项已配翻译源同步到端口", async () => {
		const plugin = makePlugin({
			storage: makeStorage({ loadTranslatorCache: vi.fn(async () => ({ cache: { a: {} }, aiDict: {}, pluginInsights: {}, compareInsights: {}, coverageSnapshots: [], myMemoryBlockedDate: "", seenPluginIds: ["p1", "p2"], lastListFetchAt: 0 })) }),
		});
		await (plugin as AnyPlugin).loadTranslatorData({});
		const t = plugin.translator;
		expect(t.loadData).toHaveBeenCalled();
		expect(t.setApiConfig).toHaveBeenCalledWith({ secretId: "sid", secretKey: "skey", region: "ap-gz" });
		expect(t.setUseMyMemory).toHaveBeenCalledWith(false);
		expect(t.setUseTransmart).toHaveBeenCalledWith(false);
		expect(t.setBaiduConfig).toHaveBeenCalledWith({ appId: "bapp", key: "bkey" });
		expect(t.setSelfHostedTranslators).toHaveBeenCalledWith([]);
		expect(t.setAIConfig).toHaveBeenCalled();
		// 无 firstSeen 但已见过插件 → 回填基线 firstSeenMap（不报新）
		expect((plugin as AnyPlugin).firstSeenMap.size).toBe(2);
	});

	it("独立文件为空且 data 含内联译名 → 触发一次性迁移后重载", async () => {
		const storage = makeStorage({ loadTranslatorCache: vi.fn(async () => null) });
		const plugin = makePlugin({ storage });
		await (plugin as AnyPlugin).loadTranslatorData({ _translatorCache: { legacy: {} } } as Record<string, unknown>);
		// 迁移被触发（合入独立文件）
		expect(storage.saveTranslatorCache).toHaveBeenCalled();
		expect(plugin.translator.loadData).toHaveBeenCalled();
	});

	it("翻译源配置缺失 → 对应 set 方法不被调用（默认走其它来源）", async () => {
		const plugin = makePlugin({
			settings: {
				profiles: [] as PluginProfile[],
				secretId: "", secretKey: "", baiduAppId: "", baiduKey: "",
				useMyMemory: false, useTransmart: false, selfHostedTranslators: [],
				aiSearchEnabled: false, aiSearchBaseURL: "", aiSearchApiKey: "", aiSearchModel: "",
				embeddingSource: "local",
			} as Record<string, unknown>,
		});
		await (plugin as AnyPlugin).loadTranslatorData({});
		expect(plugin.translator.setApiConfig).not.toHaveBeenCalled();
		expect(plugin.translator.setBaiduConfig).not.toHaveBeenCalled();
		expect(plugin.translator.setAIConfig).not.toHaveBeenCalled();
		expect(plugin.translator.setSelfHostedTranslators).toHaveBeenCalledWith([]);
	});
});

describe("migrateTranslatorCacheFromData：data.json 内联译名一次性迁移", () => {
	it("合并内联译名并落盘独立文件（内联 ∪ 已有，内联不覆盖已有）", async () => {
		const storage = makeStorage();
		const plugin = makePlugin({ storage });
		await (plugin as AnyPlugin).migrateTranslatorCacheFromData({
			_translatorCache: { inline: {} },
			_translatorAiDict: { k: {} },
			_seenPluginIds: ["x"],
		} as Record<string, unknown>);
		expect(storage.saveTranslatorCache).toHaveBeenCalled();
		const merged = (storage.saveTranslatorCache as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(merged.cache.inline).toBeDefined();
		expect(merged.aiDict.k).toBeDefined();
	});

	it("无内联键 → 仅以已有文件为准（幂等，不丢数据）", async () => {
		const storage = makeStorage();
		const plugin = makePlugin({ storage });
		await (plugin as AnyPlugin).migrateTranslatorCacheFromData({} as Record<string, unknown>);
		expect(storage.saveTranslatorCache).toHaveBeenCalled();
	});

	it("保存抛错 → 不冒泡（catch 记日志，下次 reload 重试）", async () => {
		const storage = makeStorage({ saveTranslatorCache: vi.fn(async () => { throw new Error("disk"); }) });
		const plugin = makePlugin({ storage });
		await (plugin as AnyPlugin).migrateTranslatorCacheFromData({} as Record<string, unknown>);
		expect(loggerMock.warn).toHaveBeenCalled();
	});
});

describe("loadPluginTags：离线分类索引 plugin-tags.json 装载", () => {
	it("文件存在且为对象 → 注入分类标签、建索引、通知视图刷新", async () => {
		const plugin = makePlugin({
			app: { vault: { adapter: { exists: vi.fn(async () => true), read: vi.fn(async () => JSON.stringify({ t1: { cat: "a" } })) } } },
		});
		await (plugin as AnyPlugin).loadPluginTags();
		expect(plugin.translator.setPluginTags).toHaveBeenCalledWith({ t1: { cat: "a" } });
		expect((plugin as AnyPlugin).buildPluginTagMap).toHaveBeenCalled();
		expect(plugin.onPluginTagsLoaded).toHaveBeenCalled();
	});

	it("文件缺失 → 静默降级，不注入标签", async () => {
		const plugin = makePlugin({ app: { vault: { adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => "") } } } });
		await (plugin as AnyPlugin).loadPluginTags();
		expect(plugin.translator.setPluginTags).not.toHaveBeenCalled();
	});

	it("JSON 解析失败 → catch 记日志，不注入标签（分类 Tab 显示空提示）", async () => {
		const plugin = makePlugin({
			app: { vault: { adapter: { exists: vi.fn(async () => true), read: vi.fn(async () => "not json {") } } },
		});
		await (plugin as AnyPlugin).loadPluginTags();
		expect(loggerMock.warn).toHaveBeenCalled();
		expect(plugin.translator.setPluginTags).not.toHaveBeenCalled();
	});

	it("JSON 为数组（非对象）→ 跳过，不注入", async () => {
		const plugin = makePlugin({
			app: { vault: { adapter: { exists: vi.fn(async () => true), read: vi.fn(async () => "[]") } } },
		});
		await (plugin as AnyPlugin).loadPluginTags();
		expect(plugin.translator.setPluginTags).not.toHaveBeenCalled();
	});
});

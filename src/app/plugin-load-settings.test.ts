import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的 loadSettings（1356-1470）——一个承载大量旧版数据迁移分支的大方法。
 * 既有 onload 测试把 loadSettings 整个 stub 掉了，所以它的方法体从来没有真正跑过，内部
 * 所有迁移分支（locale/sourceFilter/versionPins/translateSettingsEnabled/credentials/favorites/
 * translator-cache/embedding 模型与来源/移动端降级）全是零覆盖。错误模式是「老用户升级后
 * 旧设置残留、密钥明文留在 data.json、本地向量能力没打开、data.json 仍含 1.9MB 内联译名」。
 *
 * 手法：直接以受控 allData 调用 loadSettings（绕开 onload 与 loadData），把 storage 的
 * loadCredentials/loadFavorites、ensureSettingsTranslator、migrateTranslatorCacheFromData、
 * _saveSettingsImmediate 经 Object.assign 打桩；DEFAULT_SETTINGS/normalizeManageSettings/
 * CREDENTIAL_KEYS/DEFAULT_LOCAL_MODEL 走真实模块。私人方法/字段经 AnyPlugin 转型访问。
 * 本轮绝不碰已有测试文件。
 */

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		storage: {
			loadCredentials: vi.fn(async () => null),
			loadFavorites: vi.fn(async () => null),
		},
		ensureSettingsTranslator: vi.fn(function (this: AnyPlugin) {
			this.settingsTranslator = { loadCache: vi.fn(), enable: vi.fn() };
		}),
		settingsTranslator: null,
		migrateTranslatorCacheFromData: vi.fn(async () => {}),
		_saveSettingsImmediate: vi.fn(async () => {}),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("loadSettings：旧版数据迁移大方法（1356-1470）", () => {
	it("清理 locale/favoriteFilter 残留 + sourceFilter=custom→all + versionPins 兜底（1359-1381）", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).loadSettings({
			locale: "zh",
			favoriteFilter: "x",
			sourceFilter: "custom",
			pluginVersionPins: "bad",
		});
		expect((plugin as AnyPlugin).settings.locale).toBeUndefined();
		expect((plugin as AnyPlugin).settings.favoriteFilter).toBeUndefined();
		expect((plugin as AnyPlugin).settings.sourceFilter).toBe("all");
		expect((plugin as AnyPlugin).settings.pluginVersionPins).toEqual({});
	});

	it("sourceFilter 批量/在线/AI → translated（1368-1369）", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).loadSettings({ sourceFilter: "bulk" });
		expect((plugin as AnyPlugin).settings.sourceFilter).toBe("translated");
	});

	it("translateSettingsEnabled 开启 → 挂载钩子并载入缓存（1384-1387）", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).loadSettings({
			translateSettingsEnabled: true,
			settingsTranslateCache: { a: 1 },
		});
		expect((plugin as AnyPlugin).ensureSettingsTranslator).toHaveBeenCalled();
		expect((plugin as AnyPlugin).settingsTranslator.loadCache).toHaveBeenCalledWith({ a: 1 });
		expect((plugin as AnyPlugin).settingsTranslator.enable).toHaveBeenCalled();
	});

	it("credentials 合并到 settings（1396-1399）", async () => {
		const plugin = makePlugin({
			storage: {
				loadCredentials: vi.fn(async () => ({ aiSearchApiKey: "sk-xyz" })),
				loadFavorites: vi.fn(async () => null),
			},
		});
		await (plugin as AnyPlugin).loadSettings({});
		expect((plugin as AnyPlugin).settings.aiSearchApiKey).toBe("sk-xyz");
	});

	it("favorites 合并到 settings（1407-1408）", async () => {
		const plugin = makePlugin({
			storage: {
				loadCredentials: vi.fn(async () => null),
				loadFavorites: vi.fn(async () => ["a", "b"]),
			},
		});
		await (plugin as AnyPlugin).loadSettings({});
		expect((plugin as AnyPlugin).settings.favorites).toEqual(["a", "b"]);
	});

	it("data.json 含内联译名 → 迁移并立即落盘瘦身（1424-1440）", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).loadSettings({ _translatorCache: {} });
		expect((plugin as AnyPlugin).migrateTranslatorCacheFromData).toHaveBeenCalled();
		expect((plugin as AnyPlugin)._saveSettingsImmediate).toHaveBeenCalled();
	});

	it("本地模型名旧默认 → 迁移到当前默认（1445-1449）", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).loadSettings({ embeddingLocalModel: "all-MiniLM-L6-v2" });
		expect((plugin as AnyPlugin).settings.embeddingLocalModel).toBe("Xenova/multilingual-e5-small");
	});

	it("embeddingSource=keyword → 迁移到 local（1454-1456）", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).loadSettings({ embeddingSource: "keyword" });
		expect((plugin as AnyPlugin).settings.embeddingSource).toBe("local");
	});
});

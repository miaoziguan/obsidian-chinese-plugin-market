import { describe, it, expect } from "vitest";

import { MemoryStoragePort } from "@data/storage/storage-port";
import {
	PluginStorage,
	CREDENTIAL_KEYS,
	type TranslatorPersistedData,
	type PluginCredentials,
} from "@data/storage/plugin-storage";
import type { PluginStat } from "@domain/catalog/stats";
import type { InstallHistoryFile } from "@domain/journal/install-history";
import type { TranslateResult, DictEntry, CoverageSnapshot } from "@domain/catalog/translator";

/**
 * 平台解耦验收：PluginStorage 不再依赖 Obsidian App，
 * 用 mock StoragePort（内存实现）即可完整覆盖三类缓存的读写与容错。
 */
const PID = "chinese-plugin-market";

function make() {
	const port = new MemoryStoragePort();
	return { port, storage: new PluginStorage(port, PID) };
}

describe("PluginStorage · StoragePort 端口注入", () => {
	it("stats 缓存写入后可回读（内存端口，无需 Obsidian）", async () => {
		const { storage } = make();
		const map = new Map<string, PluginStat>([["git", { downloads: 100, updated: 1700000000000 }]]);
		await storage.saveStatsCache(map);
		const back = await storage.loadStatsCache();
		expect(back?.get("git")?.downloads).toBe(100);
		expect(back?.get("git")?.updated).toBe(1700000000000);
	});

	it("stats 缓存超过 TTL（6h）视为失效，返回 null", async () => {
		const { port, storage } = make();
		await port.write(
			`.obsidian/plugins/${PID}/stats-cache.json`,
			JSON.stringify({ savedAt: Date.now() - 7 * 60 * 60 * 1000, stats: { git: { downloads: 1 } } }),
		);
		expect(await storage.loadStatsCache()).toBeNull();
	});

	it("缓存文件不存在时返回 null，而非抛错", async () => {
		const { storage } = make();
		expect(await storage.loadStatsCache()).toBeNull();
		expect(await storage.loadTrendingHistory()).toBeNull();
		expect(await storage.loadPluginListCache()).toBeNull();
	});

	it("插件列表缓存缺失时回退旧版 data.json 内嵌键（迁移兼容）", async () => {
		const { storage } = make();
		const legacy = { _pluginListCache: [{ id: "git" }] };
		expect(await storage.loadPluginListCache(legacy)).toEqual([{ id: "git" }]);
	});

	it("趋势历史写入后可回读；损坏内容降级为 null 不抛错", async () => {
		const { port, storage } = make();
		await storage.saveTrendingHistory({ git: [] });
		expect(await storage.loadTrendingHistory()).toEqual({ git: [] });

		await port.write(`.obsidian/plugins/${PID}/trending-history.json`, "{ 坏 JSON");
		expect(await storage.loadTrendingHistory()).toBeNull();
	});

	it("端口写入失败时静默降级（不把异常抛给调用方）", async () => {
		const failing = {
			exists: () => Promise.resolve(false),
			read: () => Promise.reject(new Error("boom")),
			write: () => Promise.reject(new Error("boom")),
		};
		const storage = new PluginStorage(failing, PID);
		await expect(storage.saveStatsCache(new Map())).resolves.toBeUndefined();
		await expect(storage.savePluginListCache([])).resolves.toBeUndefined();
		await expect(storage.saveTrendingHistory({})).resolves.toBeUndefined();
	});
});

describe("PluginStorage · 翻译缓存缩水守卫（2026-09-20 空写回事故防线）", () => {
	const mkCache = (n: number) => {
		const cache: Record<string, unknown> = {};
		for (let i = 0; i < n; i++) cache["p" + i] = { translatedName: "t" + i, translatedDesc: "d", source: "ai" };
		return cache;
	};
	const save = (storage: PluginStorage, n: number) =>
		storage.saveTranslatorCache({ cache: mkCache(n) } as any);
	const FILE = `.obsidian/plugins/${PID}/translator-cache.json`;

	it("写回缩水 >50% 拒写：文件不落地（空读竞争模拟）", async () => {
		const { port, storage } = make();
		storage.noteTranslatorCacheLoaded(100);
		await save(storage, 10);
		expect(await port.exists(FILE)).toBe(false);
	});

	it("正常写盘通过且基准随成功写盘推进", async () => {
		const { port, storage } = make();
		storage.noteTranslatorCacheLoaded(100);
		await save(storage, 120);
		expect(await port.exists(FILE)).toBe(true);
		await save(storage, 60); // =50% 不触发（阈值是 <50%）
		await save(storage, 20); // <60 的 50% → 拒写，文件保留 60 条版本
		const last = JSON.parse((await port.read(FILE))!);
		expect(Object.keys(last.cache).length).toBe(60);
	});

	it("无加载基准（首装/空环境）不触发守卫", async () => {
		const { port, storage } = make();
		await save(storage, 3);
		expect(await port.exists(FILE)).toBe(true);
	});
});

describe("PluginStorage · 安装历史索引（评测台账）", () => {
	it("缺失时返回空索引，不抛错、不阻断首屏", async () => {
		const { storage } = make();
		const f = await storage.loadInstallHistory();
		expect(f.entries).toEqual({});
		expect(f.version).toBe(1);
	});

	it("写入后可回读，且 round-trip 等价", async () => {
		const { storage } = make();
		const file = {
			version: 1 as const,
			entries: {
				git: {
					name: "Git",
					firstInstalled: 1,
					lastInstalled: 1,
					uninstalled: null,
					currentlyInstalled: true,
					currentlyEnabled: true,
					installCount: 1,
				},
			},
		};
		await storage.saveInstallHistory(file);
		const back = await storage.loadInstallHistory();
		expect(back.entries.git).toEqual(file.entries.git);
	});

	it("损坏内容降级为空索引，不抛错", async () => {
		const { port, storage } = make();
		await port.write(`.obsidian/plugins/${PID}/install-history.json`, "{ 坏 JSON");
		const f = await storage.loadInstallHistory();
		expect(f.entries).toEqual({});
	});
});

// ─────────────────────────────────────────────────────────────
// 追加用例：补齐此前未覆盖的保存/读取全分支（收藏、凭据、翻译缓存读取、种子库、
// 安装历史写入、stats/列表/趋势的「损坏/缺失/旧版回退」分支）。保留原 13 例。
// ─────────────────────────────────────────────────────────────

const PATH = (f: string) => `.obsidian/plugins/${PID}/${f}`;
const LEGACY = (f: string) => `${f}`; // 旧版（v2.15.x）曾误写 vault 根相对路径

const mkCache = (over: Partial<TranslatorPersistedData> = {}): TranslatorPersistedData => ({
	cache: { Hello: { translatedName: "你好", translatedDesc: "", source: "ai" } as unknown as TranslateResult },
	aiDict: { k: { key: "k", translation: "v" } as unknown as DictEntry },
	pluginInsights: { p: { x: 1 } },
	compareInsights: { p: { y: 2 } },
	coverageSnapshots: [] as CoverageSnapshot[],
	myMemoryBlockedDate: "2026-01-01",
	seenPluginIds: ["git"],
	lastListFetchAt: 123,
	firstSeenIds: { git: 456 },
	...over,
});

const mkCreds = (over: Partial<PluginCredentials> = {}): PluginCredentials => ({
	secretId: "sid", secretKey: "sk", region: "ap",
	aiSearchApiKey: "ak", aiSearchBaseURL: "au",
	embeddingApiKey: "ek", embeddingBaseURL: "eu",
	selfHostedTranslators: [{ type: "deeplx", baseUrl: "http://x" }],
	baiduAppId: "baid", baiduKey: "bk",
	...over,
});

describe("PluginStorage · 安装历史写入", () => {
	it("saveInstallHistory 成功写入后 loadInstallHistory 回读等价", async () => {
		const { storage } = make();
		const file: InstallHistoryFile = {
			version: 1,
			entries: {
				git: {
					name: "Git", firstInstalled: 1, lastInstalled: 1, uninstalled: null,
					currentlyInstalled: true, currentlyEnabled: true, installCount: 1,
				},
			},
		};
		await storage.saveInstallHistory(file);
		expect(await storage.loadInstallHistory()).toEqual(file);
	});

	it("saveInstallHistory 写入失败静默降级", async () => {
		const failing = {
			exists: () => Promise.resolve(false),
			read: () => Promise.reject(new Error("x")),
			write: () => Promise.reject(new Error("boom")),
		};
		const storage = new PluginStorage(failing, PID);
		await expect(storage.saveInstallHistory({ version: 1, entries: {} })).resolves.toBeUndefined();
	});
});

describe("PluginStorage · 翻译缓存读取 + 种子库", () => {
	it("loadTranslatorCache 成功读取完整字段", async () => {
		const { port, storage } = make();
		await port.write(PATH("translator-cache.json"), JSON.stringify(mkCache()));
		const r = await storage.loadTranslatorCache();
		expect(r?.seenPluginIds).toEqual(["git"]);
		expect(r?.lastListFetchAt).toBe(123);
		expect(r?.firstSeenIds).toEqual({ git: 456 });
		expect(r?.myMemoryBlockedDate).toBe("2026-01-01");
	});

	it("loadTranslatorCache 文件缺失 → null", async () => {
		const { storage } = make();
		expect(await storage.loadTranslatorCache()).toBeNull();
	});

	it("loadTranslatorCache 旧版 vault 根文件回退读取", async () => {
		const { port, storage } = make();
		await port.write(LEGACY("translator-cache.json"), JSON.stringify(mkCache({ seenPluginIds: ["legacy"] })));
		const r = await storage.loadTranslatorCache();
		expect(r?.seenPluginIds).toEqual(["legacy"]);
	});

	it("loadTranslatorCache 损坏 / 非对象 → null", async () => {
		const { port, storage } = make();
		await port.write(PATH("translator-cache.json"), "{ 坏 JSON");
		expect(await storage.loadTranslatorCache()).toBeNull();
		await port.write(PATH("translator-cache.json"), JSON.stringify(123));
		expect(await storage.loadTranslatorCache()).toBeNull();
	});

	it("loadSeededTranslatorCache 成功读取（seed 版本不含 firstSeenIds 键，调用方用 ?? {} 兜底）", async () => {
		const { port, storage } = make();
		await port.write(LEGACY("seeded-translator-cache.json"), JSON.stringify(mkCache()));
		const r = await storage.loadSeededTranslatorCache();
		expect(r?.seenPluginIds).toEqual(["git"]);
		expect(r?.firstSeenIds).toBeUndefined();
	});

	it("loadSeededTranslatorCache 缺失 / 损坏 / 非对象 → null", async () => {
		const { port, storage } = make();
		expect(await storage.loadSeededTranslatorCache()).toBeNull();
		await port.write(LEGACY("seeded-translator-cache.json"), "{ 坏");
		expect(await storage.loadSeededTranslatorCache()).toBeNull();
		await port.write(LEGACY("seeded-translator-cache.json"), JSON.stringify("str"));
		expect(await storage.loadSeededTranslatorCache()).toBeNull();
	});
});

describe("PluginStorage · 收藏 favorites", () => {
	it("saveFavorites + loadFavorites 成功往返", async () => {
		const { storage } = make();
		await storage.saveFavorites(["a", "b"]);
		expect(await storage.loadFavorites()).toEqual(["a", "b"]);
	});

	it("loadFavorites 缺失 → null", async () => {
		const { storage } = make();
		expect(await storage.loadFavorites()).toBeNull();
	});

	it("loadFavorites 独立文件损坏 → null（不抛错）", async () => {
		const { port, storage } = make();
		await port.write(PATH("favorites.json"), "{ 坏");
		expect(await storage.loadFavorites()).toBeNull();
	});

	it("loadFavorites 旧版 vault 根 favorites.json 回退", async () => {
		const { port, storage } = make();
		await port.write(LEGACY("favorites.json"), JSON.stringify({ favorites: ["legacy1"] }));
		expect(await storage.loadFavorites()).toEqual(["legacy1"]);
	});

	it("loadFavorites 独立文件 favorites 非数组 → 回退 legacyData 内嵌键", async () => {
		const { port, storage } = make();
		await port.write(PATH("favorites.json"), JSON.stringify({ favorites: "not-array" }));
		expect(await storage.loadFavorites({ favorites: ["emb"] })).toEqual(["emb"]);
	});

	it("loadFavorites 仅 legacyData 内嵌键（无独立/旧文件）", async () => {
		const { storage } = make();
		expect(await storage.loadFavorites({ favorites: ["only"] })).toEqual(["only"]);
	});
});

describe("PluginStorage · 凭据 credentials", () => {
	it("saveCredentials + loadCredentials 成功且字段完整", async () => {
		const { storage } = make();
		await storage.saveCredentials(mkCreds());
		expect(await storage.loadCredentials()).toEqual(mkCreds());
	});

	it("loadCredentials 缺失 → null", async () => {
		const { storage } = make();
		expect(await storage.loadCredentials()).toBeNull();
	});

	it("loadCredentials 旧版 vault 根 credentials.json 回退", async () => {
		const { port, storage } = make();
		await port.write(LEGACY("credentials.json"), JSON.stringify(mkCreds({ secretId: "legacy" })));
		expect((await storage.loadCredentials())?.secretId).toBe("legacy");
	});

	it("loadCredentials 损坏 / 非对象 → null", async () => {
		const { port, storage } = make();
		await port.write(PATH("credentials.json"), "{ 坏");
		expect(await storage.loadCredentials()).toBeNull();
		await port.write(PATH("credentials.json"), JSON.stringify(123));
		expect(await storage.loadCredentials()).toBeNull();
	});

	it("CREDENTIAL_KEYS 含百度密钥（明文泄露修复回归）", () => {
		expect(CREDENTIAL_KEYS).toContain("baiduAppId");
		expect(CREDENTIAL_KEYS).toContain("baiduKey");
		expect(CREDENTIAL_KEYS).toContain("secretKey");
	});
});

describe("PluginStorage · stats/列表/趋势 读取边角", () => {
	it("loadStatsCache：savedAt 非 number → null", async () => {
		const { port, storage } = make();
		await port.write(PATH("stats-cache.json"), JSON.stringify({ savedAt: "x", stats: { git: { downloads: 1 } } }));
		expect(await storage.loadStatsCache()).toBeNull();
	});

	it("loadStatsCache：parsed 非 object → null", async () => {
		const { port, storage } = make();
		await port.write(PATH("stats-cache.json"), JSON.stringify(123));
		expect(await storage.loadStatsCache()).toBeNull();
	});

	it("loadStatsCache：损坏 JSON → null", async () => {
		const { port, storage } = make();
		await port.write(PATH("stats-cache.json"), "{ 坏");
		expect(await storage.loadStatsCache()).toBeNull();
	});

	it("loadPluginListCache：独立文件为空数组 → 继续回退 legacyData", async () => {
		const { port, storage } = make();
		await port.write(PATH("plugin-list-cache.json"), JSON.stringify([]));
		expect(await storage.loadPluginListCache({ _pluginListCache: [{ id: "x" }] })).toEqual([{ id: "x" }]);
	});

	it("loadPluginListCache：损坏 JSON → null（catch）", async () => {
		const { port, storage } = make();
		await port.write(PATH("plugin-list-cache.json"), "{ 坏");
		expect(await storage.loadPluginListCache()).toBeNull();
	});

	it("savePluginListCache 成功写入后回读", async () => {
		const { port, storage } = make();
		await storage.savePluginListCache([{ id: "git" }]);
		expect(await port.exists(PATH("plugin-list-cache.json"))).toBe(true);
		expect(JSON.parse((await port.read(PATH("plugin-list-cache.json")))!)).toEqual([{ id: "git" }]);
	});

	it("loadTrendingHistory：parsed 为数组 → null（非对象）", async () => {
		const { port, storage } = make();
		await port.write(PATH("trending-history.json"), JSON.stringify([]));
		expect(await storage.loadTrendingHistory()).toBeNull();
	});

	it("loadTrendingHistory：损坏 → null", async () => {
		const { port, storage } = make();
		await port.write(PATH("trending-history.json"), "{ 坏");
		expect(await storage.loadTrendingHistory()).toBeNull();
	});
});

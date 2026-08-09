import { describe, it, expect } from "vitest";

import { MemoryStoragePort } from "@data/storage/storage-port";
import { PluginStorage } from "@data/storage/plugin-storage";
import type { PluginStat } from "@domain/catalog/stats";

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

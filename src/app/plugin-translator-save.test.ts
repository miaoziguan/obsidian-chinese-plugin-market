import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * _saveTranslatorDataImmediate —— 翻译缓存的真实落盘路径（无防抖）。
 *
 * 三条不能破的约束：
 *   1. source === "original" 的条目是「原名占位」，不该写进持久化缓存（纯浪费体积）
 *   2. 指纹（内容哈希）未变则整段跳过序列化 + 写盘（PERF-5：防抖只合并频率，不降单次成本）
 *   3. 只有写盘成功才更新指纹，失败必须保留旧指纹以便下次重试
 */

type CacheRec = { source: string; translatedName: string; translatedDesc: string };

function makeTranslatorData(cache: Record<string, CacheRec> = {}) {
	return {
		cache,
		aiDict: { hello: "你好" } as Record<string, unknown>,
		pluginInsights: {} as Record<string, unknown>,
		compareInsights: {} as Record<string, unknown>,
		coverageSnapshots: [] as unknown[],
		myMemoryBlockedDate: null as string | null,
	};
}

function makePlugin(data = makeTranslatorData()) {
	const saveTranslatorCache = vi.fn(async (_payload: unknown) => {});
	const flushTMVault = vi.fn(async () => {});
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		translator: { getData: () => data },
		storage: { saveTranslatorCache },
		flushTMVault,
		seenPluginIds: new Set(["a"]),
		lastListFetchAt: 123,
		firstSeenMap: new Map([["a", 100]]),
		_lastTranslatorFingerprint: null,
	});
	return { plugin, saveTranslatorCache, flushTMVault, data };
}

const runSave = (plugin: unknown, flushVault?: boolean) =>
	(
		plugin as { _saveTranslatorDataImmediate(f?: boolean): Promise<void> }
	)._saveTranslatorDataImmediate(flushVault);

beforeEach(() => {
	vi.clearAllMocks();
});

describe("_saveTranslatorDataImmediate：缓存过滤", () => {
	it("source 为 original 的条目不计入持久化缓存", async () => {
		const { plugin, saveTranslatorCache } = makePlugin(
			makeTranslatorData({
				orig: { source: "original", translatedName: "原名", translatedDesc: "原述" },
				ai: { source: "ai", translatedName: "译名", translatedDesc: "译述" },
			}),
		);

		await runSave(plugin);

		const payload = saveTranslatorCache.mock.calls[0][0] as unknown as {
			cache: Record<string, CacheRec>;
		};
		expect(Object.keys(payload.cache)).toEqual(["ai"]);
	});

	it("同时带上全局事实字段（第一次见到时间、列表拉取时间、已知 id）", async () => {
		const { plugin, saveTranslatorCache } = makePlugin();

		await runSave(plugin);

		const payload = saveTranslatorCache.mock.calls[0][0] as unknown as Record<string, unknown>;
		expect(payload.seenPluginIds).toEqual(["a"]);
		expect(payload.lastListFetchAt).toBe(123);
		expect(payload.firstSeenIds).toEqual({ a: 100 });
	});
});

describe("_saveTranslatorDataImmediate：指纹短路", () => {
	it("内容未变时第二次调用不再写盘", async () => {
		const { plugin, saveTranslatorCache } = makePlugin();

		await runSave(plugin);
		await runSave(plugin);

		expect(saveTranslatorCache).toHaveBeenCalledTimes(1);
	});

	it("译文变化会打破指纹并重新写盘", async () => {
		const { plugin, saveTranslatorCache, data } = makePlugin(
			makeTranslatorData({ ai: { source: "ai", translatedName: "旧", translatedDesc: "d" } }),
		);

		await runSave(plugin);
		data.cache.ai.translatedName = "新";
		await runSave(plugin);

		expect(saveTranslatorCache).toHaveBeenCalledTimes(2);
	});

	it("仅 AI 词典条数变化也算内容变化", async () => {
		const { plugin, saveTranslatorCache, data } = makePlugin();

		await runSave(plugin);
		(data.aiDict as Record<string, unknown>).world = "世界";
		await runSave(plugin);

		expect(saveTranslatorCache).toHaveBeenCalledTimes(2);
	});

	it("known id 集合增长会触发重写（列表是否已收录属于持久化事实）", async () => {
		const { plugin, saveTranslatorCache } = makePlugin();

		await runSave(plugin);
		plugin.seenPluginIds.add("b");
		await runSave(plugin);

		expect(saveTranslatorCache).toHaveBeenCalledTimes(2);
	});
});

describe("_saveTranslatorDataImmediate：失败重试语义", () => {
	it("写盘失败时不更新指纹，下次调用仍会重试", async () => {
		const { plugin, saveTranslatorCache } = makePlugin();
		saveTranslatorCache.mockRejectedValueOnce(new Error("ENOSPC"));

		await expect(runSave(plugin)).rejects.toThrow("ENOSPC");
		await expect(runSave(plugin)).resolves.toBeUndefined();

		// 第一次失败 + 第二次重试成功
		expect(saveTranslatorCache).toHaveBeenCalledTimes(2);
	});

	it("写盘失败后指纹仍为空，不会误判为「已是最新」", async () => {
		const { plugin, saveTranslatorCache } = makePlugin();
		saveTranslatorCache.mockRejectedValueOnce(new Error("EBUSY"));

		await expect(runSave(plugin)).rejects.toThrow();
		expect((plugin as unknown as { _lastTranslatorFingerprint: unknown })._lastTranslatorFingerprint).toBeNull();
	});
});

describe("_saveTranslatorDataImmediate：与 TM 落盘的顺序", () => {
	it("默认先 flush TM 笔记再写缓存", async () => {
		const { plugin, flushTMVault, saveTranslatorCache } = makePlugin();

		await runSave(plugin);

		expect(flushTMVault).toHaveBeenCalled();
		const flushOrder = flushTMVault.mock.invocationCallOrder[0];
		const saveOrder = saveTranslatorCache.mock.invocationCallOrder[0];
		expect(flushOrder).toBeLessThan(saveOrder);
	});

	it("卸载路径传 false 时跳过 TM 笔记（onunload 时序不可靠）", async () => {
		const { plugin, flushTMVault } = makePlugin();

		await runSave(plugin, false);

		expect(flushTMVault).not.toHaveBeenCalled();
	});
});

import { describe, it, expect, vi, afterEach } from "vitest";
import { Translator } from "@domain/catalog/translator";
import type { TranslateResult } from "@domain/catalog/translator";
import * as embedding from "@semantic/embedding";
import { AISearcher } from "@domain/search/ai";
import * as translateApi from "@translation/api/api";
import { MyMemoryClient, LLMClient } from "@translation/api/api";

/**
 * 用法 A（分类维度注入 AI 语义搜索）在 Translator 层的回归测试：
 *   1. setPluginTags 能存分类体系版本号并透出；
 *   2. aiSearch 走向量召回时，把 pluginTags 的 category/tags 拼进 buildVectorIndex。
 */

describe("Translator · 用法 A 分类维度注入", () => {
	it("setPluginTags 存储分类数据并记录 schema 版本号", () => {
		const t = new Translator();
		const tags = {
			sync: { category: "同步与备份", tags: ["同步", "云盘"] },
			kanban: { category: "任务与项目", tags: ["看板"] },
		};
		t.setPluginTags(tags, "v7");
		expect(t.getPluginTag("sync")?.category).toBe("同步与备份");
		expect(t.getCategorySchemaVersion()).toBe("v7");
	});

	it("setPluginTags 不传版本号时 getCategorySchemaVersion 为 undefined", () => {
		const t = new Translator();
		t.setPluginTags({ a: { category: "x", tags: [] } });
		expect(t.getCategorySchemaVersion()).toBeUndefined();
	});

	it("aiSearch 向量召回：buildVectorIndex 收到带 category/tags 的插件", async () => {
		const spy = vi
			.spyOn(embedding, "buildVectorIndex")
			.mockImplementation(async (_p, plugins, model, _prev, _ver) => ({
				ids: plugins.map((x) => x.id),
				vectors: plugins.map(() => [0, 0, 0]),
				hash: "h",
				model,
				categorySchemaVersion: _ver,
			}));
		vi.spyOn(embedding, "vectorRecallScores").mockResolvedValue(new Map([["sync", 0.9]]));

		const t = new Translator();
		t.setPluginTags(
			{ sync: { category: "同步与备份", tags: ["同步", "云盘"] } },
			"v7"
		);

		const allPlugins = [
			{ id: "sync", name: "Sync", description: "keep notes in sync" },
			{ id: "theme", name: "Theme", description: "color themes" },
		];
		const config = {
			baseURL: "http://x",
			apiKey: "k",
			model: "m",
			embedding: { source: "api" as const, baseURL: "http://x", apiKey: "k", model: "m" },
		};

		try {
			await t.aiSearch("同步", allPlugins, config, false, () => {});
		} catch {
			// 可能走到 LLM 兜底而失败，不关心；只要 buildVectorIndex 已被正确调用即可
		}

		expect(spy).toHaveBeenCalled();
		const passedPlugins = spy.mock.calls[0][1] as Array<{ id: string; category?: string; tags?: string[] }>;
		const syncArg = passedPlugins.find((p) => p.id === "sync");
		expect(syncArg?.category).toBe("同步与备份");
		expect(syncArg?.tags).toEqual(["同步", "云盘"]);
		expect(spy.mock.calls[0][4]).toBe("v7");

		spy.mockRestore();
	});
});

/**
 * 用法 B（分类 facet 筛选器 · 长期价值版）在 Translator 层的回归测试：
 *   1. 传 filterCategories 时，召回候选池被收窄到选中分类（召回层交集）；
 *   2. 传 filterCategories 时，向量召回的 query 被注入分类强锚（分类即语境）；
 *   3. 不传 / 空数组时行为不变（零回归）。
 */
describe("Translator · 用法 B 分类 facet 筛选器", () => {
	// 构造可控的 mock：向量召回返回全部 id，本地召回返回全部 id，
	// 让“并集”= 全部插件，从而验证 filterCategories 在并集后的收窄效果。
	function makeTranslator() {
		const allPlugins = [
			{ id: "sync", name: "Sync", description: "keep notes in sync" },
			{ id: "kanban", name: "Kanban", description: "board for tasks" },
			{ id: "theme", name: "Theme", description: "color themes" },
		];
		const tags = {
			sync: { category: "同步与备份", tags: ["同步"] },
			kanban: { category: "任务与项目", tags: ["看板"] },
			theme: { category: "外观与主题", tags: ["主题"] },
		};
		const config = {
			baseURL: "http://x",
			apiKey: "k",
			model: "m",
			embedding: { source: "api" as const, baseURL: "http://x", apiKey: "k", model: "m" },
		};
		return { allPlugins, tags, config };
	}

	it("传 filterCategories 时，召回候选全部落在选中分类内", async () => {
		// 拦截 rankTop，直接回传候选 id，绕过 LLM，便于断言输入子集。
		const rankSpy = vi
			.spyOn(AISearcher.prototype as any, "rankTop")
			.mockImplementation(async (_q: string, merged: any[]) => ({
				rankedIds: merged.map((c) => c.id),
			}));
		vi.spyOn(embedding, "buildVectorIndex").mockImplementation(
			async (_p, plugins, model, _prev, _ver) => ({
				ids: plugins.map((x) => x.id),
				vectors: plugins.map(() => [0, 0, 0]),
				hash: "h",
				model,
				categorySchemaVersion: _ver,
			})
		);
		// 向量召回返回全部 id，逼出“并集=全部”，从而暴露 filterCategories 的收窄作用
		vi.spyOn(embedding, "vectorRecallScores").mockResolvedValue(
			new Map([["sync", 0.9], ["kanban", 0.8], ["theme", 0.7]])
		);

		const t = new Translator();
		const { allPlugins, tags, config } = makeTranslator();
		t.setPluginTags(tags, "v7");

		const res = await t.aiSearch(
			"同步",
			allPlugins,
			config,
			false,
			() => {},
			["同步与备份"] // 只选“同步与备份”
		);

		expect(res.rankedIds).toEqual(["sync"]);
		rankSpy.mockRestore();
	});

	it("不传 filterCategories 时，候选不被收窄（零回归）", async () => {
		const rankSpy = vi
			.spyOn(AISearcher.prototype as any, "rankTop")
			.mockImplementation(async (_q: string, merged: any[]) => ({
				rankedIds: merged.map((c) => c.id),
			}));
		vi.spyOn(embedding, "buildVectorIndex").mockImplementation(
			async (_p, plugins, model, _prev, _ver) => ({
				ids: plugins.map((x) => x.id),
				vectors: plugins.map(() => [0, 0, 0]),
				hash: "h",
				model,
				categorySchemaVersion: _ver,
			})
		);
		vi.spyOn(embedding, "vectorRecallScores").mockResolvedValue(
			new Map([["sync", 0.9], ["kanban", 0.8], ["theme", 0.7]])
		);

		const t = new Translator();
		const { allPlugins, tags, config } = makeTranslator();
		t.setPluginTags(tags, "v7");

		const res = await t.aiSearch("同步", allPlugins, config, false, () => {});
		expect(res.rankedIds.sort()).toEqual(["kanban", "sync", "theme"]);
		rankSpy.mockRestore();
	});

	it("传 filterCategories 时，向量召回 query 被注入分类强锚", async () => {
		vi.spyOn(AISearcher.prototype as any, "rankTop").mockImplementation(
			async (_q: string, merged: any[]) => ({ rankedIds: merged.map((c) => c.id) })
		);
		const buildSpy = vi
			.spyOn(embedding, "buildVectorIndex")
			.mockImplementation(async (_p, plugins, model, _prev, _ver) => ({
				ids: plugins.map((x) => x.id),
				vectors: plugins.map(() => [0, 0, 0]),
				hash: "h",
				model,
				categorySchemaVersion: _ver,
			}));
		const recallSpy = vi
			.spyOn(embedding, "vectorRecallScores")
			.mockImplementation(async () => new Map([["sync", 0.9]]));

		const t = new Translator();
		const { allPlugins, tags, config } = makeTranslator();
		t.setPluginTags(tags, "v7");

		await t.aiSearch("同步", allPlugins, config, false, () => {}, ["同步与备份"]);

		expect(buildSpy).toHaveBeenCalled();
		expect(recallSpy).toHaveBeenCalled();
		// vectorRecall 的第 2 个参数是 query
		const usedQuery = recallSpy.mock.calls[0][1] as string;
		expect(usedQuery).toContain("分类：同步与备份");
		expect(usedQuery).toContain("同步");
		buildSpy.mockRestore();
		recallSpy.mockRestore();
	});

	it("不传 filterCategories 时，向量召回 query 不含分类强锚", async () => {
		vi.spyOn(AISearcher.prototype as any, "rankTop").mockImplementation(
			async (_q: string, merged: any[]) => ({ rankedIds: merged.map((c) => c.id) })
		);
		vi.spyOn(embedding, "buildVectorIndex").mockImplementation(
			async (_p, plugins, model, _prev, _ver) => ({
				ids: plugins.map((x) => x.id),
				vectors: plugins.map(() => [0, 0, 0]),
				hash: "h",
				model,
				categorySchemaVersion: _ver,
			})
		);
		const recallSpy = vi
			.spyOn(embedding, "vectorRecallScores")
			.mockImplementation(async () => new Map([["sync", 0.9]]));

		const t = new Translator();
		const { allPlugins, tags, config } = makeTranslator();
		t.setPluginTags(tags, "v7");

		await t.aiSearch("同步", allPlugins, config, false, () => {});

		const usedQuery = recallSpy.mock.calls[0][1] as string;
		expect(usedQuery).not.toContain("分类：");
		expect(usedQuery).toBe("同步");
		recallSpy.mockRestore();
	});
});

/**
 * AI 翻译（聚焦 AI 战略）在翻译管线中的回归测试：
 *   1. 配置了 AI（apiKey）时，translateSubset 优先用 LLM 翻译，产出 source="ai"；
 *   2. AI 调用失败时静默降级到 MyMemory（source="online"）；
 *   3. 未配置 apiKey 时跳过 AI（callLLM 不被调用），走原机翻路径（零回归）；
 *   4. AI 返回空 name 时视为失败并降级。
 */
describe("Translator · AI 翻译管线", () => {
	const plugin = { id: "mindmap", name: "Mind Map", description: "draw mind maps", author: "a" };

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("配置 AI 时优先用 LLM 翻译，产出 source=ai", async () => {
		vi.spyOn(translateApi, "callAITranslate").mockResolvedValue(
			{ translatedName: "思维导图", translatedDesc: "绘制思维导图", source: "ai" } as TranslateResult
		);
		const t = new Translator();
		t.setUseMyMemory(false);
		t.setAIConfig({ baseURL: "http://x", apiKey: "k", model: "m" });

		let got: TranslateResult | undefined;
		await t.translateSubset([plugin], (_id, r) => { got = r; });

		expect(got?.source).toBe("ai");
		expect(got?.translatedName).toBe("思维导图");
		expect(got?.translatedDesc).toBe("绘制思维导图");
	});

	it("AI 调用失败时降级到 MyMemory（source=online）", async () => {
		vi.spyOn(LLMClient.prototype, "call").mockRejectedValue(new Error("AI down"));
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockImplementation(
			async (text: string) => ({ text: `机翻:${text}`, unchanged: false })
		);
		const t = new Translator();
		t.setUseMyMemory(true);
		t.setAIConfig({ baseURL: "http://x", apiKey: "k", model: "m" });

		let got: TranslateResult | undefined;
		await t.translateSubset([plugin], (_id, r) => { got = r; });

		expect(got?.source).toBe("online");
		expect(got?.translatedName).toBe(`机翻:${plugin.name}`);
	});

	it("未配置 apiKey 时跳过 AI（callAITranslate 不被调用），走机翻", async () => {
		const llmSpy = vi.spyOn(translateApi, "callAITranslate").mockResolvedValue({ translatedName: "x" } as TranslateResult);
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockImplementation(
			async (text: string) => ({ text: `机翻:${text}`, unchanged: false })
		);
		const t = new Translator();
		t.setUseMyMemory(true);
		t.setAIConfig(null); // 未配置 AI

		let got: TranslateResult | undefined;
		await t.translateSubset([plugin], (_id, r) => { got = r; });

		expect(llmSpy).not.toHaveBeenCalled();
		expect(got?.source).toBe("online");
	});

	it("AI 返回空 name 时视为失败并降级", async () => {
		vi.spyOn(translateApi, "callAITranslate").mockResolvedValue(null);
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockImplementation(
			async (text: string) => ({ text: `机翻:${text}`, unchanged: false })
		);
		const t = new Translator();
		t.setUseMyMemory(true);
		t.setAIConfig({ baseURL: "http://x", apiKey: "k", model: "m" });

		let got: TranslateResult | undefined;
		await t.translateSubset([plugin], (_id, r) => { got = r; });

		expect(got?.source).toBe("online");
	});

	it("T1(#1): 腾讯熔断开路时 translateSubset 跳过腾讯翻译（不白烧请求、不抛错）", async () => {
		const t = new Translator();
		t.setApiConfig({ secretId: "id", secretKey: "key" }); // 配了密钥
		t.setAIConfig(null); // 不走 AI
		t.setUseMyMemory(true);
		// MyMemory 无结果；腾讯开路
		vi.spyOn(t.myMemory, "translate").mockResolvedValue(null);
		const tencentTranslate = vi
			.spyOn(t.tencentClient, "translate")
			.mockImplementation(async () => { throw new Error("腾讯不应被调用"); });
		vi.spyOn(t.tencentClient, "isAvailable").mockReturnValue(false);

		await t.translateSubset([plugin], () => {});

		// 熔断跳过腾讯 → 不应发起翻译请求
		expect(tencentTranslate).not.toHaveBeenCalled();
		// 无 AI / MyMemory / 腾讯命中 → 兜底 original（而非 online/tencent）
		expect(t.cache[plugin.id].source).toBe("original");
	});

	it("T1(#1): 腾讯熔断可用时 translateSubset 仍正常走腾讯翻译", async () => {
		const t = new Translator();
		t.setApiConfig({ secretId: "id", secretKey: "key" });
		t.setAIConfig(null);
		t.setUseMyMemory(true);
		vi.spyOn(t.myMemory, "translate").mockResolvedValue(null);
		vi.spyOn(t.tencentClient, "translate").mockResolvedValue(["腾讯译", "腾讯描"] as any);
		vi.spyOn(t.tencentClient, "isAvailable").mockReturnValue(true);

		await t.translateSubset([plugin], () => {});

		expect(t.cache[plugin.id].source).toBe("online");
		expect(t.cache[plugin.id].provider).toBe("tencent");
	});
});

/**
 * MyMemory 限流降级（按天持久化）回归测试：
 *   1. 命中 429 后标记限流，本次会话内跳过后续 MyMemory 调用（不重复发请求）；
 *   2. 普通网络错误不触发限流，仍逐条重试；
 *   3. translateSubset 被限流后，未译插件降级到 original，且只告警一次（不刷屏）；
 *   4. loadData 传入今天日期则恢复限流；传入过往日期则跨天自动恢复；
 *   5. 限流标记随 getData 持久化，并经 loadData 跨会话保持（同日）。
 */
describe("Translator · MyMemory 限流降级（按天持久化）", () => {
	const plugin = { id: "gemini-helper", name: "Gemini Helper", description: "help with gemini", author: "a" };

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("命中 429 后标记限流，本次会话内跳过后续 MyMemory 调用", async () => {
		const myMemSpy = vi
			.spyOn(MyMemoryClient.prototype as any, "callApi")
			.mockRejectedValue(new Error("MyMemory API 错误: 429 Too Many Requests"));
		const t = new Translator();
		t.setUseMyMemory(true);
		t.setAIConfig(null);

		const first = await t.myMemory.translate(plugin);
		expect(first).toBeNull();
		expect(t.myMemory.isBlocked()).toBe(true);

		const second = await t.myMemory.translate(plugin);
		expect(second).toBeNull();
		// 仅首次的 name+desc 两次调用，第二次被跳过
		expect(myMemSpy).toHaveBeenCalledTimes(2);
	});

	it("普通网络错误不触发限流标记，仍逐条尝试", async () => {
		const myMemSpy = vi
			.spyOn(MyMemoryClient.prototype as any, "callApi")
			.mockRejectedValue(new Error("network timeout"));
		const t = new Translator();
		t.setUseMyMemory(true);
		t.setAIConfig(null);

		const first = await t.myMemory.translate(plugin);
		expect(first).toBeNull();
		expect(t.myMemory.isBlocked()).toBe(false);
		await t.myMemory.translate(plugin);
		// 每次都重试（2 字段 × 2 次 = 4 次）
		expect(myMemSpy).toHaveBeenCalledTimes(4);
	});

	it("translateSubset 被限流后降级到 original，且只告警一次（不刷屏）", async () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockRejectedValue(
			new Error("MyMemory API 错误: 429")
		);
		const t = new Translator();
		t.setUseMyMemory(true);
		t.setAIConfig(null);

		const plugins = [
			{ id: "a", name: "Alpha", description: "first", author: "x" },
			{ id: "b", name: "Beta", description: "second", author: "y" },
		];
		await t.translateSubset(plugins, () => {});

		// 仅一次「额度已耗尽」告警
		const blockWarns = warnSpy.mock.calls.filter((c) => String(c[0]).includes("额度已耗尽"));
		expect(blockWarns.length).toBe(1);
		// 未译插件落入 original 兜底
		expect(t.getData().cache["a"]?.source).toBe("original");
		expect(t.getData().cache["b"]?.source).toBe("original");
	});

	it("loadData 传入今天日期则恢复限流；传入过往日期则跨天自动恢复", () => {
		// 与 api.ts 的 todayStr() 保持一致：用本地日期而非 UTC，否则在负时区跨 UTC 零点时
		// 测试计算出的「今天」(UTC) 与生产代码的「今天」(本地) 错位，导致 flaky。
		const d = new Date();
		const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
		const t1 = new Translator();
		t1.loadData({ myMemoryBlockedDate: today });
		expect(t1.myMemory.isBlocked()).toBe(true);

		const t2 = new Translator();
		t2.loadData({ myMemoryBlockedDate: "2000-01-01" });
		expect(t2.myMemory.isBlocked()).toBe(false);
		expect(t2.myMemory.getBlockedDate()).toBeNull();
	});

	it("限流标记随 getData 持久化，并经 loadData 跨会话保持（同日）", async () => {
		const t = new Translator();
		t.setUseMyMemory(true);
		t.setAIConfig(null);
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockRejectedValue(
			new Error("MyMemory API 错误: 429")
		);
		await t.myMemory.translate({ id: "x", name: "X", description: "d", author: "a" });

		const persisted = t.getData().myMemoryBlockedDate;
		expect(typeof persisted).toBe("string");
		// 重新加载（同日）→ 仍被限流
		const t2 = new Translator();
		t2.loadData({ myMemoryBlockedDate: persisted });
		expect(t2.myMemory.isBlocked()).toBe(true);
	});
});

/**
 * mergeOffline：离线合并管线（零网络、纯同步）回归测试。
 * 核心语义：cache → tmApproved → aiDict → original 遮罩，优先级严格递减。
 */
describe("Translator · mergeOffline 离线合并管线", () => {
	const plugins = [
		{ id: "a", name: "Plugin A", description: "desc A", author: "x" },
		{ id: "b", name: "Plugin B", description: "desc B", author: "x" },
		{ id: "c", name: "Plugin C", description: "desc C", author: "x" },
		{ id: "d", name: "Plugin D", description: "desc D", author: "x" },
	];

	it("cache 优先于 tmApproved / aiDict", () => {
		const t = new Translator();
		t.loadData({ cache: { a: { translatedName: "缓存A", translatedDesc: "缓存desc", source: "online" } } });
		t.aiDict["a"] = { name: "固化A", description: "固化desc", source: "ai" };

		const { results, pending } = t.mergeOffline(plugins);
		expect(results.a.source).toBe("online");
		expect(results.a.translatedName).toBe("缓存A");
		expect(pending.find((p) => p.id === "a")).toBeUndefined(); // 源非 original，不待翻译
	});

	it("cache 中 original 且译名==原名 → 仍进入 pending 以待联网重试", () => {
		const t = new Translator();
		t.loadData({ cache: { a: { translatedName: "Plugin A", translatedDesc: "desc A", source: "original" } } });

		const { results, pending } = t.mergeOffline(plugins);
		expect(results.a.source).toBe("original");
		expect(pending.map((p) => p.id)).toContain("a");
	});

	it("cache 脏数据清洗：source=original 但译名≠原名 → 提升为 bulk，不计入 pending", () => {
		const t = new Translator();
		// 模拟历史遗留脏数据：有中文译名却被错误标记为 original
		t.loadData({ cache: { a: { translatedName: "插件A", translatedDesc: "描述A", source: "original" } } });

		const { results, pending } = t.mergeOffline(plugins);
		expect(results.a.source).toBe("bulk"); // 被清洗提升
		expect(results.a.translatedName).toBe("插件A");
		expect(pending.map((p) => p.id)).not.toContain("a"); // 不再待翻译
		// cache 也被就地修正
		expect(t.cache["a"].source).toBe("bulk");
	});

	it("tmApproved(human) 优先级高于 aiDict", () => {
		const t = new Translator();
		t.tmApproved["a"] = {
			id: "a", name: "人工校正名", description: "人工描述",
			source: "human", status: "approved", confidence: 1, created: 0, promoted: 0,
		};
		t.aiDict["a"] = { name: "固化词典名", description: "固化词典描述", source: "ai" };

		const { results } = t.mergeOffline(plugins);
		expect(results.a.translatedName).toBe("人工校正名");
	});

	it("tmApproved name/desc 为空的回退到 plugin 原名（不产生空字符串）", () => {
		const t = new Translator();
		t.tmApproved["a"] = {
			id: "a", name: "", description: "",
			source: "human", status: "approved", confidence: 1, created: 0, promoted: 0,
		};
		const { results } = t.mergeOffline(plugins);
		expect(results.a.translatedName).toBe("Plugin A"); // fallback
	});

	it("aiDict 固化资产命中 source=ai", () => {
		const t = new Translator();
		t.aiDict["c"] = { name: "插件C", description: "描述C", source: "ai" };
		const { results } = t.mergeOffline(plugins);
		expect(results.c.source).toBe("ai");
		expect(results.c.translatedName).toBe("插件C");
	});

	it("全未命中 → 全部 source=original + 全部进入 pending", () => {
		const t = new Translator();
		const { results, pending } = t.mergeOffline(plugins);
		for (const p of plugins) {
			expect(results[p.id].source).toBe("original");
			expect(results[p.id].translatedName).toBe(p.name);
			expect(pending.map((x) => x.id)).toContain(p.id);
		}
		// cache 不应写入 original（避免阻断后续真正翻译）
		expect(Object.keys(t.getData().cache ?? {})).toHaveLength(0);
	});

	it("混合命中：cache/tmApproved/aiDict/original 三种源共存，pending 不含已译项", () => {
		const t = new Translator();
		t.loadData({
			cache: { a: { translatedName: "缓存A", translatedDesc: "d", source: "online" } },
		});
		t.tmApproved["b"] = {
			id: "b", name: "人工B", description: "d",
			source: "human", status: "approved", confidence: 1, created: 0, promoted: 0,
		};
		t.aiDict["c"] = { name: "固化C", description: "d", source: "ai" };

		const { results, pending } = t.mergeOffline(plugins);
		expect(results.a.source).toBe("online");
		expect(results.b.translatedName).toBe("人工B");
		expect(results.c.source).toBe("ai");
		expect(results.d.source).toBe("original");

		// pending 仅含 source=original 的项（d）和 cache 中 original 的项
		const pendingIds = pending.map((p) => p.id);
		expect(pendingIds).not.toContain("a");
		expect(pendingIds).not.toContain("b");
		expect(pendingIds).not.toContain("c");
		expect(pendingIds).toContain("d");
	});
});

/**
 * persistSystemTranslation：按需系统翻译（macOS 快捷指令）的落库沉淀。
 * 语义：写入 cache（本会话复用）+ tmApproved 可信层（跨会话/随 Sync），
 * 且不覆盖已存在的人工校正（human）。
 */
describe("Translator · persistSystemTranslation 落库沉淀", () => {
	it("写入 cache 与 tmApproved，provider 标记 macos", () => {
		const t = new Translator();
		expect(t.persistSystemTranslation("a", "中文名", "中文描述")).toBe(true);
		// cache 层
		expect(t.cache["a"]).toEqual({
			translatedName: "中文名",
			translatedDesc: "中文描述",
			source: "online",
			provider: "macos",
		});
		// tmApproved 可信层
		expect(t.tmApproved["a"]).toMatchObject({
			id: "a",
			name: "中文名",
			description: "中文描述",
			status: "approved",
			source: "online",
		});
	});

	it("持久化后可跨会话经 lookupTMApproved 复用", () => {
		const t = new Translator();
		t.persistSystemTranslation("a", "中文名", "中文描述");
		const hit = t.lookupTMApproved("a", "Plugin A", "desc A");
		expect(hit?.translatedName).toBe("中文名");
		expect(hit?.translatedDesc).toBe("中文描述");
	});

	it("不覆盖已存在的人工校正（human）", () => {
		const t = new Translator();
		t.tmApproved["a"] = {
			id: "a", name: "人工校正", description: "人工描述",
			source: "human", status: "approved", confidence: 1, created: 0, promoted: 0,
		};
		expect(t.persistSystemTranslation("a", "系统翻译名", "系统翻译描述")).toBe(false);
		expect(t.tmApproved["a"].name).toBe("人工校正");
	});

	it("标记脏：待 flushTMVault 写盘", () => {
		const t = new Translator();
		t.persistSystemTranslation("a", "名", "描述");
		expect(t.peekTMDirty()).toContain("a");
	});

	it("再点击：覆盖已有非 human 的 approved 条目（更新译文，不再保留 flagged）", () => {
		const t = new Translator();
		// 第一次落库
		t.persistSystemTranslation("a", "旧译文名", "旧译文描述");
		const oldPromoted = t.tmApproved["a"].promoted ?? 0;
		// 第二次落库（用户再次点击系统翻译）
		t.persistSystemTranslation("a", "新译文名", "新译文描述");
		expect(t.tmApproved["a"].name).toBe("新译文名");
		expect(t.tmApproved["a"].description).toBe("新译文描述");
		expect(t.tmApproved["a"].flagged).toBeFalsy();
		expect(t.tmApproved["a"].promoted ?? 0).toBeGreaterThanOrEqual(oldPromoted);
		// cache 同步更新为最新译文
		expect(t.cache["a"]?.translatedName).toBe("新译文名");
	});
});

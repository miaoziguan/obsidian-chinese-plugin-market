import { describe, it, expect, beforeEach, vi } from "vitest";
import { Translator, type PluginInfo, type TranslateResult } from "@domain/catalog/translator";
import { MyMemoryClient, callAITranslate } from "@translation/api/api";

/**
 * 懒翻译（产品改进 #9）单测：
 *  - mergeOffline：同步合并离线命中（tmApproved/aiDict/cache），未命中给 original 兜底并计入 pending。
 *  - translateSubset：只翻指定子集，逐个 onOne 回调，写缓存。
 */
describe("Translator.mergeOffline", () => {
	let t: Translator;
	const plugins: PluginInfo[] = [
		{ id: "p1", name: "Calendar", description: "A calendar", author: "a" },
		{ id: "p2", name: "Sync", description: "Sync notes", author: "b" },
		{ id: "p3", name: "Kanban", description: "Board view", author: "c" },
	];

	beforeEach(() => {
		t = new Translator();
		t.setUseMyMemory(false); // 禁止任何网络
	});

	it("aiDict 固化资产命中直接采用，不计入 pending", () => {
		t.aiDict["p1"] = { name: "日历", description: "一个日历", source: "ai" };
		const { results, pending } = t.mergeOffline(plugins);
		expect(results.p1.source).toBe("ai");
		expect(results.p1.translatedName).toBe("日历");
		// p2/p3 未命中 → original 兜底 + pending
		expect(results.p2.source).toBe("original");
		expect(pending.map((p) => p.id).sort()).toEqual(["p2", "p3"]);
	});

	it("tmApproved 优先，命中不计入 pending", () => {
		t.tmApproved["p2"] = {
			id: "p2", name: "同步", description: "同步笔记",
			source: "human", status: "approved", confidence: 1, created: 0, promoted: 0,
		};
		const { results, pending } = t.mergeOffline(plugins);
		expect(results.p2.translatedName).toBe("同步");
		expect(pending.some((p) => p.id === "p2")).toBe(false);
	});

	it("cache 命中直接采用；缓存里的 original 仍计入 pending（待重试）", () => {
		t.loadData({
			cache: {
				p1: { translatedName: "日历", translatedDesc: "x", source: "ai" },
				p2: { translatedName: "Sync", translatedDesc: "Sync notes", source: "original" },
			},
		});
		const { results, pending } = t.mergeOffline(plugins);
		expect(results.p1.source).toBe("ai");
		expect(pending.map((p) => p.id).sort()).toEqual(["p2", "p3"]);
	});

	it("全部未命中：results 全 original，pending 全量", () => {
		const { results, pending } = t.mergeOffline(plugins);
		expect(Object.values(results).every((r) => r.source === "original")).toBe(true);
		expect(pending.length).toBe(3);
	});

	it("original 兜底不写入 cache（不阻断后续真正翻译）", () => {
		t.mergeOffline(plugins);
		// cache 里不应出现 original 兜底项
		expect(t.getData().cache.p1).toBeUndefined();
	});
});

describe("Translator.translateSubset", () => {
	let t: Translator;
	const plugins: PluginInfo[] = [
		{ id: "p1", name: "Calendar", description: "A calendar", author: "a" },
		{ id: "p2", name: "Sync", description: "Sync notes", author: "b" },
	];

	beforeEach(() => {
		t = new Translator();
		t.setUseMyMemory(false);
	});

	it("无翻译能力时全部落到 original，onOne 仍回调，写入 cache", async () => {
		const seen: Record<string, TranslateResult> = {};
		await t.translateSubset(plugins, (id, r) => {
			seen[id] = r;
		});
		expect(Object.keys(seen).sort()).toEqual(["p1", "p2"]);
		expect(seen.p1.source).toBe("original");
		// 已写入缓存
		expect(t.getData().cache.p1.source).toBe("original");
	});

	it("成功翻译时 onOne 回调 source=online，并写缓存", async () => {
		t.setUseMyMemory(true);
		// mock 私有 callApi，避免真实网络
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockImplementation(
			async (s: string) => `译:${s}`
		);
		const seen: Record<string, TranslateResult> = {};
		await t.translateSubset(plugins, (id, r) => {
			seen[id] = r;
		});
		expect(seen.p1.source).toBe("online");
		expect(seen.p1.translatedName).toBe("译:Calendar");
		expect(t.getData().cache.p2.translatedDesc).toBe("译:Sync notes");
	});

	it("机翻（online）译文自动直接落库为 approved", async () => {
		t.setUseMyMemory(true);
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockImplementation(
			async (s: string) => `译:${s}`
		);
		const seen: Record<string, TranslateResult> = {};
		await t.translateSubset(plugins, (id, r) => {
			seen[id] = r;
		});
		// online 译文应自动落库为 approved（无待审队列）
		expect(seen.p1.source).toBe("online");
		expect(t.isTMApproved("p1")).toBe(true);
		expect(t.tmApproved["p1"].status).toBe("approved");
	});

	it("skipAI 时懒翻译不调用 AI（本地语义模式），走其它兜底", async () => {
		const aiSpy = vi.spyOn({ callAITranslate }, "callAITranslate").mockResolvedValue({
			translatedName: "AI名",
			translatedDesc: "AI描",
			source: "ai",
		});
		try {
			t.setAIConfig({ baseURL: "http://x", apiKey: "k", model: "m" });
			t.setUseMyMemory(false);
			const seen: Record<string, TranslateResult> = {};
			await t.translateSubset(
				plugins,
				(id, r) => {
					seen[id] = r;
				},
				{ skipAI: true }
			);
			// skipAI：AI 翻译未被调用（即使配了 apiKey）
			expect(aiSpy).not.toHaveBeenCalled();
			// 无 MyMemory/腾讯 → 落到 original
			expect(seen.p1.source).toBe("original");
		} finally {
			aiSpy.mockRestore();
		}
	});

	it("跳过已翻译（非 original）的缓存项", async () => {
		t.loadData({
			cache: { p1: { translatedName: "日历", translatedDesc: "x", source: "ai" } },
		});
		t.setUseMyMemory(true);
		let calls = 0;
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockImplementation(
			async (s: string) => {
				calls++;
				return `译:${s}`;
			}
		);
		const seen: string[] = [];
		await t.translateSubset(plugins, (id) => seen.push(id));
		// 只翻 p2（p1 已翻译命中，被跳过）
		expect(seen).toEqual(["p2"]);
		expect(calls).toBe(2); // p2 的 name + desc
	});

	it("空列表安全返回", async () => {
		await expect(t.translateSubset([])).resolves.toBeUndefined();
	});

	it("M1 回归：固化资产（aiDict）晚于 mergeOffline 到位时，translateSubset 命中离线层（不烧在线翻译）", async () => {
		// 模拟真实时序：mergeOffline 时资产未加载 → p1 进入 pending
		const { pending } = t.mergeOffline(plugins);
		expect(pending.some((p) => p.id === "p1")).toBe(true);

		// 固化资产异步到位（原批量词典已沉淀为 vault 笔记，扫描重建后注入 aiDict/tmApproved）
		t.aiDict["p1"] = { name: "日历", description: "一个日历", source: "ai" };

		// 打开在线翻译并埋雷：若走到 MyMemory 即视为烧了不该烧的请求
		t.setUseMyMemory(true);
		let onlineCalls = 0;
		vi.spyOn(MyMemoryClient.prototype as any, "callApi").mockImplementation(
			async (s: string) => {
				onlineCalls++;
				return `译:${s}`;
			}
		);

		const seen: Record<string, TranslateResult> = {};
		await t.translateSubset([plugins[0]], (id, r) => {
			seen[id] = r;
		});
		expect(seen.p1.source).toBe("ai");
		expect(seen.p1.translatedName).toBe("日历");
		expect(onlineCalls).toBe(0);
	});
});

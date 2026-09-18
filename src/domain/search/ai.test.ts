import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { setHttpClient, resetHttpClient } from "@data/net/http-port";
import { AISearcher } from "@domain/search/ai";
import { BM25_TOKENIZER_VERSION } from "@domain/search/bm25";
import { LLMClient } from "@translation/api/api";
import { PluginTagService } from "@domain/catalog/plugin-tags";

// 依赖倒置后：LLM 调用统一走注入的 HttpClient，直接注入 mock 模拟不可达/异常响应
const req = vi.fn();

const PLUGINS = [
	{ id: "dataview", name: "Dataview", description: "Query your notes as a database" },
	{ id: "calendar", name: "Calendar", description: "Track your daily notes" },
	{ id: "git", name: "Git", description: "Version control for your vault" },
	{ id: "translate", name: "Translate", description: "Translate text in notes" },
];

function makeSearcher() {
	const tagService = new PluginTagService();
	tagService.load({
		dataview: { category: "data", tags: ["query"] },
		calendar: { category: "productivity", tags: ["time"] },
		git: { category: "dev", tags: ["vcs"] },
		translate: { category: "tool", tags: ["language"] },
	});
	const llm = new LLMClient({
		baseURL: "https://api.example.com",
		apiKey: "sk-test",
		model: "test-model",
	});
	const aiConfig = {
		baseURL: "https://api.example.com",
		apiKey: "sk-test",
		model: "test-model",
		embedding: { source: "keyword" as const },
	};
	const searcher = new AISearcher(aiConfig, llm, tagService);
	return { searcher, llm };
}

describe("AISearcher 降级健壮性", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("LLM 精排不可达时降级到本地关键词排序（rankFallback=true，结果非空）", async () => {
		const { searcher } = makeSearcher();
		// 让所有 requestUrl 立即 reject → 模拟 LLM 端点不可达
		req.mockRejectedValue(new Error("request failed"));

		const result = await searcher.search("query notes database", PLUGINS as any);

		expect(result.rankFallback).toBe(true);
		expect(result.rankedIds.length).toBeGreaterThan(0);
		// 降级结果应是本地召回顺序（含 query 相关项）
		expect(result.rankedIds).toContain("dataview");
	});

	it("LLM 可用时正常语义精排（rankFallback 为 falsy）", async () => {
		const { searcher } = makeSearcher();
		// 让 LLM 返回合法 OpenAI 格式响应（content 内为 ranking JSON 字符串）
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 1, 2, 3],
								reasons: { dataview: "强相关" },
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any);

		expect(result.rankFallback).toBeFalsy();
		expect(result.rankedIds.length).toBeGreaterThan(0);
	});

	it("localSearch 纯本地 RRF 融合，不调 LLM（requestUrl 未被用于 LLM）", async () => {
		const { searcher } = makeSearcher();
		// 若 localSearch 误调 LLM，会命中 requestUrl → reject → 抛出；这里若调了即失败
		req.mockRejectedValue(new Error("localSearch 不应调用 LLM/网络"));

		const result = await searcher.localSearch("query notes database", PLUGINS as any);

		expect(result.rankFallback).toBe(true);
		expect(result.rankedIds.length).toBeGreaterThan(0);
		// 关键词召回应命中 dataview（"database" 命中描述）
		expect(result.rankedIds).toContain("dataview");
	});

	it("LLM 只返回部分 ranking 时，未排序候选兜底补回，结果不缺失", async () => {
		const { searcher } = makeSearcher();
		// 注意：query "query notes" 经本地召回（BM25 + 标题模糊）后候选池只有 3 个
		// （dataview/calendar/translate，git 未命中关键词不在池中）。
		// rankSubset 顺序 = [dataview(0), calendar(1), translate(2)]。
		// LLM 仅返回 ranking=[0, 2]（dataview, translate），未排序的 calendar(1) 应被兜底补回末尾。
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 2],
								reasons: { dataview: "强相关", translate: "相关" },
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any);

		// 候选池中的 3 个都应出现在结果中：LLM 返回 ranking=[0,2]（排了 2 个），
		// 未排序的第 3 个候选被兜底补回，不缺失。
		// 注意：Array.sort() 原地排序，下面用副本比较，避免污染后续断言。
		expect([...result.rankedIds].sort()).toEqual(["calendar", "dataview", "translate"]);
		// ranking=[0,2] 覆盖了 rankSubset 的第 0、2 位，未覆盖的第 1 位（dataview）被补到末尾
		expect(result.rankedIds[result.rankedIds.length - 1]).toBe("dataview");
	});

	it("reasons 仅保留进入结果的候选，排除被 irrelevant 过滤掉的", async () => {
		const { searcher } = makeSearcher();
		req.mockResolvedValue({
			status: 200,
			json: {
				choices: [
					{
						message: {
							content: JSON.stringify({
								ranking: [0, 1, 2, 3],
								// git 被标为无关（应被过滤），其理由不应出现在结果 reasons
								reasons: {
									dataview: "强相关",
									calendar: "相关",
									git: "无关：不相关",
									translate: "相关",
								},
							}),
						},
					},
				],
			},
		});

		const result = await searcher.search("query notes", PLUGINS as any, true);

		expect(result.rankedIds).not.toContain("git");
		// reasons 不应包含被 irrelevant 排除的 git
		expect(result.reasons).toBeDefined();
		expect(Object.keys(result.reasons!)).not.toContain("git");
		expect(Object.keys(result.reasons!)).toEqual(["dataview", "calendar", "translate"]);
	});
});

describe("BM25 标题场加权（双场索引）", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("同一查询词：标题命中排在仅正文命中之前（TITLE_W=2.0 生效）", async () => {
		const { searcher } = makeSearcher();
		const plugins = [
			{ id: "body-hit", name: "Note Helper", description: "Create mindmap diagrams easily" },
			{ id: "title-hit", name: "Mindmap Tools", description: "Drawing utilities for visual thinking" },
		];
		const r = await searcher.localSearch("mindmap", plugins as any);
		expect(r.rankedIds[0]).toBe("title-hit");
		expect(r.rankedIds).toContain("body-hit");
	});

	it("标题场含中文名、正文场含中文描述（译文进关键词路）", () => {
		const { searcher } = makeSearcher();
		const plugins = [
			{
				id: "minidoro",
				name: "Minidoro",
				description: "Pomodoro timer widget",
				nameZh: "迷你番茄钟",
				descZh: "番茄工作法计时器",
			},
			{ id: "other", name: "Other", description: "Unrelated tool" },
		];
		const idx = searcher.getBm25Index(plugins as any);
		const doc = idx.docTokensById.get("minidoro");
		// 标题场 = name + nameZh 的 trigram，应含"番茄钟"
		expect(doc?.title).toContain("番茄钟");
		// 正文场 = description + descZh 的 trigram，应含"番茄工"与英文 token
		expect(doc?.body).toContain("番茄工");
		expect(doc?.body).toContain("pomodoro");
		// 双场各自统计 df
		expect(idx.dfTitle.get("番茄钟")).toBe(1);
		expect(idx.dfBody.get("番茄钟")).toBeUndefined();
	});

	it("中文 query 经关键词路直接命中中文名（无向量、无 LLM）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("localSearch 不应调用网络"));
		const plugins = [
			{
				id: "minidoro",
				name: "Minidoro",
				description: "Pomodoro timer widget",
				nameZh: "迷你番茄钟",
				descZh: "番茄工作法计时器",
			},
			{ id: "kanban", name: "Kanban", description: "Kanban board for notes", nameZh: "看板", descZh: "笔记看板" },
		];
		const r = await searcher.localSearch("番茄钟", plugins as any);
		expect(r.rankedIds[0]).toBe("minidoro");
		expect(r.rankedIds).not.toContain("kanban");
	});

	it("译文到达后 BM25 索引签名失效重建（缓存失效坑回归，P-0055 同族）", () => {
		const { searcher } = makeSearcher();
		const base = [
			{ id: "a", name: "A", description: "aaa" },
			{ id: "b", name: "B", description: "bbb" },
		];
		const idx1 = searcher.getBm25Index(base as any);
		// 同列表（长度+首尾 id+译文指纹全同）→ 复用同一对象
		expect(searcher.getBm25Index(base as any)).toBe(idx1);
		// 长度与首尾 id 不变、仅译文补齐 → 签名必须变化并重建
		const withZh = [
			{ ...base[0], nameZh: "甲" },
			{ ...base[1], descZh: "乙乙乙" },
		];
		const idx2 = searcher.getBm25Index(withZh as any);
		expect(idx2).not.toBe(idx1);
		expect(idx2.docTokensById.get("a")?.title).toContain("甲");
	});
});

describe("质量因子集成（补丁 B：recency×popularity）", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	/** 同文本双插件：BM25/标题模糊分完全一致，RRF 平局按插入序 stale 在前——
	 *  若 fresh 最终排第一，只能是质量因子翻的盘（确定性归因）。 */
	function twinPlugins(now: number) {
		const DAY = 86400000;
		return [
			{ id: "stale", name: "Note Track", description: "Track your notes", downloads: 100, updated: now - 1500 * DAY },
			{ id: "fresh", name: "Note Track", description: "Track your notes", downloads: 2_000_000, updated: now - 3 * DAY },
		];
	}

	it("localSearch：相关度平局时，新而热的排前（质量因子翻越 RRF 平局序）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("localSearch 不应调用网络"));
		const result = await searcher.localSearch("track notes", twinPlugins(Date.now()) as any);
		expect(result.rankedIds[0]).toBe("fresh");
		expect(result.rankedIds).toEqual(["fresh", "stale"]);
	});

	it("localSearch：全部无 stats 数据 → 因子中性，平局保持原 RRF 序（无副作用回归）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("localSearch 不应调用网络"));
		const plugins = [
			{ id: "first", name: "Note Track", description: "Track your notes" },
			{ id: "second", name: "Note Track", description: "Track your notes" },
		];
		const result = await searcher.localSearch("track notes", plugins as any);
		expect(result.rankedIds).toEqual(["first", "second"]);
	});

	it("search() 降级路径（LLM 不可达）：候选序同样经过质量因子", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("request failed"));
		const result = await searcher.search("track notes", twinPlugins(Date.now()) as any);
		expect(result.rankFallback).toBe(true);
		expect(result.rankedIds[0]).toBe("fresh");
	});
});

describe("bigram 盲区回归（④ harness 胜出臂采纳）", () => {
	beforeEach(() => {
		req.mockReset();
		setHttpClient({ request: req });
	});
	afterEach(() => {
		resetHttpClient();
	});

	it("2 字 query 命中正文长 run（旧纯 trigram 该 query 关键词路恒漏）", async () => {
		const { searcher } = makeSearcher();
		req.mockRejectedValue(new Error("不应调用网络"));
		const plugins = [
			{ id: "door", name: "DoorMaster", description: "门禁系统管理工具" },
			{ id: "other", name: "Other", description: "完全不相关的内容" },
		];
		const r = await searcher.localSearch("门禁", plugins as any);
		expect(r.rankedIds).toContain("door");
		expect(r.rankedIds).not.toContain("other");
	});

	it("bm25IndexSig 含分词器版本指纹（分词策略变更必须失效缓存，P-0055 同族）", () => {
		const { searcher } = makeSearcher();
		const idx = searcher.getBm25Index([{ id: "a", name: "A", description: "aaa" }] as any);
		expect(idx.sig.startsWith(BM25_TOKENIZER_VERSION + ":")).toBe(true);
	});
});

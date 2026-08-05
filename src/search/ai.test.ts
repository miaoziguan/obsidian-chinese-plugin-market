import { describe, it, expect, vi, beforeEach } from "vitest";

// 让源码里的 requestUrl 可控，模拟 LLM 不可达（超时/服务不可用）
vi.mock("obsidian", () => ({
	requestUrl: vi.fn(),
}));

import { requestUrl } from "obsidian";
import { AISearcher } from "./ai";
import { LLMClient } from "../translate/api";
import { PluginTagService } from "../plugin-tags";

const req = requestUrl as unknown as ReturnType<typeof vi.fn>;

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

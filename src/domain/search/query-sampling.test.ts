import { describe, expect, it, vi } from "vitest";
import {
	buildQuerySamplingEvent,
	reportQuerySample,
	type QuerySamplingEvent,
} from "@domain/search/query-sampling";

const result = {
	rankedIds: ["exporter", "notes"],
	rankFallback: true,
	matchDiagnostics: {
		exporter: {
			keywordRank: 1,
			vectorRank: null,
			titleRank: 2,
			keywordScore: 0.8,
			vectorScore: null,
			titleScore: 0.4,
			rrfScore: 0.016,
			rerankScore: 0.0112,
			matchedTerms: ["导出"],
			phraseMatches: [],
			intentMatches: ["格式转换/导入导出"],
			negativeMatches: [],
		},
		notes: {
			keywordRank: null,
			vectorRank: 1,
			titleRank: null,
			keywordScore: null,
			vectorScore: 0.9,
			titleScore: null,
			rrfScore: 0.016,
			rerankScore: 0.016,
			matchedTerms: [],
			phraseMatches: [],
			intentMatches: [],
			negativeMatches: ["导出"],
		},
	},
} as any;

describe("query sampling", () => {
	it("只生成查询形状和排序指标，不带原始 query 或插件识别信息", () => {
		const event = buildQuerySamplingEvent({
			query: "不要导出，支持实时预览",
			mode: "local",
			result,
			clientVersion: "2.68.4",
			now: Date.UTC(2026, 9, 8, 12),
		});

		expect(event).toMatchObject({
			type: "query-sample",
			day: "2026-10-08",
			mode: "local",
			clientVersion: "2.68.4",
			query: {
				negativeTermCount: 1,
				activeIntentKeys: ["instant-preview"],
				isPureNegative: false,
			},
			ranking: {
				candidateCount: 2,
				resultCount: 2,
				rankFallback: true,
				negativeHitCountTop10: 1,
			},
		});
		const serialized = JSON.stringify(event);
		expect(serialized).not.toContain("不要导出，支持实时预览");
		expect(serialized).not.toContain("exporter");
		expect(serialized).not.toContain("notes");
		expect(event.ranking.top[0]).toEqual({
			rank: 1,
			keywordHit: true,
			vectorHit: false,
			titleHit: true,
			rrfScore: 0.016,
			rerankScore: 0.0112,
			matchedTermCount: 1,
			phraseMatchCount: 0,
			intentMatchCount: 1,
			negativeMatchCount: 0,
		});
	});

	it("关闭、非法地址或抽样未命中时不发送", async () => {
		const transport = vi.fn(async () => undefined);
		const input = { query: "database", mode: "ai" as const, result };
		expect(await reportQuerySample({ enabled: false, endpoint: "https://collector.test", sampleRate: 1 }, input, transport, () => 0)).toEqual({ sent: false, reason: "disabled" });
		expect(await reportQuerySample({ enabled: true, endpoint: "http://collector.test", sampleRate: 1 }, input, transport, () => 0)).toEqual({ sent: false, reason: "invalid-endpoint" });
		expect(await reportQuerySample({ enabled: true, endpoint: "https://collector.test", sampleRate: 0.1 }, input, transport, () => 0.2)).toEqual({ sent: false, reason: "not-sampled" });
		expect(transport).not.toHaveBeenCalled();
	});

	it("只在命中采样时发送，并吸收接收端失败", async () => {
		const payloads: QuerySamplingEvent[] = [];
		const transport = vi.fn(async (_endpoint: string, payload: QuerySamplingEvent) => {
			payloads.push(payload);
		});
		const input = { query: "实时预览", mode: "ai" as const, result };
		expect(await reportQuerySample({ enabled: true, endpoint: "https://collector.test", sampleRate: 1, }, input, transport, () => 0)).toEqual({ sent: true });
		expect(transport).toHaveBeenCalledWith("https://collector.test", expect.any(Object));
		expect(payloads[0].query.activeIntentKeys).toEqual(["instant-preview"]);

		const failing = vi.fn(async () => { throw new Error("offline"); });
		expect(await reportQuerySample({ enabled: true, endpoint: "https://collector.test", sampleRate: 1 }, input, failing, () => 0)).toEqual({ sent: false, reason: "transport-error" });
	});
});

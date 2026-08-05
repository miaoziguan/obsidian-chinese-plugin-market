import { describe, it, expect } from "vitest";
import { tokenizeForBM25, bm25Score } from "./bm25";
import { t2sForEmbed, hasCJK } from "./t2s";

describe("t2sForEmbed 简繁转换", () => {
	it("繁体转简体", () => {
		expect(t2sForEmbed("繁體字")).toContain("繁体");
		expect(t2sForEmbed("數據庫")).toBe("数据库");
		expect(t2sForEmbed("台灣")).toBe("台湾");
	});
	it("纯 ASCII 原样通过", () => {
		expect(t2sForEmbed("Notion 2024")).toBe("Notion 2024");
	});
	it("hasCJK 判断", () => {
		expect(hasCJK("abc")).toBe(false);
		expect(hasCJK("笔记")).toBe(true);
	});
});

describe("tokenizeForBM25 CJK 三元组", () => {
	it("中文串产生三元组", () => {
		const tokens = tokenizeForBM25("思维导图");
		// 连续 4 字 → 2 个三元组：思维导、维导图
		expect(tokens).toContain("思维导");
		expect(tokens).toContain("维导图");
	});
	it("ASCII 词整词保留", () => {
		const tokens = tokenizeForBM25("Notion 增强");
		expect(tokens).toContain("notion");
	});
	it("短中文串（≤3）整体一个 token", () => {
		const tokens = tokenizeForBM25("看板");
		expect(tokens).toContain("看板");
	});
});

describe("bm25Score", () => {
	it("命中 term 得分 >0，未命中为 0", () => {
		const queryTokens = tokenizeForBM25("思维导图");
		const docTokens = tokenizeForBM25("思维导图 插件");
		const df = new Map<string, number>();
		for (const t of new Set([...queryTokens, ...docTokens])) df.set(t, 1);
		expect(bm25Score(queryTokens, docTokens, df, 10, 10)).toBeGreaterThan(0);
		expect(bm25Score(queryTokens, [], df, 10, 10)).toBe(0);
	});
	it("高频词 IDF 低（df 大 → 得分低）", () => {
		const q = tokenizeForBM25("插件");
		const doc = tokenizeForBM25("插件 插件");
		// df=N（所有文档都含）→ IDF≈0
		const df = new Map([[q[0], 100]]);
		expect(bm25Score(q, doc, df, 100, 5)).toBeLessThan(0.01);
	});
	it("长度归一：等长命中文档得分应高于更长文档（避免长描述恒被压低）", () => {
		const q = tokenizeForBM25("笔记");
		// 短文档与长文档都恰好命中一次 "笔记"
		const shortDoc = tokenizeForBM25("笔记");
		const longDoc = tokenizeForBM25("笔记 " + "内容".repeat(40));
		const df = new Map<string, number>();
		for (const t of new Set([...q, ...shortDoc, ...longDoc])) df.set(t, 1);
		const avgdl = (shortDoc.length + longDoc.length) / 2;
		const shortScore = bm25Score(q, shortDoc, df, 10, avgdl);
		const longScore = bm25Score(q, longDoc, df, 10, avgdl);
		expect(shortScore).toBeGreaterThan(longScore);
	});
});

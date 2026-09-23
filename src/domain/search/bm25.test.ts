import { describe, it, expect } from "vitest";
import { tokenizeForBM25, bm25Score, segmentWords } from "@domain/search/bm25";
import { t2sForEmbed, hasCJK } from "@translation/lexicon/t2s";

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
	it("长 CJK run（≥4）产 bigram+trigram（④ harness 裁决：2 字 query 命中长 run）", () => {
		const tokens = tokenizeForBM25("门禁系统管理工具");
		// bigram 让 2 字 query「门禁」命中该 run（旧纯 trigram 恒漏，short 桶 R@10 0.40→0.58）
		expect(tokens).toContain("门禁");
		expect(tokens).toContain("系统");
		// trigram 保留邻接精度
		expect(tokens).toContain("门禁系");
	});
	it("≤3 字 run 不被 n-gram 层拆（整词语义不变；词层为独立附加层）", () => {
		const t1 = tokenizeForBM25("看板");
		expect(t1).toContain("看板");
		expect(t1).not.toContain("看"); // 任何层都不产单字
		// 3 字 run 不产 bigram（「茄钟」只可能来自 n-gram 层，词层不会切出跨词界碎片）
		expect(tokenizeForBM25("番茄钟")).not.toContain("茄钟");
		expect(tokenizeForBM25("番茄钟")).toContain("番茄钟");
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
	it("高频词 IDF 低（df 大 → 得分低于低频 df）", () => {
		const q = tokenizeForBM25("插件");
		const doc = tokenizeForBM25("插件 插件");
		// df=N（所有文档都含）→ IDF≈0；与 df=1 对照验证单调性（对 qtf 缩放鲁棒）
		const highDf = new Map([[q[0], 100]]);
		const lowDf = new Map([[q[0], 1]]);
		expect(bm25Score(q, doc, highDf, 100, 5)).toBeLessThan(bm25Score(q, doc, lowDf, 100, 5));
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

describe("Intl.Segmenter 词层（④ 2026-09-20 用户裁决采纳）", () => {
	it.runIf(typeof (Intl as unknown as Record<string, unknown>).Segmenter === "function")(
		"词层产 ICU 词典词且拼接不变式成立（不丢字）",
		() => {
			const w = segmentWords("门禁系统管理工具");
			expect(w).toContain("门禁");
			expect(w.join("")).toBe("门禁系统管理工具");
		}
	);
	it.runIf(typeof (Intl as unknown as Record<string, unknown>).Segmenter === "function")(
		"tokenizeForBM25 = 词层 ∪ n-gram 层",
		() => {
			const t = tokenizeForBM25("门禁系统管理工具");
			expect(t).toContain("门禁系"); // trigram 层仍在
			expect(t).toContain("管理"); // 词层（ICU 词）
		}
	);
	it("空输入不抛错（fallback 环境契约）", () => {
		expect(segmentWords("")).toEqual([]);
		expect(tokenizeForBM25("")).toEqual([]);
	});
});

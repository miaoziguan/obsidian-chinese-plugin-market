import { describe, it, expect } from "vitest";
import { expandQuery, PLUGIN_SYNONYMS } from "@translation/lexicon/synonyms";

describe("expandQuery 同义词扩展", () => {
	it("命中中文词时追加英文别名", () => {
		const out = expandQuery("思维导图");
		expect(out).toContain("mind map");
		expect(out).toContain("markmap");
	});
	it("未命中的 query 原样返回", () => {
		expect(expandQuery("Notion")).toBe("Notion");
	});
	it("多个同义词命中都追加", () => {
		const out = expandQuery("笔记 同步");
		expect(out).toContain("note");
		expect(out).toContain("sync");
	});
	it("同义词表非空且格式正确", () => {
		expect(Object.keys(PLUGIN_SYNONYMS).length).toBeGreaterThan(20);
		for (const [cn, aliases] of Object.entries(PLUGIN_SYNONYMS)) {
			expect(cn.length).toBeGreaterThan(0);
			expect(aliases.length).toBeGreaterThan(0);
		}
	});
});

import { describe, it, expect } from "vitest";
import { isAIMode, isKeywordMode } from "@domain/search/search-mode";
import { makeMockContext } from "@shared/test-utils";

describe("searchMode 协调器（审计 P1-5）", () => {
	it("isAIMode 仅在 searchMode==='ai' 时为真", () => {
		const ai = makeMockContext({ searchMode: "ai" });
		const kw = makeMockContext({ searchMode: "keyword" });
		expect(isAIMode(ai)).toBe(true);
		expect(isAIMode(kw)).toBe(false);
	});

	it("isKeywordMode 仅在 searchMode==='keyword' 时为真", () => {
		const ai = makeMockContext({ searchMode: "ai" });
		const kw = makeMockContext({ searchMode: "keyword" });
		expect(isKeywordMode(kw)).toBe(true);
		expect(isKeywordMode(ai)).toBe(false);
	});

	it("两种模式互斥，覆盖全部已知模式（新增模式时不漏判）", () => {
		const ai = makeMockContext({ searchMode: "ai" });
		const kw = makeMockContext({ searchMode: "keyword" });
		expect(isAIMode(ai) !== isKeywordMode(ai)).toBe(true);
		expect(isAIMode(kw) !== isKeywordMode(kw)).toBe(true);
	});
});

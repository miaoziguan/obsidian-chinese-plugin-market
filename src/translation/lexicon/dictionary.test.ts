import { describe, it, expect } from "vitest";
import { computeCoverage } from "@translation/lexicon/dictionary";

describe("computeCoverage", () => {
	const total = new Set(["a", "b", "c", "d", "e"]);

	it("批量词典命中计入覆盖，覆盖率正确", () => {
		const bulk = { a: { name: "甲" }, b: { name: "乙" }, c: { name: "  " } };
		const cov = computeCoverage(total, bulk, {});
		// c 的 name 为空（trim 后）不计入；d/e 不在批量词典
		expect(cov.bulkHits).toBe(2);
		expect(cov.cacheHits).toBe(0);
		expect(cov.covered).toBe(2);
		expect(cov.total).toBe(5);
		expect(cov.coverage).toBeCloseTo(0.4);
	});

	it("缓存补译（非 original）计入覆盖且不重复计数", () => {
		const bulk = { a: { name: "甲" } };
		const cache = {
			a: { source: "bulk" },
			b: { source: "online" }, // 缓存补译
			c: { source: "original" }, // 原文兜底，不计入
		};
		const cov = computeCoverage(total, bulk, cache);
		expect(cov.bulkHits).toBe(1);
		expect(cov.cacheHits).toBe(1);
		expect(cov.covered).toBe(2); // a 已被 bulk 覆盖，不重复
	});

	it("total 为空时 coverage 为 0（避免除零）", () => {
		const cov = computeCoverage(new Set(), {}, {});
		expect(cov.coverage).toBe(0);
		expect(cov.total).toBe(0);
	});

	it("全量命中覆盖率为 1", () => {
		const bulk: Record<string, { name: string }> = {};
		for (const id of total) bulk[id] = { name: "名" };
		const cov = computeCoverage(total, bulk, {});
		expect(cov.coverage).toBe(1);
		expect(cov.covered).toBe(5);
	});
});

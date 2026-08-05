import { describe, it, expect } from "vitest";
import { parseDictionaryText, computeCoverage } from "./dictionary";

describe("parseDictionaryText", () => {
	it("解析合法词典，保留有效条目", () => {
		const text = JSON.stringify({
			"obsidian-kanban": { name: "看板", description: "看板视图" },
			"obsidian-dataview": { name: "Dataview" },
		});
		const { dict, invalid } = parseDictionaryText(text);
		expect(invalid).toBe(0);
		expect(dict["obsidian-kanban"]).toEqual({ name: "看板", description: "看板视图" });
		expect(dict["obsidian-dataview"]).toEqual({ name: "Dataview" });
	});

	it("非法 JSON 抛出可读错误", () => {
		expect(() => parseDictionaryText("{ not json")).toThrow(/解析失败/);
	});

	it("顶层非对象（数组/字符串）报错", () => {
		expect(() => parseDictionaryText("[1,2,3]")).toThrow(/顶层应为对象/);
		expect(() => parseDictionaryText('"hello"')).toThrow(/顶层应为对象/);
	});

	it("剔除 name 为空的无效条目并记录", () => {
		const text = JSON.stringify({
			valid: { name: "有效" },
			emptyName: { description: "无名称" },
			notObject: "x",
			"": { name: "空 id" },
		});
		const { dict, invalid } = parseDictionaryText(text);
		expect(invalid).toBe(3);
		expect(Object.keys(dict)).toEqual(["valid"]);
	});

	it("trim name / description", () => {
		const text = JSON.stringify({
			trim: { name: "  带空格  ", description: "  desc " },
		});
		const { dict } = parseDictionaryText(text);
		expect(dict["trim"].name).toBe("带空格");
		expect(dict["trim"].description).toBe("desc");
	});

	it("空 description 解析为 undefined（而非空串）", () => {
		const text = JSON.stringify({ a: { name: "A", description: "" } });
		const { dict } = parseDictionaryText(text);
		expect(dict["a"].description).toBeUndefined();
	});
});

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

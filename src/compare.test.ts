import { describe, it, expect } from "vitest";
import { compareTagsMulti, maxDownloads } from "./compare";

describe("compareTagsMulti", () => {
	it("N=2 求交集与各自独有", () => {
		const r = compareTagsMulti([
			["笔记", "双链", "Markdown"],
			["笔记", "同步", "图谱"],
		]);
		expect(r.common).toEqual(["笔记"]);
		expect(r.only[0]).toEqual(["双链", "Markdown"]);
		expect(r.only[1]).toEqual(["同步", "图谱"]);
	});

	it("N>2 交集对所有插件成立，独有只属于自己", () => {
		const r = compareTagsMulti([
			["笔记", "双链", "A"],
			["笔记", "双链", "B"],
			["笔记", "C"],
		]);
		expect(r.common).toEqual(["笔记"]); // 双链不在第 3 个里，故非交集
		expect(r.only[0]).toEqual(["A"]);
		expect(r.only[1]).toEqual(["B"]);
		expect(r.only[2]).toEqual(["C"]);
	});

	it("交集为空时返回空 common（功能互补）", () => {
		const r = compareTagsMulti([
			["笔记", "双链"],
			["同步", "图谱"],
		]);
		expect(r.common).toEqual([]);
		expect(r.only[0]).toEqual(["笔记", "双链"]);
		expect(r.only[1]).toEqual(["同步", "图谱"]);
	});

	it("含空集不报错，该插件独有为空", () => {
		const r = compareTagsMulti([
			["笔记", "双链"],
			[],
		]);
		expect(r.common).toEqual([]);
		expect(r.only[0]).toEqual(["笔记", "双链"]);
		expect(r.only[1]).toEqual([]);
	});

	it("N<2 返回空结构", () => {
		expect(compareTagsMulti([])).toEqual({ common: [], only: [] });
		expect(compareTagsMulti([["笔记"]])).toEqual({ common: [], only: [[]] });
	});

	it("集合内重复标签去重", () => {
		const r = compareTagsMulti([
			["笔记", "笔记", "双链"],
			["笔记", "同步"],
		]);
		expect(r.common).toEqual(["笔记"]);
		expect(r.only[0]).toEqual(["双链"]);
	});
});

describe("maxDownloads", () => {
	it("取最大值，缺失按 0 处理", () => {
		expect(maxDownloads([{ downloads: 100 }, { downloads: 5000 }, {}])).toBe(5000);
		expect(maxDownloads([])).toBe(0);
	});
});

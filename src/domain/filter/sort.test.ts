import { describe, it, expect } from "vitest";
import { sortPlugins } from "./sort";
import type { SortablePlugin } from "./sort";

const mk = (o: Partial<SortablePlugin> & { id: string }): SortablePlugin =>
	({ name: o.id, ...o } as SortablePlugin);

describe("sortPlugins 边界", () => {
	it("空列表 → 空数组", () => {
		expect(sortPlugins([], "downloads")).toEqual([]);
	});
	it("不修改入参（返回新数组）", () => {
		const list = [mk({ id: "a", downloads: 1 }), mk({ id: "b", downloads: 2 })];
		const before = JSON.stringify(list);
		sortPlugins(list, "downloads");
		expect(JSON.stringify(list)).toBe(before);
	});
});

const baseList = [
	mk({ id: "a", downloads: 5, updated: 1, listIndex: 3, name: "c" }),
	mk({ id: "b", downloads: 5, updated: 2, listIndex: 2, name: "a" }),
	mk({ id: "c", downloads: 9, updated: 3, listIndex: 1, name: "b" }),
];

describe("sortPlugins 各维度正确性", () => {
	it("downloads 降序（相等项保持原序）", () => {
		expect(sortPlugins(baseList, "downloads").map((p) => p.id)).toEqual(["c", "a", "b"]);
	});
	it("updated 降序", () => {
		expect(sortPlugins(baseList, "updated").map((p) => p.id)).toEqual(["c", "b", "a"]);
	});
	it("published 按下标降序", () => {
		expect(sortPlugins(baseList, "published").map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
	it("name 用 name 字段本地化升序", () => {
		expect(sortPlugins(baseList, "name").map((p) => p.id)).toEqual(["b", "c", "a"]);
	});
	it("popular 无 installedIds → 下载量降序，下载相同再按更新时间降序", () => {
		expect(sortPlugins(baseList, "popular").map((p) => p.id)).toEqual(["c", "b", "a"]);
	});
	it("trending 按评分降序", () => {
		const opts = { trendingScores: new Map([["a", 0.1], ["b", 0.5], ["c", 0.9]]) };
		expect(sortPlugins(baseList, "trending", opts).map((p) => p.id)).toEqual(["c", "b", "a"]);
	});
	it("recommended 按评分降序", () => {
		const opts = { recommendScores: new Map([["a", 10], ["b", 50], ["c", 90]]) };
		expect(sortPlugins(baseList, "recommended", opts).map((p) => p.id)).toEqual(["c", "b", "a"]);
	});
});

describe("sortPlugins 稳定排序（相等 key 保持原序）", () => {
	it("downloads 全相等 → 原序", () => {
		const list = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
		expect(sortPlugins(list, "downloads").map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
});

describe("sortPlugins(name) 三层显示名来源", () => {
	it("displayNameOf 回调优先", () => {
		const list = [mk({ id: "2", name: "x" }), mk({ id: "1", name: "y" }), mk({ id: "3", name: "z" })];
		const out = sortPlugins(list, "name", { displayNameOf: (p) => p.id }).map((p) => p.id);
		expect(out).toEqual(["1", "2", "3"]);
	});
	it("fallback 到 displayName 字段", () => {
		const list = [mk({ id: "a", name: "x", displayName: "banana" }), mk({ id: "b", name: "y", displayName: "apple" })];
		const out = sortPlugins(list, "name").map((p) => p.id);
		expect(out).toEqual(["b", "a"]);
	});
	it("再 fallback 到 name", () => {
		const list = [mk({ id: "a", name: "c" }), mk({ id: "b", name: "a" }), mk({ id: "c", name: "b" })];
		const out = sortPlugins(list, "name").map((p) => p.id);
		expect(out).toEqual(["b", "c", "a"]);
	});
});

describe("sortPlugins(popular) 未安装优先 → 下载量 → 更新时间", () => {
	it("完整决策链", () => {
		const list = [
			mk({ id: "a", downloads: 100, updated: 1 }), // 已安装
			mk({ id: "b", downloads: 100, updated: 2 }), // 已安装，与 a 下载相同→更新时间更晚排前
			mk({ id: "c", downloads: 200, updated: 1 }), // 未安装，下载最高
			mk({ id: "d", downloads: 50, updated: 1 }), // 未安装
		];
		const out = sortPlugins(list, "popular", { installedIds: new Set(["a", "b"]) }).map((p) => p.id);
		expect(out).toEqual(["c", "d", "b", "a"]);
	});
});

describe("sortPlugins(trending/recommended) 缺评分表 → 全部 0 维持原序", () => {
	it("trending 无 trendingScores → 原序", () => {
		const list = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
		expect(sortPlugins(list, "trending").map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
	it("recommended 无 recommendScores → 原序", () => {
		const list = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
		expect(sortPlugins(list, "recommended").map((p) => p.id)).toEqual(["a", "b", "c"]);
	});
});

describe("sortPlugins(relevance / default) 保持原序", () => {
	it("relevance 返回副本（slice）", () => {
		const list = [mk({ id: "a" }), mk({ id: "b" }), mk({ id: "c" })];
		const out = sortPlugins(list, "relevance");
		expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
		expect(out).not.toBe(list); // 新数组
	});
});

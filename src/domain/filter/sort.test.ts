import { describe, it, expect } from "vitest";
import { sortPlugins, type SortBy, type SortablePlugin } from "@domain/filter/sort";

/**
 * 结果排序切换（产品改进 #5 / 体验迭代 #4）单测。
 * 维度：relevance（默认，保持传入顺序）/ downloads / updated / name / popular / published。
 */
describe("sortPlugins", () => {
	const list: SortablePlugin[] = [
		{ id: "a", name: "Zebra", displayName: "斑马", downloads: 100, updated: 1000 },
		{ id: "b", name: "apple", displayName: "苹果", downloads: 5000, updated: 3000 },
		{ id: "c", name: "Mango", displayName: "芒果", downloads: 300, updated: 2000 },
		{ id: "d", name: "kiwi", displayName: "猕猴桃", updated: undefined },
	];

	it("relevance：原样返回（稳定，不改顺序）", () => {
		const out = sortPlugins(list, "relevance");
		expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("downloads：按下载量降序，缺失视为 0 排最后", () => {
		const out = sortPlugins(list, "downloads");
		expect(out.map((p) => p.id)).toEqual(["b", "c", "a", "d"]);
	});

	it("updated：按更新时间降序，缺失排最后", () => {
		const out = sortPlugins(list, "updated");
		expect(out.map((p) => p.id)).toEqual(["b", "c", "a", "d"]);
	});

	it("published：按清单下标倒序（下标越大越新），缺失沉底", () => {
		const publishedList: SortablePlugin[] = [
			{ id: "a", name: "A", displayName: "甲", downloads: 100, updated: 1000, listIndex: 2 },
			{ id: "b", name: "B", displayName: "乙", downloads: 5000, updated: 3000, listIndex: 0 },
			{ id: "c", name: "C", displayName: "丙", downloads: 300, updated: 2000, listIndex: undefined },
		];
		// 最新（a 下标 2）在前，最旧（b 下标 0）次之，缺失（c）沉底
		const out = sortPlugins(publishedList, "published");
		expect(out.map((p) => p.id)).toEqual(["a", "b", "c"]);
	});

	it("published：全部缺失时保持原顺序", () => {
		const out = sortPlugins(list, "published");
		expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("name：按显示名（中文名优先）本地化升序", () => {
		const out = sortPlugins(list, "name");
		// 斑马/芒果/猕猴桃/苹果 —— 用 localeCompare，结果需稳定
		const names = out.map((p) => p.displayName ?? p.name);
		// 断言是升序（相邻两两 <=0）
		for (let i = 1; i < names.length; i++) {
			expect(names[i - 1].localeCompare(names[i], "zh") <= 0).toBe(true);
		}
	});

	it("不修改原数组（返回新数组）", () => {
		const copy = [...list];
		sortPlugins(list, "downloads");
		expect(list.map((p) => p.id)).toEqual(copy.map((p) => p.id));
	});

	it("空数组安全", () => {
		expect(sortPlugins([], "downloads")).toEqual([]);
	});

	it("未知 sortBy 退化为 relevance", () => {
		const out = sortPlugins(list, "unknown" as SortBy);
		expect(out.map((p) => p.id)).toEqual(["a", "b", "c", "d"]);
	});

	it("popular：未安装优先，已安装沉底，其次下载量降序", () => {
		const installed = new Set(["c", "d"]); // c/d 已安装
		const out = sortPlugins(list, "popular", { installedIds: installed });
		// 未安装的 b(5000) a(100) 置顶按下载量降序；已安装的 c(300) d 沉底
		expect(out.map((p) => p.id)).toEqual(["b", "a", "c", "d"]);
	});

	it("popular：均未安装时退化为下载量降序", () => {
		const out = sortPlugins(list, "popular", { installedIds: new Set() });
		expect(out.map((p) => p.id)).toEqual(["b", "c", "a", "d"]);
	});

	it("popular：下载量相同则按更新时间降序", () => {
		const tie: SortablePlugin[] = [
			{ id: "x", name: "X", displayName: "X", downloads: 100, updated: 100 },
			{ id: "y", name: "Y", displayName: "Y", downloads: 100, updated: 200 },
		];
		const out = sortPlugins(tie, "popular", { installedIds: new Set() });
		expect(out.map((p) => p.id)).toEqual(["y", "x"]);
	});

	it("popular：不修改原数组", () => {
		const copy = [...list];
		sortPlugins(list, "popular", { installedIds: new Set(["c"]) });
		expect(list.map((p) => p.id)).toEqual(copy.map((p) => p.id));
	});
});

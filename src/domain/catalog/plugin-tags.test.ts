import { describe, it, expect } from "vitest";
import { PluginTagService, type PluginTag } from "@domain/catalog/plugin-tags";

describe("PluginTagService", () => {
	const fixtures: Record<string, PluginTag> = {
		sync: { category: "同步与备份", tags: ["同步", "云盘"] },
		kanban: { category: "任务与项目", tags: ["看板", "甘特图"] },
		theme: { category: "外观与主题", tags: ["主题", "色彩"] },
		calendar: { category: "日历与提醒", tags: ["日历"] },
		untagged: { category: "外观与主题", tags: [] },
	};

	it("load 后 getTag 可查询", () => {
		const s = new PluginTagService();
		s.load(fixtures, "v8");
		expect(s.getTag("sync")?.category).toBe("同步与备份");
		expect(s.getTag("nonexistent")).toBeNull();
	});

	it("getSchemaVersion 返回版本号", () => {
		const s = new PluginTagService();
		expect(s.getSchemaVersion()).toBeUndefined();
		s.load(fixtures, "v8");
		expect(s.getSchemaVersion()).toBe("v8");
	});

	it("getAllCategories 返回按拼音排序的一级分类名", () => {
		const s = new PluginTagService();
		s.load(fixtures);
		const cats = s.getAllCategories();
		expect(cats).toContain("同步与备份");
		expect(cats).toContain("外观与主题");
		expect(cats).toContain("任务与项目");
		expect(cats).toContain("日历与提醒");
		// 验证已按 localeCompare("zh") 排序
		expect(cats.length).toBe(4);
		// 中文 locale 排序行为在不同运行时可能略有差异，
		// 此处仅验证首字符有序（localeCompare 的契约）
		const firstChars = cats.map((c) => c[0]);
		const sorted = [...firstChars].sort((a, b) => a.localeCompare(b, "zh"));
		expect(firstChars).toEqual(sorted);
	});

	it("getAllCategoryCounts 返回按 count 降序", () => {
		const s = new PluginTagService();
		s.load(fixtures);
		const counts = s.getAllCategoryCounts();
		// 外观与主题有 2 个（theme + untagged），同步与备份 1 个，任务与项目 1 个，日历与提醒 1 个
		expect(counts[0].category).toBe("外观与主题");
		expect(counts[0].count).toBe(2);
	});

	it("getIdsByCategory 返回指定分类下的插件 id", () => {
		const s = new PluginTagService();
		s.load(fixtures);
		expect(s.getIdsByCategory("同步与备份")).toEqual(["sync"]);
		expect(s.getIdsByCategory("外观与主题").sort()).toEqual(["theme", "untagged"]);
		expect(s.getIdsByCategory("不存在的分类")).toEqual([]);
	});

	it("getAllTagCounts 返回全部标签及频次", () => {
		const s = new PluginTagService();
		s.load(fixtures);
		const tagCounts = s.getAllTagCounts();
		const map = new Map(tagCounts.map((t) => [t.tag, t.count]));
		expect(map.get("同步")).toBe(1);
		expect(map.get("主题")).toBe(1);
		expect(map.get("看板")).toBe(1);
	});

	it("getIdsByTag 返回指定标签下的插件 id", () => {
		const s = new PluginTagService();
		s.load(fixtures);
		expect(s.getIdsByTag("同步")).toEqual(["sync"]);
		expect(s.getIdsByTag("不存在的标签")).toEqual([]);
	});

	it("getAllTags 返回全量映射", () => {
		const s = new PluginTagService();
		s.load(fixtures);
		const all = s.getAllTags();
		expect(all["sync"]?.category).toBe("同步与备份");
		expect(Object.keys(all).length).toBe(5);
	});
});

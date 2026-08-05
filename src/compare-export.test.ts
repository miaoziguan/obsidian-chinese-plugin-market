import { describe, it, expect } from "vitest";
import { renderCompareMarkdown, type CompareExportItem } from "./compare-export";

const baseItem = (overrides: Partial<CompareExportItem> = {}): CompareExportItem => ({
	id: "a",
	name: "看板",
	originalName: "Kanban",
	description: "划板任务管理",
	downloads: 12000,
	updated: Date.now(),
	installed: "on",
	tags: { category: "任务与项目", tags: ["看板", "任务", "甘特图"] },
	...overrides,
});

describe("renderCompareMarkdown", () => {
	it("生成包含标题和共同功能的 Markdown", () => {
		const a = baseItem({ id: "a", name: "看板" });
		const b = baseItem({
			id: "b",
			name: "任务板",
			originalName: "Task Board",
			installed: "none",
			tags: { category: "任务与项目", tags: ["看板", "任务管理"] },
		});

		const md = renderCompareMarkdown([a, b], "插件对比：看板 vs 任务板");
		expect(md).toContain("# 插件对比：看板 vs 任务板");
		expect(md).toContain("## 共同功能");
		expect(md).toContain("- 看板");
		expect(md).toContain("## 看板");
		expect(md).toContain("Task Board");
		expect(md).toContain("下载量");
		expect(md).toContain("由「插件搜索」对比生成");
	});

	it("翻译名与原名相同时不追加原名", () => {
		const a = baseItem({ id: "a", name: "Kanban", originalName: "Kanban" });
		const md = renderCompareMarkdown([a], "测试");
		expect(md).toContain("## Kanban");
		expect(md).not.toContain("(Kanban)");
	});

	it("无共同标签时显示互补提示", () => {
		const a = baseItem({ tags: { category: "A", tags: ["X"] } });
		const b = baseItem({ id: "b", tags: { category: "B", tags: ["Y"] } });
		const md = renderCompareMarkdown([a, b], "测试");
		expect(md).toContain("功能互补");
		expect(md).not.toContain("## 共同功能");
	});

	it("未安装和未启用状态正确显示", () => {
		const a = baseItem({ installed: "off" });
		const b = baseItem({ id: "b", installed: "none" });
		const md = renderCompareMarkdown([a, b], "测试");
		expect(md).toContain("已安装·未启用");
		expect(md).toContain("未安装");
	});

	it("空插件列表输出最小结构", () => {
		const md = renderCompareMarkdown([], "空");
		expect(md).toContain("# 空");
		expect(md).toContain("功能互补");
	});
});

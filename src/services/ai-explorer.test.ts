import { describe, it, expect } from "vitest";
import { isAIWorthyQuery, isKeywordWorthyQuery } from "./ai-explorer";

describe("搜索路由启发式", () => {
	it("短查询/纯数字不适合 AI", () => {
		expect(isAIWorthyQuery("git")).toBe(false);
		expect(isAIWorthyQuery("123456")).toBe(false);
	});

	it("语义丰富的查询适合 AI", () => {
		expect(isAIWorthyQuery("帮我找一个能管理任务的插件")).toBe(true); // CJK ≥ 4
		expect(isAIWorthyQuery("plugin that syncs my notes to cloud")).toBe(true); // 长查询
	});

	it("任何非空查询至少被一侧认领（回归 L7：消除路由盲区）", () => {
		const samples = [
			"git",
			"123456",
			"obsidian-git", // 曾经的盲区：12 字符、无 CJK、单词 → 两侧都不认领
			"kanban",
			"dataview 表格",
			"帮我找一个能管理任务的插件",
			"plugin that syncs my notes to cloud",
			"a b c d e f",
			"日历",
			"看板任务",
		];
		for (const q of samples) {
			expect(
				isAIWorthyQuery(q) || isKeywordWorthyQuery(q),
				`查询「${q}」未被任何一侧认领`
			).toBe(true);
		}
	});

	it("两个启发式严格互补（不适合 AI ⇔ 适合关键词）", () => {
		const samples = ["git", "obsidian-git", "帮我找一个能管理任务的插件", "kanban board"];
		for (const q of samples) {
			expect(isKeywordWorthyQuery(q)).toBe(!isAIWorthyQuery(q));
		}
	});

	it("空查询两侧都不认领", () => {
		expect(isAIWorthyQuery("")).toBe(false);
		expect(isKeywordWorthyQuery("")).toBe(false);
		expect(isKeywordWorthyQuery("   ")).toBe(false);
	});
});

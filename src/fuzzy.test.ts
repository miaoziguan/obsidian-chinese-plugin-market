import { describe, it, expect } from "vitest";
import {
	jaroWinkler,
	fuzzyTitleScores,
	rrfFuse,
	topNFused,
	type RecallCandidate,
} from "./utils";

const plugins: RecallCandidate[] = [
	{ id: "pomodoro", name: "Pomodoro Timer", description: "番茄钟" },
	{ id: "kanban", name: "Kanban Board", description: "看板" },
	{ id: "notion", name: "Notion 增强", description: "notion 增强" },
	{ id: "calendar", name: "Obsidian Calendar", description: "日历" },
];

describe("jaroWinkler", () => {
	it("完全相同为 1", () => {
		expect(jaroWinkler("kanban", "kanban")).toBe(1);
	});
	it("前缀匹配加权（k vs kanban）> 普通相似", () => {
		const prefixScore = jaroWinkler("kan", "kanban");
		expect(prefixScore).toBeGreaterThan(0.5);
	});
});

describe("fuzzyTitleScores 第三路检索器", () => {
	it("query 命中的插件含于结果且按分数降序", () => {
		const m = fuzzyTitleScores("kan", plugins);
		expect(m.has("kanban")).toBe(true);
		expect(m.has("notion")).toBe(false); // 名字不含 kan
		// 降序
		const scores = Array.from(m.values());
		expect([...scores].sort((a, b) => b - a)).toEqual(scores);
	});

	it("minScore 阈值过滤低相似", () => {
		// "kan" 与 "Kanban Board" 前缀匹配，松阈值应命中
		const loose = fuzzyTitleScores("kan", plugins, 50, 0.1);
		expect(loose.size).toBeGreaterThan(0);
		// 严格阈值 0.95：只有近似完全一致才命中，短查询大概率不达标
		const strict = fuzzyTitleScores("kan", plugins, 50, 0.99);
		expect(strict.size).toBe(0);
	});

	it("空 query 返回空", () => {
		expect(fuzzyTitleScores("   ", plugins).size).toBe(0);
	});
});

describe("rrfFuse 融合", () => {
	it("两路命中的文档靠前", () => {
		const a = new Map([["x", 10], ["y", 9], ["z", 8]]);
		const b = new Map([["y", 5], ["x", 4]]);
		const fused = rrfFuse([a, b], [1, 1]);
		const top = topNFused(fused, 3).map((t) => t.id);
		// x、y 两路都命中，应排在只命中一路的 z 之前
		expect(top[0]).toBe("x");
		expect(top[1]).toBe("y");
		expect(top).toContain("z");
	});

	it("权重为 0 的检索器不参与", () => {
		const a = new Map([["x", 1], ["y", 2]]);
		const b = new Map([["z", 3]]);
		const fused = rrfFuse([a, b], [0, 1]);
		expect(fused.has("x")).toBe(false);
		expect(fused.has("y")).toBe(false);
		expect(fused.has("z")).toBe(true);
	});
});

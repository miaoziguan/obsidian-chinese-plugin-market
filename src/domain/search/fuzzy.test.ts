import { describe, it, expect } from "vitest";
import {
	jaroWinkler,
	fuzzyTitleScores,
	rrfFuse,
	topNFused,
	type RecallCandidate,
} from "@shared/utils";

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

	it("nameZh 作为第二标题目标：中文查询模糊命中译名", () => {
		const m = fuzzyTitleScores("迷你番茄", [
			{ id: "minidoro", name: "Minidoro", description: "timer", nameZh: "迷你番茄钟" },
		]);
		// 英文名与查询无公共字符必 miss；nameZh 前缀匹配 → jw≈0.94 ≥ 0.55。
		// 注意：Jaro 匹配窗口=floor(max(len)/2)-1，子串居中的短查询（如"番茄"vs"迷你番茄钟"）
		// 窗口外交配为 0，由 BM25 三元组路兜底（见 ai.test.ts 中文 query 用例），不归模糊路管。
		expect(m.has("minidoro")).toBe(true);
	});

	it("快速否决不误杀：英文名无公共字符但 nameZh 有，仍进入打分", () => {
		const m = fuzzyTitleScores("看板", [
			{ id: "kanban", name: "Kanban Board", description: "board", nameZh: "看板" },
		]);
		expect(m.get("kanban")).toBe(1); // nameZh 完全匹配
	});

	it("字符覆盖门：2 字 query 单字重叠拒（「打卡」真机案例 ×锁卡/打印）", () => {
		const m = fuzzyTitleScores("打卡", [
			{ id: "lock", name: "Lock Cards", description: "d", nameZh: "锁卡" },
			{ id: "print", name: "Print", description: "d", nameZh: "打印" },
			{ id: "punch", name: "Punch Clock", description: "d", nameZh: "打卡钟" },
		]);
		expect(m.get("lock")).toBeUndefined();
		expect(m.get("print")).toBeUndefined();
		expect(m.get("punch")!).toBeGreaterThan(0.55); // 全字符覆盖 → 留
	});

	it("字符覆盖门对 ≥3 字 query 不生效（P-0061 前缀容错保留）", () => {
		const m = fuzzyTitleScores("迷你番茄", [
			{ id: "minidoro", name: "Minidoro", description: "d", nameZh: "迷你番茄钟" },
		]);
		expect(m.get("minidoro")!).toBeGreaterThan(0.55);
		// 3 字 query 部分字符缺失仍按原阈值（门只管 ≤2 字）
		const m2 = fuzzyTitleScores("番茄钟", [
			{ id: "pomo", name: "Pomo", description: "d", nameZh: "番茄工作法" },
		]);
		expect(m2.get("pomo")!).toBeGreaterThan(0.55);
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

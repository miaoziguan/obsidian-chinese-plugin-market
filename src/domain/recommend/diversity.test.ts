import { describe, it, expect } from "vitest";
import { DiversityReranker, type TaggedPlugin } from "@domain/recommend/diversity";

describe("DiversityReranker.selectDiverse", () => {
	it("空输入返回空数组", () => {
		const r = new DiversityReranker([]);
		expect(r.selectDiverse([])).toEqual([]);
	});

	it("首项类别计入连续控制：同类别不能连续出现 maxConsecutive+1 次（回归 M6）", () => {
		// a/b/c 同类别 X（高分），d 类别 Y（低分）
		const tags: TaggedPlugin[] = [
			{ id: "a", category: "X", tags: [] },
			{ id: "b", category: "X", tags: [] },
			{ id: "c", category: "X", tags: [] },
			{ id: "d", category: "Y", tags: [] },
		];
		const r = new DiversityReranker(tags);
		const result = r.selectDiverse(
			[
				{ id: "a", score: 1.0 },
				{ id: "b", score: 0.9 },
				{ id: "c", score: 0.8 },
				{ id: "d", score: 0.1 },
			],
			// lambda=1 关闭 MMR 相似度项，只验证连续类别惩罚
			{ lambda: 1, topK: 4, maxConsecutiveCategory: 2 }
		);
		// 修复前：首项 a 的类别 X 不计入历史 → X 连续出现 3 次（a,b,c,d）
		// 修复后：a,b 已连续两个 X → 第三轮 c 被惩罚，d 插入
		expect(result).toEqual(["a", "b", "d", "c"]);
	});

	it("topK 截断生效", () => {
		const tags: TaggedPlugin[] = [
			{ id: "a", category: "X", tags: [] },
			{ id: "b", category: "Y", tags: [] },
			{ id: "c", category: "Z", tags: [] },
		];
		const r = new DiversityReranker(tags);
		const result = r.selectDiverse(
			[
				{ id: "a", score: 3 },
				{ id: "b", score: 2 },
				{ id: "c", score: 1 },
			],
			{ topK: 2 }
		);
		expect(result.length).toBe(2);
		expect(result[0]).toBe("a");
	});
});

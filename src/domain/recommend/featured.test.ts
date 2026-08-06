import { describe, it, expect } from "vitest";
import { computeFeaturedIds, ENGINE_FEATURED_COUNT } from "@domain/recommend/featured";

/** 造一批 {id} 形插件 */
function mkPlugins(...ids: string[]) {
	return ids.map((id) => ({ id }));
}

describe("computeFeaturedIds（P2-3: 从 view-featured 拆离的纯生产逻辑）", () => {
	it("引擎模式：有 recommendScores（≥2 个未安装候选）→ engineDriven=true，按评分降序，上限 ENGINE_FEATURED_COUNT", () => {
		const scores = new Map([
			["a", 90],
			["b", 80],
			["c", 70],
			["d", 60],
			["e", 50],
		]);
		const { ids, engineDriven } = computeFeaturedIds({
			plugins: mkPlugins("a", "b", "c", "d", "e"),
			recommendScores: scores,
			installedIds: new Set(),
			curatedIds: new Set(),
			allTags: null,
		});
		expect(engineDriven).toBe(true);
		expect(ids).toEqual(["a", "b", "c", "d"]);
		expect(ids.length).toBeLessThanOrEqual(ENGINE_FEATURED_COUNT);
	});

	it("引擎模式：已安装的插件被过滤", () => {
		const scores = new Map([
			["a", 90],
			["b", 80],
			["c", 70],
		]);
		const { ids, engineDriven } = computeFeaturedIds({
			plugins: mkPlugins("a", "b", "c"),
			recommendScores: scores,
			installedIds: new Set(["a"]),
			curatedIds: new Set(),
			allTags: null,
		});
		expect(engineDriven).toBe(true);
		expect(ids).toEqual(["b", "c"]);
	});

	it("引擎候选不足 2 个 → 回退策划清单（前 3 个，engineDriven=false）", () => {
		// 仅 1 个有分候选，触发回退
		const scores = new Map([["a", 90]]);
		const { ids, engineDriven } = computeFeaturedIds({
			plugins: mkPlugins("a", "x", "y", "z", "w"),
			recommendScores: scores,
			installedIds: new Set(),
			curatedIds: new Set(["x", "y", "z", "w"]),
			allTags: null,
		});
		expect(engineDriven).toBe(false);
		expect(ids).toEqual(["x", "y", "z"]);
	});

	it("无评分、无策划清单 → 空结果", () => {
		const { ids, engineDriven } = computeFeaturedIds({
			plugins: mkPlugins("a", "b"),
			recommendScores: null,
			installedIds: new Set(),
			curatedIds: new Set(),
			allTags: null,
		});
		expect(engineDriven).toBe(false);
		expect(ids).toEqual([]);
	});

	it("引擎模式 + 标签数据：走 MMR 多样性重排，结果仍过滤已安装且非空", () => {
		const scores = new Map([
			["a", 95],
			["b", 90],
			["c", 85],
			["d", 80],
		]);
		const allTags = {
			a: { category: "任务管理", tags: ["kanban"] },
			b: { category: "任务管理", tags: ["kanban"] },
			c: { category: "外观", tags: ["theme"] },
			d: { category: "编辑增强", tags: ["editor"] },
		};
		const { ids, engineDriven } = computeFeaturedIds({
			plugins: mkPlugins("a", "b", "c", "d"),
			recommendScores: scores,
			installedIds: new Set(["b"]),
			curatedIds: new Set(),
			allTags,
		});
		expect(engineDriven).toBe(true);
		expect(ids).not.toContain("b");
		expect(ids.length).toBeGreaterThanOrEqual(2);
		// MMR maxConsecutiveCategory=1：头两位不应是同分类连排
		expect(ids[0]).toBe("a");
	});
});

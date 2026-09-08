import { describe, it, expect } from "vitest";
import { computeJournalStats } from "./journal-stats";
import type { JournalEntry } from "./journal-entry";

function entry(over: Partial<JournalEntry>): JournalEntry {
	return {
		id: over.id ?? "x",
		name: over.name ?? "X",
		note: "",
		...over,
	};
}

describe("computeJournalStats", () => {
	it("空列表：total=0，弃用率=0，踩坑 Top 空", () => {
		const s = computeJournalStats([]);
		expect(s.total).toBe(0);
		expect(s.abandonRate).toBe(0);
		expect(s.topVerdicts).toEqual([]);
		expect(s.installCountSum).toBe(0);
	});

	it("状态分布与弃用率", () => {
		const s = computeJournalStats([
			entry({ id: "a", status: "using" }),
			entry({ id: "b", status: "abandoned" }),
			entry({ id: "c", status: "watching" }),
			entry({ id: "d", status: "abandoned" }),
		]);
		expect(s.total).toBe(4);
		expect(s.using).toBe(1);
		expect(s.abandoned).toBe(2);
		expect(s.watching).toBe(1);
		expect(s.abandonRate).toBeCloseTo(2 / 4);
	});

	it("无 status 的笔记不计入分母", () => {
		const s = computeJournalStats([
			entry({ id: "a", status: "abandoned" }),
			entry({ id: "b" }), // 无 status
		]);
		expect(s.total).toBe(1);
		expect(s.abandonRate).toBe(1);
	});

	it("踩坑 Top：按 verdict 聚合降序", () => {
		const s = computeJournalStats([
			entry({ id: "1", status: "abandoned", verdict: ["有 bug", "太重"] }),
			entry({ id: "2", status: "abandoned", verdict: ["有 bug"] }),
			entry({ id: "3", status: "abandoned", verdict: ["收费", "有 bug", "冲突"] }),
			entry({ id: "4", status: "using", verdict: ["收费"] }),
		]);
		expect(s.topVerdicts).toEqual([
			{ reason: "有 bug", count: 3 },
			{ reason: "收费", count: 2 },
			{ reason: "冲突", count: 1 },
			{ reason: "太重", count: 1 },
		]);
	});

	it("踩坑 Top 截断到 5 个", () => {
		const many = Array.from({ length: 8 }, (_, i) =>
			entry({ id: `p${i}`, status: "abandoned", verdict: [`原因${i}`] }),
		);
		const s = computeJournalStats(many);
		expect(s.topVerdicts).toHaveLength(5);
	});

	it("累计安装次数求和 + 评分计数", () => {
		const s = computeJournalStats([
			entry({ id: "a", status: "using", installCount: 3, rating: 4 }),
			entry({ id: "b", status: "abandoned", installCount: 1, rating: 2 }),
			entry({ id: "c", installCount: 2 }), // 无 rating/status
		]);
		expect(s.installCountSum).toBe(6);
		expect(s.ratedCount).toBe(2);
	});
});

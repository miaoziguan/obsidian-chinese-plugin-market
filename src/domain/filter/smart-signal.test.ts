import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { PluginStat } from "@domain/catalog/stats";
import { computeSmartSignals } from "./smart-signal";

const NOW = 1_700_000_000_000;
const DAY = 86_400_000;
const daysAgo = (n: number) => NOW - n * DAY;

const mk = (id: string, downloads: number, updated?: number): PluginInfo =>
	({ id, name: id, description: "", author: "", downloads, updated } as unknown as PluginInfo);
const stats = (entries: [string, number][]): Map<string, PluginStat> =>
	new Map(entries.map(([id, downloads]) => [id, { downloads } as PluginStat]));

let spy: ReturnType<typeof vi.spyOn> | undefined;
beforeEach(() => {
	spy = vi.spyOn(Date, "now").mockReturnValue(NOW);
});
afterEach(() => {
	spy?.mockRestore();
});

describe("computeSmartSignals 分位标（互斥）", () => {
	it("空列表 → 空 Map", () => {
		expect(computeSmartSignals([]).size).toBe(0);
	});

	it("单插件 → top1（30-44）", () => {
		const out = computeSmartSignals([mk("a", 10)]);
		expect(out.get("a")).toEqual(["top1"]);
	});

	it("200 插件分位边界：top1(<2) / top5(<10) / hot10(<20) / 无(≥20)", () => {
		const plugins = Array.from({ length: 200 }, (_, i) => mk("p" + i, 1000 - i));
		const out = computeSmartSignals(plugins);
		expect(out.get("p0")).toEqual(["top1"]);
		expect(out.get("p5")).toEqual(["top5"]);
		expect(out.get("p15")).toEqual(["hot10"]);
		expect(out.get("p24")).toBeUndefined();
	});
});

describe("computeSmartSignals 共存标", () => {
	it("10 天内更新 → top1 + recentActive + recentUpdate（各上限守卫）", () => {
		const out = computeSmartSignals([mk("a", 10, daysAgo(10))]);
		expect(out.get("a")).toEqual(["top1", "recentActive", "recentUpdate"]);
	});

	it("50 天内更新 → top1 + recentActive（未达 30 天，无 recentUpdate）", () => {
		const out = computeSmartSignals([mk("a", 10, daysAgo(50))]);
		expect(out.get("a")).toEqual(["top1", "recentActive"]);
	});

	it("100 天前更新 → 仅 top1（超 90 天活跃窗口）", () => {
		const out = computeSmartSignals([mk("a", 10, daysAgo(100))]);
		expect(out.get("a")).toEqual(["top1"]);
	});

	it("无 updated → 仅分位（updated 缺失分支）", () => {
		const out = computeSmartSignals([mk("a", 10)]);
		expect(out.get("a")).toEqual(["top1"]);
	});
});

describe("computeSmartSignals 趋势信号 velocityRising", () => {
	it("无 prevStats → velocityScores 为 null，跳过趋势分支", () => {
		const out = computeSmartSignals([mk("a", 200, daysAgo(10))]);
		expect(out.get("a")).not.toContain("velocityRising");
	});

	it("prevStats 为空 Map → 跳过趋势计算", () => {
		const out = computeSmartSignals([mk("a", 200, daysAgo(10))], new Map());
		expect(out.get("a")).not.toContain("velocityRising");
	});

	it("增速明显高于均值 → 该插件获 velocityRising（sigmoid 分支）", () => {
		const plugins = [mk("a", 200, daysAgo(100)), mk("c", 102, daysAgo(100)), mk("b", 101, daysAgo(100))];
		const st = stats([
			["a", 100],
			["c", 100],
			["b", 100],
		]);
		const out = computeSmartSignals(plugins, st);
		expect(out.get("a")).toEqual(["top1", "velocityRising"]);
		expect(out.get("b") ?? []).not.toContain("velocityRising");
		expect(out.get("c") ?? []).not.toContain("velocityRising");
	});

	it("所有插件增速相同 → stddev=0 → 趋势分置 0，无人获 velocityRising", () => {
		const plugins = [mk("a", 110, daysAgo(100)), mk("b", 110, daysAgo(100))];
		const st = stats([
			["a", 100],
			["b", 100],
		]);
		const out = computeSmartSignals(plugins, st);
		expect(out.get("a")).not.toContain("velocityRising");
		expect(out.get("b") ?? []).not.toContain("velocityRising");
	});

	it("curr ≤ prev → 不计 velocity，趋势分支整体为空", () => {
		const plugins = [mk("a", 50, daysAgo(100))];
		const st = stats([["a", 100]]);
		const out = computeSmartSignals(plugins, st);
		expect(out.get("a")).not.toContain("velocityRising");
	});

	it("信号已满 3 → velocityRising 被 length<3 守卫挡下", () => {
		// a 是 top1 + 10 天内（recentActive + recentUpdate 共 3），即使增速高也不叠加
		const plugins = [mk("a", 200, daysAgo(10)), mk("b", 101, daysAgo(100))];
		const st = stats([
			["a", 100],
			["b", 100],
		]);
		const out = computeSmartSignals(plugins, st);
		expect(out.get("a")).toEqual(["top1", "recentActive", "recentUpdate"]);
	});
});

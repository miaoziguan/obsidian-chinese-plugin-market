import { describe, it, expect } from "vitest";
import {
	scorePlugin,
	scoreAllPlugins,
	DEFAULT_WEIGHTS,
	type ScoringInput,
} from "./engine";
import type { PluginInfo } from "../translator";
import type { SignalId } from "../smart-signal";

function fakePlugin(id: string, downloads: number): PluginInfo {
	return {
		id,
		name: id,
		author: { name: "x" },
		category: "cat",
		description: "",
		downloads,
		updated: Date.now(),
	} as unknown as PluginInfo;
}

describe("scorePlugin", () => {
	it("返回 0-100 之间的整数", () => {
		const input: ScoringInput = {
			plugin: fakePlugin("a", 1000),
			downloadsPercentile: 0.5,
			recentActive: true,
			trendingScore: 0.3,
			userAffinityScore: 0.5,
			maxDownloads: 10000,
		};
		const s = scorePlugin(input);
		expect(s).toBeGreaterThanOrEqual(0);
		expect(s).toBeLessThanOrEqual(100);
		expect(Number.isInteger(s)).toBe(true);
	});

	it("userAffinityScore 缺失时按 0 处理（降级安全）", () => {
		const base: ScoringInput = {
			plugin: fakePlugin("a", 1000),
			downloadsPercentile: 0.5,
			recentActive: true,
			maxDownloads: 10000,
		};
		const withAff = scorePlugin({ ...base, userAffinityScore: 0.8 });
		const withoutAff = scorePlugin({ ...base, userAffinityScore: undefined });
		// 有亲和度分应更高（其他维度相同）
		expect(withAff).toBeGreaterThan(withoutAff);
		expect(withoutAff).toBeGreaterThanOrEqual(0);
	});

	it("各维度单调：下载量越高分越高", () => {
		const mk = (d: number) =>
			scorePlugin({
				plugin: fakePlugin("a", d),
				downloadsPercentile: 1,
				recentActive: false,
				maxDownloads: 100000,
			});
		expect(mk(90000)).toBeGreaterThan(mk(1000));
	});

	it("权重为 0 时 userAffinity 不影响结果", () => {
		const input: ScoringInput = {
			plugin: fakePlugin("a", 1000),
			downloadsPercentile: 0.5,
			recentActive: true,
			userAffinityScore: 1,
			maxDownloads: 10000,
		};
		const w = { ...DEFAULT_WEIGHTS, userAffinity: 0 };
		const a = scorePlugin(input, w);
		const b = scorePlugin({ ...input, userAffinityScore: 0 }, w);
		expect(a).toBe(b);
	});
});

describe("scoreAllPlugins", () => {
	const plugins = [fakePlugin("p1", 9000), fakePlugin("p2", 300), fakePlugin("p3", 100)];
	const smartSignals = new Map<string, SignalId[]>([
		["p1", ["recentActive"]],
		["p2", []],
		["p3", ["recentActive"]],
	]);
	const trendingScores = new Map<string, number>([
		["p1", 0.9],
		["p2", 0.1],
		["p3", 0.0],
	]);

	it("未传 userAffinity 时退化为无个性化（不抛错、分数在 0-100）", () => {
		const scores = scoreAllPlugins(plugins, { smartSignals, trendingScores });
		expect(scores.size).toBe(3);
		for (const s of scores.values()) {
			expect(s).toBeGreaterThanOrEqual(0);
			expect(s).toBeLessThanOrEqual(100);
		}
	});

	it("下载量最高的插件得分最高（无个性化时由客观信号主导）", () => {
		const scores = scoreAllPlugins(plugins, { smartSignals, trendingScores });
		expect(scores.get("p1")!).toBeGreaterThan(scores.get("p3")!);
	});

	it("传入 userAffinity 会提升对应插件分数", () => {
		const none = scoreAllPlugins(plugins, { smartSignals, trendingScores });
		const withAff = scoreAllPlugins(plugins, {
			smartSignals,
			trendingScores,
			userAffinity: new Map([["p3", 1]]),
		});
		// p3（原最低下载）因亲和度满分会显著升高
		expect(withAff.get("p3")!).toBeGreaterThan(none.get("p3")!);
	});

	it("空插件列表返回空 Map", () => {
		const scores = scoreAllPlugins([], { smartSignals: new Map() });
		expect(scores.size).toBe(0);
	});
});

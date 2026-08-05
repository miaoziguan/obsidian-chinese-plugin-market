import { describe, it, expect } from "vitest";
import { computeSmartSignals } from "./smart-signal";
import type { PluginInfo } from "./translator";

function P(over: Partial<PluginInfo> & { id: string }): PluginInfo {
	return { name: over.id, description: "", author: "", ...over };
}

const NOW = Date.now();
const DAY = 86400000;

describe("computeSmartSignals", () => {
	it("空列表返回空 Map", () => {
		expect(computeSmartSignals([]).size).toBe(0);
	});

	it("Top 5% 高下载量插件标为 Top 5%", () => {
		// 21 插件：top5Cut = ceil(21*0.05)=2，第二高下载量落入 top5
		const plugins: PluginInfo[] = [P({ id: "top0", downloads: 2000 })];
		plugins.push(P({ id: "a", downloads: 1000 }));
		for (let i = 0; i < 19; i++) plugins.push(P({ id: `lo${i}`, downloads: 10 }));
		const r = computeSmartSignals(plugins);
		// top0 gets top1, a (index 1) gets top5
		expect(r.get("a")).toBeTruthy();
		expect(r.get("a")!.some((s) => s === "top5")).toBe(true);
		expect(r.get("lo1")).toBeFalsy(); // top10Cut=3，索引 3 开始不标信号
	});

	it("Top 1% 超头部插件不重复标 Top 5%", () => {
		const many: PluginInfo[] = [];
		for (let i = 0; i < 99; i++) many.push(P({ id: `lo${i}`, downloads: 1 }));
		many.push(P({ id: "top", downloads: 1000 }));
		const r = computeSmartSignals(many);
		const sigs = r.get("top");
		expect(sigs).toBeTruthy();
		// 应只标注 Top 1%，不重复 Top 5%
		expect(sigs!.filter((s) => s.includes("5")).length).toBe(0);
	});

	it("近期活跃：90 天内更新的插件标为「近期活跃」", () => {
		const plugins = [
			P({ id: "recent", downloads: 10, updated: NOW - 30 * DAY }),
			P({ id: "stale", downloads: 10, updated: NOW - 200 * DAY }),
			P({ id: "noUpdate", downloads: 10 }),
		];
		const r = computeSmartSignals(plugins);
		expect(r.get("recent")).toBeTruthy();
		expect(r.get("recent")!.includes("recentActive")).toBe(true);
		expect(r.get("stale")).toBeFalsy();
		expect(r.get("noUpdate")).toBeFalsy();
	});

	it("热门 + 近期活跃可共存，最多 2 个信号", () => {
		const plugins: PluginInfo[] = [];
		for (let i = 0; i < 10; i++) plugins.push(P({ id: `lo${i}`, downloads: 1 }));
		plugins.push(P({ id: "hot", downloads: 1000, updated: NOW - 30 * DAY }));
		const r = computeSmartSignals(plugins);
		const sigs = r.get("hot");
		expect(sigs).toBeTruthy();
		expect(sigs!.length).toBeLessThanOrEqual(2);
	});
});

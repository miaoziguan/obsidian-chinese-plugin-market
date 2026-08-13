import { describe, it, expect, vi, afterEach } from "vitest";
import { TrendingEngine, DEFAULT_TRENDING_CONFIG, type TrendSnapshot } from "@domain/recommend/trending";
import type { PluginStat } from "@domain/catalog/stats";

const HOUR = 3600_000;
const DAY = 86_400_000;

function statsMap(entries: Record<string, number>): Map<string, PluginStat> {
	const m = new Map<string, PluginStat>();
	for (const [id, downloads] of Object.entries(entries)) m.set(id, { downloads });
	return m;
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TrendingEngine.updateWithStats（采样去重）", () => {
	it("首次摄入新增采样点并返回 true", () => {
		const e = new TrendingEngine();
		expect(e.updateWithStats(statsMap({ a: 100 }))).toBe(true);
		expect(e.isEmpty()).toBe(false);
	});

	it("最小间隔内的密集刷新不新增采样点（返回 false），只跟进最新下载量", () => {
		let now = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const e = new TrendingEngine();
		expect(e.updateWithStats(statsMap({ a: 100 }))).toBe(true);
		now += 5_000; // 5 秒后再次刷新
		expect(e.updateWithStats(statsMap({ a: 150 }))).toBe(false);
		// 最新值被跟进（体现在 lastSampleStats）
		expect(e.lastSampleStats().get("a")?.downloads).toBe(150);
	});

	it("超过最小间隔后新增采样点", () => {
		let now = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const e = new TrendingEngine();
		e.updateWithStats(statsMap({ a: 100 }));
		now += 7 * HOUR; // 超过默认最小间隔（6h）
		expect(e.updateWithStats(statsMap({ a: 200 }))).toBe(true);
	});
});

describe("TrendingEngine.trendingScore", () => {
	it("采样不足 2 个返回中性分", () => {
		const e = new TrendingEngine();
		e.updateWithStats(statsMap({ a: 100 }));
		expect(e.trendingScore("a")).toBe(DEFAULT_TRENDING_CONFIG.defaultScore);
		expect(e.trendingScore("unknown")).toBe(DEFAULT_TRENDING_CONFIG.defaultScore);
	});

	it("时距过短（同会话两次刷新）返回中性分，不产生天文数字增速", () => {
		const t0 = 1_000_000_000_000;
		const e = new TrendingEngine();
		// 通过 load 注入 30 分钟间隔的两个点（updateWithStats 正常路径不会产生）
		e.load({ a: [
			{ downloads: 100, timestamp: t0 },
			{ downloads: 10_000, timestamp: t0 + 30 * 60_000 },
		] });
		expect(e.trendingScore("a")).toBe(DEFAULT_TRENDING_CONFIG.defaultScore);
	});

	it("正常跨天采样按日均增速计分（log 压缩）", () => {
		const t0 = 1_000_000_000_000;
		const e = new TrendingEngine();
		e.load({ a: [
			{ downloads: 1, timestamp: t0 },
			{ downloads: 1000, timestamp: t0 + DAY },
		] });
		// 日均增速 999 → log10(1000)/4 = 0.75
		expect(e.trendingScore("a")).toBeCloseTo(0.75, 5);
	});

	it("velocityWindowDays 窗口生效：窗口外旧采样被排除", () => {
		const t0 = 1_000_000_000_000;
		const e = new TrendingEngine({ velocityWindowDays: 7 });
		// 仅有一个 30 天前的旧点 + 最新点 → 窗口内不足 2 个 → 中性分
		e.load({ a: [
			{ downloads: 1, timestamp: t0 - 30 * DAY },
			{ downloads: 100_000, timestamp: t0 },
		] });
		expect(e.trendingScore("a")).toBe(DEFAULT_TRENDING_CONFIG.defaultScore);
	});
});

describe("TrendingEngine 持久化（serialize/load）", () => {
	it("serialize → load 往返一致", () => {
		let now = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const e = new TrendingEngine();
		e.updateWithStats(statsMap({ a: 100, b: 50 }));
		now += 2 * HOUR;
		e.updateWithStats(statsMap({ a: 300 }));

		const dump = e.serialize();
		const e2 = new TrendingEngine();
		e2.load(dump);
		expect(e2.serialize()).toEqual(dump);
	});

	it("load 静默跳过非法条目", () => {
		const e = new TrendingEngine();
		e.load({
			ok: [{ downloads: 1, timestamp: 1 }],
			bad1: "not-an-array" as unknown as TrendSnapshot[],
			bad2: [{ downloads: NaN, timestamp: 1 } as TrendSnapshot],
		});
		expect(e.lastSampleStats().has("ok")).toBe(true);
		expect(e.lastSampleStats().has("bad1")).toBe(false);
		expect(e.lastSampleStats().has("bad2")).toBe(false);
	});

	it("load(null/undefined) 不崩溃且清空历史", () => {
		const e = new TrendingEngine();
		e.updateWithStats(statsMap({ a: 1 }));
		e.load(null);
		expect(e.isEmpty()).toBe(true);
	});
});

describe("TrendingEngine.lastSampleStats（H1 velocity 基线）", () => {
	it("返回各插件最近一次采样的下载量（供 computeSmartSignals 做 prevStats）", () => {
		let now = 1_000_000_000_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		const e = new TrendingEngine();
		e.updateWithStats(statsMap({ a: 100, b: 200 }));
		now += 2 * HOUR;
		e.updateWithStats(statsMap({ a: 500 }));

		const prev = e.lastSampleStats();
		expect(prev.get("a")?.downloads).toBe(500);
		expect(prev.get("b")?.downloads).toBe(200);
		// 与当前值不同的基线才能算出非零 velocity（自比恒 0 的回归防线）
		expect(prev.get("a")?.downloads).not.toBe(0);
	});

	it("空历史返回空 Map", () => {
		expect(new TrendingEngine().lastSampleStats().size).toBe(0);
	});
});

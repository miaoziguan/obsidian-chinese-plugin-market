import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginStat } from "@domain/catalog/stats";
import { TrendingEngine, DEFAULT_TRENDING_CONFIG, type TrendSnapshot } from "./trending";

const DAY = 86_400_000;
let NOW = 1_000_000_000_000;
let spy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
	spy = vi.spyOn(Date, "now").mockImplementation(() => NOW);
});
afterEach(() => {
	spy.mockRestore();
});

const stats = (entries: [string, number][]): Map<string, PluginStat> =>
	new Map(entries.map(([id, downloads]) => [id, { downloads } as PluginStat]));

describe("构造函数", () => {
	it("默认配置 = DEFAULT_TRENDING_CONFIG", () => {
		const e = new TrendingEngine();
		expect(e["config"]).toEqual(DEFAULT_TRENDING_CONFIG);
	});
	it("部分覆盖配置", () => {
		const e = new TrendingEngine({ maxSnapshots: 5, defaultScore: 0.3 });
		expect(e["config"].maxSnapshots).toBe(5);
		expect(e["config"].defaultScore).toBe(0.3);
		expect(e["config"].velocityWindowDays).toBe(DEFAULT_TRENDING_CONFIG.velocityWindowDays);
	});
});

describe("updateWithStats 采样", () => {
	it("空 stats → 未新增点（返回 false）", () => {
		const e = new TrendingEngine();
		expect(e.updateWithStats(new Map())).toBe(false);
		expect(e.isEmpty()).toBe(true);
	});

	it("新插件 → 新增采样点（返回 true），下载量入历史", () => {
		const e = new TrendingEngine();
		expect(e.updateWithStats(stats([["a", 100]]))).toBe(true);
		const snaps = e.getSnapshots("a")!;
		expect(snaps).toHaveLength(1);
		expect(snaps[0]).toEqual({ downloads: 100, timestamp: NOW });
	});

	it("间隔内刷新 → 仅跟进更大下载量、不新增点（返回 false）", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]));
		// 不推进时间：now - last.timestamp = 0 < 默认 6h 间隔
		expect(e.updateWithStats(stats([["a", 150]]))).toBe(false);
		expect(e.getSnapshots("a")).toHaveLength(1);
		expect(e.getSnapshots("a")![0].downloads).toBe(150);
		// 下载量未变小时不更新
		expect(e.updateWithStats(stats([["a", 50]]))).toBe(false);
		expect(e.getSnapshots("a")![0].downloads).toBe(150);
	});

	it("超出间隔 → 追加新采样点（返回 true）", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]));
		NOW += 7 * 60 * 60 * 1000; // 7h > 6h
		expect(e.updateWithStats(stats([["a", 150]]))).toBe(true);
		expect(e.getSnapshots("a")).toHaveLength(2);
	});

	it("自定义 intervalMs 控制采样密度", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]), 1);
		NOW += 2; // 超过 1ms 间隔
		expect(e.updateWithStats(stats([["a", 120]]), 1)).toBe(true);
		expect(e.getSnapshots("a")).toHaveLength(2);
	});

	it("maxSnapshots 裁剪：超出保留最近 N 个", () => {
		const e = new TrendingEngine({ maxSnapshots: 2 });
		for (let i = 0; i < 3; i++) {
			NOW += 2;
			e.updateWithStats(stats([["a", 100 + i]]), 1);
		}
		expect(e.getSnapshots("a")).toHaveLength(2);
		expect(e.getSnapshots("a")![0].downloads).toBe(101); // 最旧(100)被 shift
	});
});

describe("trendingScore 评分", () => {
	it("无历史 / 不足 2 点 → 默认分", () => {
		const e = new TrendingEngine();
		expect(e.trendingScore("x")).toBe(0.5);
		e.updateWithStats(stats([["a", 100]]));
		expect(e.trendingScore("a")).toBe(0.5);
	});

	it("时距低于 MIN_SPAN → 默认分", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]), 1);
		NOW += 1000; // 间隔仅 1s
		e.updateWithStats(stats([["a", 150]]), 1);
		expect(e.trendingScore("a")).toBe(0.5);
	});

	it("窗口外旧点被剔除 → 窗口内不足 2 点 → 默认分", () => {
		const e = new TrendingEngine({ velocityWindowDays: 10 });
		e.updateWithStats(stats([["a", 100]]), 1); // T0
		NOW += 20 * DAY;
		e.updateWithStats(stats([["a", 200]]), 1); // T0+20d，窗口(10d)外只剩最新点
		expect(e.trendingScore("a")).toBe(0.5);
	});

	it("正常增速 → log10 压缩（0~1）", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]), 1); // T0
		NOW += 10 * DAY;
		e.updateWithStats(stats([["a", 200]]), 1); // T0+10d, delta 100
		// vpd = 100/10 = 10 → log10(11)/4 ≈ 0.2603
		expect(e.trendingScore("a")).toBeCloseTo(0.2603, 3);
	});

	it("下载量下降 → 增速封底 0", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 200]]), 1);
		NOW += 10 * DAY;
		e.updateWithStats(stats([["a", 100]]), 1);
		expect(e.trendingScore("a")).toBe(0);
	});

	it("极高增速 → 封顶 1", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 0]]), 1);
		NOW += 10 * DAY;
		e.updateWithStats(stats([["a", 100000]]), 1); // vpd=10000 → log10(10001)/4>1
		expect(e.trendingScore("a")).toBe(1);
	});

	it("defaultScore 可配置", () => {
		const e = new TrendingEngine({ defaultScore: 0.3 });
		expect(e.trendingScore("a")).toBe(0.3);
	});
});

describe("batchTrendingScores Z-score 归一化", () => {
	it("空列表 → 空 Map", () => {
		expect(new TrendingEngine().batchTrendingScores([]).size).toBe(0);
	});

	it("单插件（stddev=0）→ 统一 0.5", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]), 1); // 仅 1 点，raw=默认分
		const out = e.batchTrendingScores(["a"]);
		expect(out.get("a")).toBe(0.5);
	});

	it("增速差异 → sigmoid 映射，低增速归一化更低", () => {
		const e = new TrendingEngine();
		// a：10 天涨 10（低速）
		e.updateWithStats(stats([["a", 100]]), 1);
		NOW += 10 * DAY;
		e.updateWithStats(stats([["a", 110]]), 1);
		// b：10 天涨 200（高速）
		e.updateWithStats(stats([["b", 0]]), 1);
		NOW += 10 * DAY;
		e.updateWithStats(stats([["b", 200]]), 1);

		const out = e.batchTrendingScores(["a", "b"]);
		expect(out.get("a")!).toBeCloseTo(0.269, 2);
		expect(out.get("b")!).toBeCloseTo(0.731, 2);
		expect(out.get("a")!).toBeLessThan(out.get("b")!);
	});
});

describe("持久化与运维方法", () => {
	it("serialize / load 往返 + 非法数据静默跳过", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]), 1);
		NOW += 2 * DAY;
		e.updateWithStats(stats([["a", 150]]), 1);
		const data = e.serialize();

		const e2 = new TrendingEngine();
		e2.load(data);
		expect(e2.getSnapshots("a")).toHaveLength(2);

		// 非法：非对象 / null / 非数组字段 / 条目字段非法
		const e3 = new TrendingEngine();
		e3.load(undefined);
		e3.load(null);
		e3.load({ a: "notarray" as unknown as TrendSnapshot[] });
		e3.load({ a: [{ downloads: "x" }] as unknown as TrendSnapshot[] });
		expect(e3.isEmpty()).toBe(true);
	});

	it("load 按 maxSnapshots 截断到最近 N 个", () => {
		const e = new TrendingEngine({ maxSnapshots: 1 });
		e.load({
			a: [
				{ downloads: 1, timestamp: 1 },
				{ downloads: 2, timestamp: 2 },
				{ downloads: 3, timestamp: 3 },
			],
		});
		expect(e.getSnapshots("a")).toHaveLength(1);
		expect(e.getSnapshots("a")![0].downloads).toBe(3);
	});

	it("lastSampleStats 返回每插件最新下载量", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]), 1);
		NOW += 2;
		e.updateWithStats(stats([["a", 150]]), 1);
		expect(e.lastSampleStats().get("a")).toEqual({ downloads: 150 });
	});

	it("prune 删除过期点 / 全过期删整条 / 无过期不改", () => {
		const e = new TrendingEngine();
		const T0 = NOW;
		e.updateWithStats(stats([["a", 100]]), 1);
		NOW = T0 + 5 * DAY;
		e.updateWithStats(stats([["a", 200]]), 1);
		// 当前 NOW = T0+5d，keepDays=4 → cutoff=T0+1d，最新点保留、最旧点(T0)过期
		expect(e.prune(4)).toBe(true);
		expect(e.getSnapshots("a")).toHaveLength(1);

		// 全过期
		NOW = T0 + 100 * DAY;
		expect(e.prune(5)).toBe(true);
		expect(e.isEmpty()).toBe(true);

		// 无过期（keepDays 很大）→ 未改动
		const e2 = new TrendingEngine();
		e2.updateWithStats(stats([["a", 100]]), 1);
		expect(e2.prune(365)).toBe(false);
	});

	it("reset 清空历史", () => {
		const e = new TrendingEngine();
		e.updateWithStats(stats([["a", 100]]), 1);
		e.reset();
		expect(e.isEmpty()).toBe(true);
	});
});

import { describe, it, expect } from "vitest";

import {
	recencyFactor,
	popularityFactor,
	qualityFactor,
	applyQualityFactors,
} from "@domain/search/quality";

const DAY = 86400000;
const NOW = Date.UTC(2026, 8, 18); // 固定时钟（2026-09-18），不依赖真实时间

describe("recencyFactor（新鲜度）", () => {
	it("缺失/非法 updated → 中性 1.0（无 stats 数据不受罚）", () => {
		expect(recencyFactor(undefined, NOW)).toBe(1.0);
		expect(recencyFactor(NaN, NOW)).toBe(1.0);
		expect(recencyFactor(-1, NOW)).toBe(1.0);
	});

	it("未来时间戳（时钟偏差/脏数据）→ 1.0，不吃隐性加成", () => {
		// 负 age 若不挡会得 exp(正数)>1，等于奖励脏数据
		expect(recencyFactor(NOW + 10 * DAY, NOW)).toBe(1.0);
		expect(recencyFactor(NOW, NOW)).toBe(1.0); // age=0 边界
	});

	it("渐变区间（0~118d）单调递减且不超过 1.0", () => {
		const f7 = recencyFactor(NOW - 7 * DAY, NOW);
		const f60 = recencyFactor(NOW - 60 * DAY, NOW);
		const f110 = recencyFactor(NOW - 110 * DAY, NOW);
		expect(f7).toBeGreaterThan(f60);
		expect(f60).toBeGreaterThan(f110);
		expect(f7).toBeLessThanOrEqual(1.0);
		expect(f110).toBeGreaterThan(0.85);
	});

	it("触底点 ≈ -ln(0.85)·730 ≈ 119d，更老一律钉在下限 0.85 不再区分", () => {
		expect(recencyFactor(NOW - 119 * DAY, NOW)).toBe(0.85);
		expect(recencyFactor(NOW - 200 * DAY, NOW)).toBe(0.85);
		expect(recencyFactor(NOW - 1500 * DAY, NOW)).toBe(0.85); // 弃坑 4 年 == 弃坑半年
	});
});

describe("popularityFactor（热度）", () => {
	const MAX = 4_000_000;

	it("缺失/非正 downloads → 中性 1.0", () => {
		expect(popularityFactor(undefined, MAX)).toBe(1.0);
		expect(popularityFactor(0, MAX)).toBe(1.0);
		expect(popularityFactor(NaN, MAX)).toBe(1.0);
		expect(popularityFactor(-5, MAX)).toBe(1.0);
	});

	it("maxDl 非正（全表都没有 stats）→ 1.0，防 log10(1)=0 除零", () => {
		expect(popularityFactor(1000, 0)).toBe(1.0);
		expect(popularityFactor(1000, -1)).toBe(1.0);
	});

	it("dl = maxDl → 封顶 1.15", () => {
		expect(popularityFactor(MAX, MAX)).toBeCloseTo(1.15, 10);
	});

	it("dl > maxDl（数据来源不一致的防御）→ 钳到封顶，不超发", () => {
		expect(popularityFactor(MAX * 10, MAX)).toBeCloseTo(1.15, 10);
	});

	it("log 刻度压缩贫富差：50 倍下载差只换来 <2 倍加成差（线性刻度会是 50 倍）", () => {
		const mid = popularityFactor(2_000_000, MAX); // maxDl 的 50%
		const low = popularityFactor(40_000, MAX); // maxDl 的 1%
		expect(mid).toBeGreaterThan(low);
		expect((mid - 1) / (low - 1)).toBeLessThan(2);
	});
});

describe("qualityFactor / applyQualityFactors（融合分接线）", () => {
	it("qualityFactor：插件缺失 → 中性 1.0", () => {
		expect(qualityFactor(undefined, 1000, NOW)).toBe(1.0);
	});

	it("纯函数：不改入参 fused Map，返回新对象", () => {
		const fused = new Map([["a", 0.02]]);
		const out = applyQualityFactors(fused, [{ id: "a", downloads: 1000, updated: NOW - 400 * DAY }], NOW);
		expect(fused.get("a")).toBe(0.02); // 原 Map 未动
		expect(out).not.toBe(fused);
		expect(out.get("a")!).toBeLessThan(0.02); // 老插件被降权
	});

	it("fused 里有 id 但 plugins 列表查不到 → 中性 1.0，不抛错", () => {
		const out = applyQualityFactors(new Map([["ghost", 0.01]]), [], NOW);
		expect(out.get("ghost")).toBe(0.01);
	});

	it("分差小（RRF 相邻名次量级）→ 新而热的翻到前面", () => {
		const fresh = { id: "fresh", downloads: 4_000_000, updated: NOW - DAY }; // ≈1.0×1.15
		const stale = { id: "stale", downloads: 100, updated: NOW - 1500 * DAY }; // ≈0.85×1.05
		const out = applyQualityFactors(new Map([["stale", 0.0164], ["fresh", 0.0161]]), [fresh, stale], NOW);
		expect(out.get("fresh")!).toBeGreaterThan(out.get("stale")!);
	});

	it("分差大（相关性碾压）→ 翻不动：热门永远压不过相关", () => {
		const fresh = { id: "fresh", downloads: 4_000_000, updated: NOW - DAY };
		const stale = { id: "stale", downloads: 100, updated: NOW - 1500 * DAY };
		// stale 分高 86%：质量带宽 [0.85,1.15]（最大 35% 相对差）不足以翻盘
		const out = applyQualityFactors(new Map([["stale", 0.03], ["fresh", 0.0161]]), [fresh, stale], NOW);
		expect(out.get("stale")!).toBeGreaterThan(out.get("fresh")!);
	});

	it("maxDownloads 就地从列表求出，不依赖外部预计算", () => {
		// 列表内最大 dl=1000：dl=1000 者拿满 1.15，dl=1 者接近 1.0
		const plugins = [
			{ id: "top", downloads: 1000, updated: NOW },
			{ id: "small", downloads: 1, updated: NOW },
		];
		const out = applyQualityFactors(new Map([["top", 0.01], ["small", 0.01]]), plugins, NOW);
		expect(out.get("top")!).toBeCloseTo(0.01 * 1.15, 10);
		expect(out.get("small")!).toBeLessThan(out.get("top")!);
	});
});

/**
 * 趋势引擎（Trending Engine）
 *
 * 不只看绝对下载量，还要看近期增长速度（velocity）。
 * 为什么：绝对下载量偏向老牌插件，无法给新兴优质插件曝光机会。
 *
 * 算法：Z-score 归一化的时间加权下载增速。
 *
 * 使用方式：
 *   const engine = new TrendingEngine();
 *   engine.updateWithStats(statsMap); // 每次拉取新 stats 时更新
 *   const score = engine.trendingScore("obsidian-dataview"); // 0-1 分数
 *
 * 历史采样通过 serialize()/load() 跨会话持久化（由 Plugin 层落盘）；
 * 同会话内的密集刷新由最小采样间隔去重，避免毫秒级时距把增速除成天文数字。
 */

import type { PluginStat } from "../stats";

// ───────── 内部类型 ─────────

export interface TrendSnapshot {
	downloads: number;
	timestamp: number;
}

const MS_PER_DAY = 86400000;
/** 两次采样的最小间隔：更密集的刷新只更新最新值，不新增采样点 */
const MIN_SAMPLE_INTERVAL_MS = 60 * 60 * 1000;
/** 最早/最新采样点的最小时距：低于此时距增速噪声过大，返回中性分 */
const MIN_SPAN_MS = 60 * 60 * 1000;

// ───────── 配置 ─────────

export interface TrendingConfig {
	/** 最多保留的采样点数（默认 30） */
	maxSnapshots: number;
	/** 计算速度的窗口天数：只用窗口内的采样点计算增速 */
	velocityWindowDays: number;
	/** 新插件起点保护：若无历史数据，给一个中性基础分 */
	defaultScore: number;
}

export const DEFAULT_TRENDING_CONFIG: TrendingConfig = {
	maxSnapshots: 30,
	velocityWindowDays: 30,
	defaultScore: 0.5,
};

// ───────── 引擎 ─────────

export class TrendingEngine {
	private history = new Map<string, TrendSnapshot[]>();
	private config: TrendingConfig;

	constructor(config: Partial<TrendingConfig> = {}) {
		this.config = { ...DEFAULT_TRENDING_CONFIG, ...config };
	}

	/**
	 * 摄入最新的 stats 数据，追加为一次采样点。
	 * 距上一采样点不足最小间隔时仅更新最新下载量（不新增点），
	 * 避免同会话内几秒间隔的两次刷新产生毫秒级时距的伪增速。
	 *
	 * @returns 是否新增了采样点（供调用方决定是否落盘历史）
	 */
	updateWithStats(stats: Map<string, PluginStat>): boolean {
		const now = Date.now();
		let added = false;

		for (const [id, stat] of stats) {
			const snapshots = this.history.get(id) ?? [];
			const last = snapshots[snapshots.length - 1];

			if (last && now - last.timestamp < MIN_SAMPLE_INTERVAL_MS) {
				// 采样过密：只跟进最新下载量，时间轴不前移
				if (stat.downloads > last.downloads) last.downloads = stat.downloads;
				this.history.set(id, snapshots);
				continue;
			}

			snapshots.push({ downloads: stat.downloads, timestamp: now });
			added = true;

			// 保留最近 N 个
			while (snapshots.length > this.config.maxSnapshots) {
				snapshots.shift();
			}

			this.history.set(id, snapshots);
		}

		return added;
	}

	/**
	 * 计算某个插件的趋势分数（0-1）。
	 *
	 * 核心思路：
	 *   1. 在 velocityWindowDays 窗口内取最早采样点与最新采样点的差值
	 *   2. 差值越大 = 增长越快，分数越高
	 *   3. 用 Z-score 在整个插件集合中归一化（μ=0.5 中心化）
	 *
	 * @returns 0-1 分数，越高代表增长越快
	 */
	trendingScore(pluginId: string): number {
		const snapshots = this.history.get(pluginId);
		if (!snapshots || snapshots.length < 2) return this.config.defaultScore;

		const latest = snapshots[snapshots.length - 1];
		// 只用窗口内的采样点（修复：velocityWindowDays 曾从未被读取）
		const cutoff = latest.timestamp - this.config.velocityWindowDays * MS_PER_DAY;
		const windowed = snapshots.filter((s) => s.timestamp >= cutoff);
		if (windowed.length < 2) return this.config.defaultScore;

		const earliest = windowed[0];
		const spanMs = latest.timestamp - earliest.timestamp;
		// 时距过短（如同会话两次刷新）：增速噪声过大，返回中性分
		if (spanMs < MIN_SPAN_MS) return this.config.defaultScore;

		// 日均增速
		const daysDiff = spanMs / MS_PER_DAY;
		const downloadsDelta = latest.downloads - earliest.downloads;
		const velocityPerDay = Math.max(0, downloadsDelta / daysDiff);

		// 对数值压缩长尾
		return Math.min(1, Math.log10(velocityPerDay + 1) / 4); // log10 上限约 4（9999 增速）
	}

	/**
	 * 批量计算趋势分。
	 */
	batchTrendingScores(allPluginIds: string[]): Map<string, number> {
		const out = new Map<string, number>();
		const rawScores = new Map<string, number>();

		// 第一遍：计算原始分数
		for (const id of allPluginIds) {
			const raw = this.trendingScore(id);
			rawScores.set(id, raw);
		}

		// 第二遍：Z-score 归一化到 0-1（μ=0.5 中心化）
		const values = [...rawScores.values()];
		if (values.length === 0) return out;

		const mean = values.reduce((a, b) => a + b, 0) / values.length;
		const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
		const stddev = Math.sqrt(variance);

		for (const [id, raw] of rawScores) {
			if (stddev === 0) {
				out.set(id, 0.5); // 无差异，统一 0.5
			} else {
				const z = (raw - mean) / stddev;
				// sigmoid Z-score 映射到 0-1
				out.set(id, 1 / (1 + Math.exp(-z)));
			}
		}

		return out;
	}

	/** 历史是否为空（用于判断是否需要从持久化恢复） */
	isEmpty(): boolean {
		return this.history.size === 0;
	}

	/**
	 * 各插件最近一次采样的下载量快照（id → { downloads }）。
	 * 用途：在 updateWithStats() 之前调用，作为 velocity 计算的「上一轮基线」。
	 * 修复 H1：曾用合并后的当前 statsMap 自比，自己减自己永远得 0，
	 * velocityRising 信号从未点亮过。
	 */
	lastSampleStats(): Map<string, PluginStat> {
		const out = new Map<string, PluginStat>();
		for (const [id, snaps] of this.history) {
			const last = snaps[snaps.length - 1];
			if (last) out.set(id, { downloads: last.downloads });
		}
		return out;
	}

	/** 导出可持久化的历史采样（id → 采样点数组） */
	serialize(): Record<string, TrendSnapshot[]> {
		const out: Record<string, TrendSnapshot[]> = {};
		for (const [id, snaps] of this.history) out[id] = snaps;
		return out;
	}

	/** 从持久化数据恢复历史采样（非法条目静默跳过） */
	load(data: Record<string, TrendSnapshot[]> | null | undefined): void {
		this.history.clear();
		if (!data || typeof data !== "object") return;
		for (const [id, snaps] of Object.entries(data)) {
			if (!Array.isArray(snaps)) continue;
			const clean = snaps.filter(
				(s): s is TrendSnapshot =>
					!!s &&
					typeof s.downloads === "number" && Number.isFinite(s.downloads) &&
					typeof s.timestamp === "number" && Number.isFinite(s.timestamp)
			);
			if (clean.length > 0) {
				this.history.set(id, clean.slice(-this.config.maxSnapshots));
			}
		}
	}

	/** 清空所有趋势历史 */
	reset(): void {
		this.history.clear();
	}
}

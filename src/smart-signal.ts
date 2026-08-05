import type { PluginInfo } from "./translator";
import type { PluginStat } from "./stats";

/** 离线可算的轻量推荐信号 ID（无需 AI Key 即可展示，降低 AI 差异化价值感知门槛） */
export type SignalId = "top1" | "top5" | "hot10" | "recentActive" | "velocityRising";

const RECENT_ACTIVE_DAYS = 90;
const MS_PER_DAY = 86400000;

/**
 * 基于全量插件离线数据计算每个插件的轻量推荐信号。
 *
 * 信号种类（互斥 vs 共存）：
 *   - 下载量分位：top1 / top5 / hot10（互斥，取最高桶）
 *   - 近期活跃：recentActive（90 天内更新，可与分位共存）
 *   - 趋势上升：velocityRising（近期增速 Z-score > 0.5σ，可与以上共存）
 *   - 每插件最多 3 个信号
 *
 * @param plugins 全量插件列表
 * @param prevStats 上一轮 stats 采样（用于计算 velocity），可选
 */
export function computeSmartSignals(
	plugins: PluginInfo[],
	prevStats?: Map<string, PluginStat>
): Map<string, SignalId[]> {
	const out = new Map<string, SignalId[]>();
	if (plugins.length === 0) return out;

	// 按下载量排序
	const sorted = [...plugins].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
	const total = sorted.length;
	const top1Cut = Math.max(1, Math.ceil(total * 0.01));
	const top5Cut = Math.max(1, Math.ceil(total * 0.05));
	const top10Cut = Math.max(1, Math.ceil(total * 0.10));
	const now = Date.now();
	const activeThreshold = now - RECENT_ACTIVE_DAYS * MS_PER_DAY;

	// 预计算 velocity 分布（如果提供了历史 stats）
	let velocityScores: Map<string, number> | null = null;
	if (prevStats && prevStats.size > 0) {
		velocityScores = computeVelocityScores(plugins, prevStats);
	}

	for (let i = 0; i < total; i++) {
		const p = sorted[i];
		const sigs: SignalId[] = [];

		// 分位标（互斥）
		if (i < top1Cut) {
			sigs.push("top1");
		} else if (i < top5Cut) {
			sigs.push("top5");
		} else if (i < top10Cut) {
			sigs.push("hot10");
		}

		// 近期活跃（可共存）
		if (sigs.length < 2 && p.updated != null && p.updated > activeThreshold) {
			sigs.push("recentActive");
		}

		// 趋势上升（可共存）
		if (sigs.length < 3 && velocityScores) {
			const vs = velocityScores.get(p.id) ?? 0;
			if (vs > 0.5) {
				sigs.push("velocityRising");
			}
		}

		if (sigs.length > 0) out.set(p.id, sigs);
	}

	return out;
}

/**
 * 基于历史 stats 和当前数据计算每个插件的下载增速（velocity），
 * 归一化到 0-1。
 */
function computeVelocityScores(
	plugins: PluginInfo[],
	prevStats: Map<string, PluginStat>
): Map<string, number> {
	const out = new Map<string, number>();

	// 计算所有插件的原始 velocity
	const velocities: number[] = [];
	for (const p of plugins) {
		const prev = prevStats.get(p.id);
		const curr = p.downloads ?? 0;
		if (prev && curr > prev.downloads) {
			const v = curr - prev.downloads;
			// 对数值压缩：log10(v+1)，上限 ~9999
			const logV = Math.log10(v + 1);
			velocities.push(logV);
			out.set(p.id, logV);
		}
	}

	if (velocities.length === 0) return out;

	// Z-score 归一化
	const mean = velocities.reduce((a, b) => a + b, 0) / velocities.length;
	const variance =
		velocities.reduce((sum, v) => sum + (v - mean) ** 2, 0) / velocities.length;
	const stddev = Math.sqrt(variance);

	for (const [id, logV] of out) {
		if (stddev === 0) {
			out.set(id, 0); // 无差异，均分 0
		} else {
			const z = (logV - mean) / stddev;
			// sigmoid 映射到 0-1
			out.set(id, 1 / (1 + Math.exp(-z)));
		}
	}

	return out;
}

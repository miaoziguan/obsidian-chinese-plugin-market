/**
 * 统一推荐评分引擎（Recommendation Scoring Engine）
 *
 * 将分散在 smart-signal、recommend/similar、sort、analytics 的多个信号
 * 融合为统一的 0-100 评分，供列表排序、Featured 刷新、Detail drawer 推荐使用。
 *
 * 设计原则：
 *   - 纯函数，零副作用，可独立单测
 *   - 所有信号源通过参数注入，不直接读取全局状态
 *   - 权重可配置，默认值基于产品直觉 + 可后续 A/B 校准
 *   - 渐进式兼容：现有 sort/popular 管道不受影响，新增 "recommended" 排序模式
 */

import type { PluginInfo } from "../translator";
import type { SignalId } from "../smart-signal";

// ───────── 配置 ─────────

export interface RecommendWeights {
	/** 下载量分位得分权重 */
	downloadsPercentile: number;
	/** 近期活跃（90 天内有更新）权重 */
	recentActivity: number;
	/** 趋势速度（近期下载增速）权重 */
	trendingVelocity: number;
	/** 用户行为亲和度权重 */
	userAffinity: number;
	/** 下载量原始值对数归一化权重 */
	downloadsLog: number;
}

export const DEFAULT_WEIGHTS: RecommendWeights = {
	downloadsPercentile: 0.30,
	recentActivity: 0.10,
	trendingVelocity: 0.20,
	userAffinity: 0.10,
	downloadsLog: 0.30,
};

export interface ScoringInput {
	plugin: PluginInfo;
	/** 下载量排名分位（0-1），由 computeSmartSignals 或外部提供 */
	downloadsPercentile: number;
	/** 是否在过去 90 天内有更新 */
	recentActive: boolean;
	/** 趋势速度分（0-1），由 trending.ts 计算 */
	trendingScore?: number;
	/** 用户行为亲和度分（0-1），由 analytics 的偏好计算 */
	userAffinityScore?: number;
	/** 全量插件中的最高下载量（用于对数归一化） */
	maxDownloads: number;
}

// ───────── 核心评分函数 ─────────

/**
 * 计算单个插件的综合推荐评分。
 *
 * 各维度：
 *   - downloadsPercentile: 直接用分位（0-1），天然归一化
 *   - downloadsLog: log10(downloads+1) / log10(maxDownloads+1)，对数平滑长尾
 *   - recentActivity: 布尔转 0/1
 *   - trendingVelocity: 0-1 归一化
 *   - userAffinity: 0-1 归一化
 *
 * 返回 0-100 整数分。
 */
export function scorePlugin(input: ScoringInput, weights: RecommendWeights = DEFAULT_WEIGHTS): number {
	const { plugin, downloadsPercentile, recentActive, trendingScore, userAffinityScore, maxDownloads } = input;

	// 下载量对数归一化
	const logNorm = maxDownloads > 0
		? Math.log10((plugin.downloads ?? 0) + 1) / Math.log10((maxDownloads) + 1)
		: 0;

	const raw =
		weights.downloadsPercentile * clamp(downloadsPercentile) +
		weights.downloadsLog * logNorm +
		weights.recentActivity * (recentActive ? 1 : 0) +
		weights.trendingVelocity * clamp(trendingScore ?? 0) +
		weights.userAffinity * clamp(userAffinityScore ?? 0);

	return Math.round(clamp(raw) * 100);
}

/**
 * 批量评分：为全量插件生成 id → score 映射。
 * 使用 Map 而非 Record，便于性能敏感场景（如虚拟滚动）的快速查找。
 */
export function scoreAllPlugins(
	plugins: PluginInfo[],
	options: {
		smartSignals: Map<string, SignalId[]>;
		trendingScores?: Map<string, number>;
		userAffinity?: Map<string, number>;
		weights?: RecommendWeights;
	}
): Map<string, number> {
	const { smartSignals, trendingScores, userAffinity, weights = DEFAULT_WEIGHTS } = options;

	const maxDl = Math.max(1, ...plugins.map((p) => p.downloads ?? 0));
	const out = new Map<string, number>();

	// 预计算下载量分位（避免重复排序）
	const sorted = [...plugins].sort((a, b) => (b.downloads ?? 0) - (a.downloads ?? 0));
	const total = sorted.length;
	const dlRank = new Map<string, number>();
	for (let i = 0; i < total; i++) {
		dlRank.set(sorted[i].id, i);
	}

	for (const plugin of plugins) {
		const signals = smartSignals.get(plugin.id) ?? [];
		const hasRecent = signals.includes("recentActive");
		const rank = dlRank.get(plugin.id) ?? total;
		const dlPercentile = total > 0 ? Math.max(0, 1 - rank / total) : 0;

		out.set(plugin.id, scorePlugin({
			plugin,
			downloadsPercentile: dlPercentile,
			recentActive: hasRecent,
			trendingScore: trendingScores?.get(plugin.id),
			userAffinityScore: userAffinity?.get(plugin.id),
			maxDownloads: maxDl,
		}, weights));
	}

	return out;
}

// ───────── 辅助 ─────────

function clamp(v: number): number {
	return Math.max(0, Math.min(1, v));
}

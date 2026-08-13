/**
 * 插件维护健康度（对齐竞品 better-store 的 health.ts）
 *
 * 仅基于官方 stats 的 `updated`（最近更新时间戳）做三档判定，
 * 不依赖 GitHub API（stars / open issues / releases 不在范围内）。
 *
 * 判定逻辑（纯函数、可单测）：
 *   距今天数 <= 120  → healthy（活跃）
 *   距今天数 <= 365  → aging（维护放缓）
 *   否则            → at-risk（停更风险）
 *
 * 与竞品差异：竞品额外用「近一年 release >= 3」把 aging 拉回 healthy；
 * 该信号需 GitHub API，本实现按用户决策与之对齐——仅用 updated，
 * 不做 release 救回，保持零网络依赖。
 */

export type HealthLevel = "healthy" | "aging" | "at-risk";

export interface Health {
	level: HealthLevel;
	/** 人类可读原因，供 tooltip 展示 */
	reason: string;
}

const DAY = 86_400_000;
const HEALTHY_DAYS = 120;
const AGING_DAYS = 365;

/**
 * 评估插件维护健康度。
 * @param updated     最近更新时间戳（ms）；0 / undefined / 非法视为未知，归为 aging
 * @param now         当前时间戳（ms），便于测试注入
 * @param healthyDays 「活跃」阈值天数（默认 120）
 * @param agingDays   「风险」阈值天数（默认 365）
 */
export function assessHealth(
	updated: number | undefined,
	now: number = Date.now(),
	healthyDays: number = HEALTHY_DAYS,
	agingDays: number = AGING_DAYS,
): Health {
	if (!updated || !Number.isFinite(updated) || updated <= 0) {
		return { level: "aging", reason: "更新时间未知" };
	}
	const days = (now - updated) / DAY;
	if (days <= healthyDays) {
		return { level: "healthy", reason: `最近更新于 ${Math.max(0, Math.round(days))} 天前` };
	}
	if (days <= agingDays) {
		return { level: "aging", reason: `已 ${Math.round(days)} 天未更新` };
	}
	return { level: "at-risk", reason: `已 ${Math.round(days / 30)} 个月未更新` };
}

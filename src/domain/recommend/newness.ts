/**
 * 插件「新」标记判定（对齐竞品 better-store 的 newness.ts）。
 *
 * 纯函数：给定插件首次见时间戳与当前时间，判定是否落在「新」窗口内。
 * 语义：seenAt > 0（有真实首次见时间）且距 now ≤ windowDays 天 → 新。
 * 0 = 基线旧插件（存量老插件不报「新」）；缺失/非法 → 不是新。
 */

const DEFAULT_WINDOW_DAYS = 30;
const DAY = 86_400_000;

/**
 * 判定插件是否应标「新」。
 * @param seenAt       首次见时间戳（ms）；0 = 基线旧插件，undefined = 未知
 * @param now          当前时间戳（ms），便于测试注入
 * @param windowDays   新窗口天数（默认 30）
 */
export function isNewPlugin(seenAt: number | undefined, now: number = Date.now(), windowDays: number = DEFAULT_WINDOW_DAYS): boolean {
	if (seenAt == null || !Number.isFinite(seenAt) || seenAt <= 0) return false;
	return now - seenAt <= windowDays * DAY;
}

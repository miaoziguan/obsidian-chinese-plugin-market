/**
 * 网格列数计算（零 DOM 依赖的纯函数，便于单元测试）。
 *
 * 架构重构（原生滚动 + content-visibility）后，offsets / 可见窗口 / translateY /
 * 总高 / 置底吸附等动态测量数学已全部弃用，仅保留由可用宽度推列数的纯计算。
 */

/**
 * 由可用宽度与单卡最小宽度计算列数（至少 1 列）。
 * @param availW 已扣除网格左右内边距的可用宽度（px）
 * @param minCardW 单张卡片最小宽度（px）
 */
export function computeColCount(availW: number, minCardW: number): number {
	const w = Math.max(1, availW);
	return Math.max(1, Math.floor(w / Math.max(1, minCardW)));
}

/**
 * 真·虚拟滚动纯函数（零 DOM 依赖，便于单元测试）。
 *
 * 早期「动态行高 + 滚动锚定」机制被废弃后，本模块一度仅剩 computeColCount。
 * #3 复活为完整虚拟滚动数学：在固定卡片高度（.pt-card height: var(--pt-card-h)）前提下，
 * 由 scrollTop / clientHeight / rowH / colCount 推 [start, end) 窗口索引，并算出
 * 上/下 spacer 高度，供 view-render.ts 仅渲染窗口内卡片（DOM 节点数稳定在 ≤250）。
 */

/** 由可用宽度与单卡最小宽度计算列数（至少 1 列）。 */
export function computeColCount(availW: number, minCardW: number): number {
	const w = Math.max(1, availW);
	// #7: 窄屏兜底。手机竖屏（如 iPhone SE 375px）可用宽 < 480 时强制单列满宽，
	// 避免纯数学推导挤出 1.5 列导致卡片横向撕裂。
	if (w < 480) return 1;
	return Math.max(1, Math.floor(w / Math.max(1, minCardW)));
}

/** 虚拟窗口索引区间 [start, end)（含上下预取余量），clamp 到 [0, total)。 */
export interface VirtualWindow {
	/** 窗口首卡片索引（含预取） */
	start: number;
	/** 窗口末卡片索引（不含，含预取） */
	end: number;
	/** 窗口首行号 */
	firstRow: number;
	/** 窗口末行号 */
	lastRow: number;
	/** 总行数（ceil(total / colCount)） */
	totalRows: number;
}

/**
 * 由滚动位置与视口尺寸推可见窗口索引区间 [start, end)。
 * @param scrollTop 视口已滚动距离（px）
 * @param clientHeight 视口可见高度（px）
 * @param rowH 单行高度 = 卡片高 + 行距（px）
 * @param colCount 列数
 * @param total 列表总卡片数
 * @param prefetchRows 上下各预取多少行（防快速滚动边缘空白）
 */
export function computeWindowRange(
	scrollTop: number,
	clientHeight: number,
	rowH: number,
	colCount: number,
	total: number,
	prefetchRows: number,
): VirtualWindow {
	const safeRowH = Math.max(1, rowH);
	const safeCols = Math.max(1, colCount);
	const totalRows = Math.ceil(total / safeCols);
	const visibleRows = Math.ceil(clientHeight / safeRowH) + prefetchRows * 2;
	// firstRow 既要 ≥0，也要保证整窗落在列表内（滚到底时不能溢出末行）
	const maxFirstRow = Math.max(0, totalRows - visibleRows);
	let firstRow = Math.max(0, Math.floor(scrollTop / safeRowH) - prefetchRows);
	firstRow = Math.min(firstRow, maxFirstRow);
	const lastRow = firstRow + visibleRows - 1;
	const start = Math.min(total, firstRow * safeCols);
	const end = Math.min(total, (lastRow + 1) * safeCols);
	return { start, end, firstRow, lastRow, totalRows };
}

/** 上/下 spacer 高度（px），撑出整张列表总高，使窗口化卡片落在正确滚动位置。 */
export interface SpacerHeights {
	top: number;
	bottom: number;
}

/**
 * 由窗口区间推上/下 spacer 高度。
 * top = firstRow * rowH；bottom = (totalRows - 1 - lastRow) * rowH。
 * 三层高度之和恒等于 totalRows * rowH，滚动条比例精确。
 */
export function computeSpacerHeights(
	win: VirtualWindow,
	rowH: number,
): SpacerHeights {
	const safeRowH = Math.max(1, rowH);
	return {
		top: win.firstRow * safeRowH,
		bottom: Math.max(0, (win.totalRows - 1 - win.lastRow) * safeRowH),
	};
}

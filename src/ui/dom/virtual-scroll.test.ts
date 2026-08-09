/**
 * virtual-scroll.ts 单元测试。
 * 覆盖：列数计算（宽/窄/边界/防御）。
 */
import { describe, it, expect } from "vitest";
import { computeColCount, computeWindowRange, computeSpacerHeights } from "@ui/dom/virtual-scroll";

describe("computeColCount", () => {
	it("宽容器多列", () => {
		expect(computeColCount(1000, 320)).toBe(3);
	});
	it("整除边界", () => {
		expect(computeColCount(640, 320)).toBe(2);
	});
	it("窄容器至少 1 列", () => {
		expect(computeColCount(300, 320)).toBe(1);
	});
	it("0/负宽度至少 1 列", () => {
		expect(computeColCount(0, 320)).toBe(1);
		expect(computeColCount(-50, 320)).toBe(1);
	});
	it("#7 窄屏(<480px)强制单列，手机竖屏不挤出 1.5 列", () => {
		expect(computeColCount(375, 320)).toBe(1); // iPhone SE
		expect(computeColCount(360, 320)).toBe(1); // 安卓竖屏
		expect(computeColCount(479, 320)).toBe(1);
		// 边界：≥480 走数学列数（480/320 向下取整仍为 1 列，属正常）
		expect(computeColCount(480, 320)).toBe(1);
		expect(computeColCount(640, 320)).toBe(2);
	});
});

describe("computeWindowRange", () => {
	// 5600 项，3 列，行高 236px，视口高 800px，预取 1 行
	const total = 5600;
	const cols = 3;
	const rowH = 236;
	const vpH = 800;
	it("顶部：从首行起，含预取余量", () => {
		const w = computeWindowRange(0, vpH, rowH, cols, total, 1);
		expect(w.firstRow).toBe(0);
		expect(w.start).toBe(0);
		// 可见行数 = ceil(800/236)=4，+ 预取 2 行 = 6 行 → 末行 5
		expect(w.lastRow).toBe(5);
		expect(w.end).toBe(6 * cols);
		expect(w.totalRows).toBe(Math.ceil(total / cols));
	});
	it("中段：scrollTop 居中时窗口正确平移", () => {
		const scrollTop = 236 * 100; // 第 100 行处
		const w = computeWindowRange(scrollTop, vpH, rowH, cols, total, 2);
		expect(w.firstRow).toBe(100 - 2);
		expect(w.start).toBe((100 - 2) * cols);
	});
	it("底部：clamp 到列表末行，不越界", () => {
		const scrollTop = 1e9; // 滚到底
		const w = computeWindowRange(scrollTop, vpH, rowH, cols, total, 1);
		expect(w.lastRow).toBe(Math.ceil(total / cols) - 1);
		expect(w.end).toBe(total);
		expect(w.start).toBeLessThan(total);
	});
	it("窗口跨度在合理上限（≤250 卡），满足 DOM 节点数约束", () => {
		const w = computeWindowRange(0, vpH, rowH, cols, total, 5);
		const span = w.end - w.start;
		expect(span).toBeLessThanOrEqual(250);
	});
});

describe("computeSpacerHeights", () => {
	it("top = firstRow*rowH，bottom = (totalRows-1-lastRow)*rowH，三者之和恒为 totalRows*rowH", () => {
		const w = computeWindowRange(236 * 50, 800, 236, 3, 5600, 2);
		const rowH = 236;
		const { top, bottom } = computeSpacerHeights(w, rowH);
		const sum = top + bottom + (w.lastRow - w.firstRow + 1) * rowH;
		expect(sum).toBe(w.totalRows * rowH);
		expect(top).toBe(w.firstRow * rowH);
		expect(bottom).toBe((w.totalRows - 1 - w.lastRow) * rowH);
	});
	it("顶部（firstRow=0）时 top=0", () => {
		const w = computeWindowRange(0, 800, 236, 3, 5600, 1);
		const { top } = computeSpacerHeights(w, 236);
		expect(top).toBe(0);
	});
});

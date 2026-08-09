/**
 * virtual-scroll.ts 单元测试。
 * 覆盖：列数计算（宽/窄/边界/防御）。
 */
import { describe, it, expect } from "vitest";
import { computeColCount } from "@ui/dom/virtual-scroll";

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

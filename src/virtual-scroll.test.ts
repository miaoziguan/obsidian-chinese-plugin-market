/**
 * virtual-scroll.ts 单元测试。
 * 覆盖：列数计算（宽/窄/边界/防御）。
 */
import { describe, it, expect } from "vitest";
import { computeColCount } from "./virtual-scroll";

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
});

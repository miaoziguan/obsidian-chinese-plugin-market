import { describe, it, expect } from "vitest";
import { compareVersion } from "@shared/version";

/**
 * 回归：compareVersion 被「可更新检测」与「依赖最低版本判定」两处共用，
 * 任何语义变化都会同时影响两者，故把边界钉死。
 */
describe("compareVersion", () => {
	it("忽略 v 前缀", () => {
		expect(compareVersion("v1.2.3", "1.2.3")).toBe(0);
	});
	it("按数值段比较：1.10 > 1.9（不能退化成字符串比较）", () => {
		expect(compareVersion("1.10.0", "1.9.0")).toBe(1);
		expect(compareVersion("1.9.0", "1.10.0")).toBe(-1);
	});
	it("段数不等时缺位补 0", () => {
		expect(compareVersion("1.2", "1.2.0")).toBe(0);
		expect(compareVersion("1.2", "1.2.1")).toBe(-1);
	});
	it("非数字段按 0 处理，不抛错", () => {
		expect(compareVersion("1.x", "1.0")).toBe(0);
		expect(compareVersion("", "1.0")).toBe(-1);
	});
});

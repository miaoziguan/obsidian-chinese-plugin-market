import { describe, it, expect } from "vitest";
import { isNewPlugin } from "@domain/recommend/newness";

const NOW = 1_000_000_000_000;
const DAY = 86_400_000;

describe("isNewPlugin", () => {
	it("seenAt > 0 且近窗口内 → 新", () => {
		expect(isNewPlugin(NOW - 3 * DAY, NOW)).toBe(true);
	});
	it("窗口边界（恰 30 天）→ 新", () => {
		expect(isNewPlugin(NOW - 30 * DAY, NOW)).toBe(true);
	});
	it("超窗口 → 非新", () => {
		expect(isNewPlugin(NOW - 31 * DAY, NOW)).toBe(false);
	});
	it("0 = 基线旧插件 → 非新", () => {
		expect(isNewPlugin(0, NOW)).toBe(false);
	});
	it("缺失 / 非法 → 非新", () => {
		expect(isNewPlugin(undefined, NOW)).toBe(false);
		expect(isNewPlugin(NaN, NOW)).toBe(false);
	});
	it("可自定义窗口天数", () => {
		expect(isNewPlugin(NOW - 7 * DAY, NOW, 7)).toBe(true);
		expect(isNewPlugin(NOW - 8 * DAY, NOW, 7)).toBe(false);
	});
});

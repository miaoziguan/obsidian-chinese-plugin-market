import { describe, it, expect } from "vitest";
import { VIEW_TYPE, LAYOUT, SEARCH_MODES, PLUGINS_URL } from "./constants";

describe("constants 全局常量集中处（审计 P2-4）", () => {
	it("VIEW_TYPE 为视图唯一标识", () => {
		expect(VIEW_TYPE).toBe("chinese-plugin-market-view");
	});

	it("LAYOUT 关键交互常量保持合理取值", () => {
		expect(LAYOUT.SEARCH_DEBOUNCE_MS).toBe(200);
		expect(LAYOUT.LIST_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
		expect(LAYOUT.MIN_CARD_W).toBeGreaterThan(0);
		expect(LAYOUT.OVERSCAN).toBeGreaterThanOrEqual(0);
	});

	it("SEARCH_MODES 顺序即 Tab 顺序，含 keyword / local / ai 三种", () => {
		expect(SEARCH_MODES.map((m) => m.id)).toEqual(["keyword", "local", "ai"]);
	});

	it("PLUGINS_URL 指向官方社区插件清单", () => {
		expect(PLUGINS_URL).toContain("community-plugins.json");
	});
});

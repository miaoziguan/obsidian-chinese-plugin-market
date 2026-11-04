import { describe, it, expect } from "vitest";
import { InsightCache, INSIGHT_SCHEMA_VERSION } from "./insight-cache";
import type { InsightEntry, InsightRawData } from "./insight-cache";

const valid = (text: string): InsightEntry => ({ v: INSIGHT_SCHEMA_VERSION, text });

describe("isValidEntry（经 load 间接覆盖）", () => {
	it("合法条目被接纳；旧版/缺 text/非对象/null 一律丢弃", () => {
		const c = new InsightCache();
		c.load({
			pluginInsights: {
				ok: valid("概述"),
				oldVersion: { v: 1, text: "旧" },
				noText: { v: INSIGHT_SCHEMA_VERSION } as InsightEntry,
				badText: { v: INSIGHT_SCHEMA_VERSION, text: 123 } as unknown as InsightEntry,
				primitive: "not-object" as unknown as InsightEntry,
				nil: null as unknown as InsightEntry,
			},
		});
		expect(c.getInsight("ok")).toBe("概述");
		expect(c.getInsight("oldVersion")).toBeUndefined();
		expect(c.getInsight("noText")).toBeUndefined();
		expect(c.getInsight("badText")).toBeUndefined();
		expect(c.getInsight("primitive")).toBeUndefined();
		expect(c.getInsight("nil")).toBeUndefined();
	});

	it("compareInsights 同样按 schema 过滤", () => {
		const c = new InsightCache();
		c.load({
			compareInsights: {
				ok: valid("对比"),
				old: { v: 0, text: "旧" },
				bad: 42 as unknown as InsightEntry,
			},
		});
		expect(c.getCompareInsight(["ok"])).toBe("对比");
		expect(c.getCompareInsight(["old"])).toBeUndefined();
		expect(c.getCompareInsight(["bad"])).toBeUndefined();
	});

	it("load 缺字段 → 对应缓存保持不变（不误清空）", () => {
		const c = new InsightCache();
		c.setInsight("p", "概述");
		c.setCompareInsight(["x"], "对比");
		c.load({});
		expect(c.getInsight("p")).toBe("概述");
		expect(c.getCompareInsight(["x"])).toBe("对比");
	});

	it("load 传入空对象字段 → 清空该侧缓存", () => {
		const c = new InsightCache();
		c.setInsight("p", "概述");
		c.load({ pluginInsights: {} });
		expect(c.getInsight("p")).toBeUndefined();
	});

	it("原始 string 格式（最早版本）被丢弃", () => {
		const c = new InsightCache();
		c.load({ pluginInsights: { legacy: "纯文本" } as unknown as InsightRawData["pluginInsights"] });
		expect(c.getInsight("legacy")).toBeUndefined();
	});
});

describe("插件功能洞察读写", () => {
	it("get 未命中 → undefined；set 后带上 schema 版本", () => {
		const c = new InsightCache();
		expect(c.getInsight("p")).toBeUndefined();
		c.setInsight("p", "功能概述");
		expect(c.getInsight("p")).toBe("功能概述");
		expect(c.toJSON().pluginInsights.p).toEqual({ v: INSIGHT_SCHEMA_VERSION, text: "功能概述" });
	});

	it("set 覆盖同名", () => {
		const c = new InsightCache();
		c.setInsight("p", "旧");
		c.setInsight("p", "新");
		expect(c.getInsight("p")).toBe("新");
	});
});

describe("对比洞察键与读写", () => {
	it("compareKey 排序，不修改入参数组", () => {
		const c = new InsightCache();
		const ids = ["b", "a", "c"];
		expect(c.compareKey(ids)).toBe("a|b|c");
		expect(ids).toEqual(["b", "a", "c"]);
	});

	it("顺序无关：{A,B} 与 {B,A} 命中同一缓存", () => {
		const c = new InsightCache();
		c.setCompareInsight(["a", "b"], "深度对比");
		expect(c.getCompareInsight(["b", "a"])).toBe("深度对比");
		expect(c.getCompareInsight(["a", "b"])).toBe("深度对比");
		expect(c.getCompareInsight(["a"])).toBeUndefined();
	});

	it("toJSON 两套缓存均可导出，load 往返一致", () => {
		const c = new InsightCache();
		c.setInsight("p", "概述");
		c.setCompareInsight(["x", "y"], "对比");
		const dump = c.toJSON();
		expect(Object.keys(dump).sort()).toEqual(["compareInsights", "pluginInsights"]);

		const c2 = new InsightCache();
		c2.load(dump);
		expect(c2.getInsight("p")).toBe("概述");
		expect(c2.getCompareInsight(["y", "x"])).toBe("对比");
	});
});

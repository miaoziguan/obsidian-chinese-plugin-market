import { describe, it, expect } from "vitest";
import {
	parseStatsJson,
	formatDownloads,
	formatUpdated,
	PLUGIN_STATS_URL,
	type PluginStat,
} from "./stats";

describe("parseStatsJson", () => {
	it("解析真实 obsidian-releases 结构", () => {
		const json = {
			"plugin-a": { downloads: 123456, versions: { "1.0.0": 100 }, updated: 1730419200000 },
			"plugin-b": { downloads: 12, updated: 1700000000000 },
		};
		const map = parseStatsJson(json);
		expect(map.size).toBe(2);
		expect(map.get("plugin-a")).toEqual({ downloads: 123456, updated: 1730419200000 });
		expect(map.get("plugin-b")).toEqual({ downloads: 12, updated: 1700000000000 });
	});

	it("缺失 downloads 的条目被跳过", () => {
		const json = {
			"no-dl": { versions: { "1.0.0": 1 } },
			ok: { downloads: 5 },
		};
		const map = parseStatsJson(json);
		expect(map.size).toBe(1);
		expect(map.has("ok")).toBe(true);
	});

	it("updated 非数字则降级忽略", () => {
		const json = { x: { downloads: 10, updated: "2024-11" } };
		const map = parseStatsJson(json);
		const v = map.get("x") as PluginStat | undefined;
		expect(v?.downloads).toBe(10);
		expect(v?.updated).toBeUndefined();
	});

	it("顶层非对象返回空 Map（降级）", () => {
		expect(parseStatsJson(null).size).toBe(0);
		expect(parseStatsJson([]).size).toBe(0);
		expect(parseStatsJson("str").size).toBe(0);
	});
});

describe("formatDownloads", () => {
	it("<1000 返回原数字", () => {
		expect(formatDownloads(0)).toBe("0");
		expect(formatDownloads(999)).toBe("999");
	});
	it("k 量级", () => {
		expect(formatDownloads(1000)).toBe("1k");
		expect(formatDownloads(1200)).toBe("1.2k");
		expect(formatDownloads(12345)).toBe("12.3k");
	});
	it("M 量级", () => {
		expect(formatDownloads(1000000)).toBe("1M");
		expect(formatDownloads(1200000)).toBe("1.2M");
	});
	it("非有限数降级为 0", () => {
		expect(formatDownloads(NaN)).toBe("0");
	});
	it("负数降级为 0（L4 回归：数据源异常不显示 -0.5k）", () => {
		expect(formatDownloads(-1)).toBe("0");
		expect(formatDownloads(-500000)).toBe("0");
	});
});

describe("formatUpdated", () => {
	it("UTC ms 时间戳格式化为 YYYY-MM", () => {
		expect(formatUpdated(Date.UTC(2024, 10, 1))).toBe("2024-11");
		expect(formatUpdated(Date.UTC(2023, 0, 15))).toBe("2023-01");
	});
	it("缺失或非有限返回空串", () => {
		expect(formatUpdated(undefined)).toBe("");
		expect(formatUpdated(NaN)).toBe("");
	});
});

describe("PLUGIN_STATS_URL", () => {
	it("指向 community-plugin-stats.json", () => {
		expect(PLUGIN_STATS_URL).toContain("community-plugin-stats.json");
	});
});

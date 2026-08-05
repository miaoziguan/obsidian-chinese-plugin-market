import { describe, it, expect } from "vitest";
import { pickLang, makeT, formatRelativeTime, STRINGS, type I18nKey } from "./i18n";

describe("i18n（界面文案，纯中文）", () => {
	it("所有 key 都具备 zh 文案", () => {
		const keys = Object.keys(STRINGS) as I18nKey[];
		expect(keys.length).toBeGreaterThan(0);
		for (const k of keys) {
			expect(STRINGS[k].zh, `key ${k} 缺 zh`).toBeTruthy();
		}
	});

	it("pickLang 返回 zh 文案", () => {
		expect(pickLang("app.search")).toBe("插件搜索");
	});

	it("makeT 返回中文文案", () => {
		const t = makeT();
		expect(t("settings.title")).toBe("插件搜索设置");
	});

	it("缺失的 key 回退到 key 本身（不抛错）", () => {
		expect(pickLang("not.exist.key" as I18nKey)).toBe("not.exist.key");
	});

	it("pickLang 支持 {n} 插值变量", () => {
		expect(pickLang("time.minutesAgo", { n: "5" })).toBe("5 分钟前");
	});

	it("pickLang 多变量同时替换", () => {
		// coverage.trend 含 {prev}{arrow}{delta} 三个占位
		const out = pickLang("settings.dashboard.coverage.trend", {
			prev: "v1.0",
			arrow: "↑",
			delta: "2.1",
		});
		expect(out).toBe(" 较 v1.0 ↑2.1pp");
	});

	it("缺失变量时保留原始占位符（不抛错）", () => {
		expect(pickLang("time.minutesAgo")).toBe("{n} 分钟前");
	});

	it("makeT 同样支持插值", () => {
		const t = makeT();
		expect(t("time.daysAgo", { n: "2" })).toBe("2 天前");
	});
});

describe("formatRelativeTime（上次更新相对时间）", () => {
	const t = makeT();

	it("非正时间戳返回空串", () => {
		expect(formatRelativeTime(0, 1_000_000, t)).toBe("");
		expect(formatRelativeTime(-5, 1_000_000, t)).toBe("");
	});

	it("1 分钟内显示「刚刚」", () => {
		expect(formatRelativeTime(1_000_000, 1_000_000 + 30_000, t)).toBe("刚刚");
	});

	it("时钟回拨（now<ts）也显示「刚刚」，不抛错", () => {
		expect(formatRelativeTime(2_000_000, 1_000_000, t)).toBe("刚刚");
	});

	it("N 分钟前（<60min）", () => {
		const ts = 1_000_000;
		const now = ts + 5 * 60_000; // +5min
		expect(formatRelativeTime(ts, now, t)).toBe("5 分钟前");
	});

	it("N 小时前（<24h）", () => {
		const ts = 1_000_000;
		const now = ts + 3 * 60 * 60_000; // +3h
		expect(formatRelativeTime(ts, now, t)).toBe("3 小时前");
	});

	it("N 天前（>=24h）", () => {
		const ts = 1_000_000;
		const now = ts + 2 * 24 * 60 * 60_000; // +2d
		expect(formatRelativeTime(ts, now, t)).toBe("2 天前");
	});
});

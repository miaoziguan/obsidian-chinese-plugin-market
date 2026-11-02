import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 几个未驱动的小方法/取值器：
 * hasStaleInstalledRecord（211-215）、journalEnabled（236-238）、
 * getDefaultReviewFolder（248-250）、getRecommendedIds（468-470）、
 * loadPluginListCache（473-475）。
 * 既有 plugin*.test.ts 没覆盖，错误模式是「跨会话卸载的插件没补写卸载时间、
 * 评测台账开关判定错、推荐/列表缓存读取路径断」。
 */

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		settings: { embeddingRemoteHost: "https://huggingface.co" },
		storage: { loadPluginListCache: vi.fn(async () => null) },
		_data: {} as Record<string, unknown>,
		recommendedIds: new Set<string>(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("hasStaleInstalledRecord：跨会话卸载检测（211-215）", () => {
	it("存在「记着仍安装、实际已不在」→ true", () => {
		const plugin = makePlugin();
		const base = { entries: { a: { currentlyInstalled: true }, b: { currentlyInstalled: true } } } as any;
		expect((plugin as AnyPlugin).hasStaleInstalledRecord(base, new Set(["a"]))).toBe(true);
	});

	it("所有记录都在 installed 中 → false", () => {
		const plugin = makePlugin();
		const base = { entries: { a: { currentlyInstalled: true } } } as any;
		expect((plugin as AnyPlugin).hasStaleInstalledRecord(base, new Set(["a"]))).toBe(false);
	});

	it("无 currentlyInstalled 记录 → false", () => {
		const plugin = makePlugin();
		const base = { entries: { a: { currentlyInstalled: false } } } as any;
		expect((plugin as AnyPlugin).hasStaleInstalledRecord(base, new Set())).toBe(false);
	});
});

describe("评测台账 / 推荐取值器（236-250 / 468-470）", () => {
	it("journalEnabled 默认开启", () => {
		const plugin = makePlugin();
		expect((plugin as AnyPlugin).journalEnabled()).toBe(true);
	});

	it("getDefaultReviewFolder 落在私有 reviews 目录", () => {
		const plugin = makePlugin();
		expect((plugin as AnyPlugin).getDefaultReviewFolder()).toBe(
			".obsidian/plugins/chinese-plugin-market/reviews",
		);
	});

	it("getRecommendedIds 返回推荐集合", () => {
		const set = new Set(["x", "y"]);
		const plugin = makePlugin({ recommendedIds: set });
		expect((plugin as AnyPlugin).getRecommendedIds()).toBe(set);
	});
});

describe("loadPluginListCache：委托 storage（473-475）", () => {
	it("回传 storage 结果，并以 _data 作为迁移回退入参", async () => {
		const cached = [{ id: "x", name: "X" }];
		const plugin = makePlugin({ storage: { loadPluginListCache: vi.fn(async () => cached) }, _data: { foo: 1 } });
		const r = await (plugin as AnyPlugin).loadPluginListCache();
		expect(r).toBe(cached);
		expect((plugin as AnyPlugin).storage.loadPluginListCache).toHaveBeenCalledWith({ foo: 1 });
	});
});

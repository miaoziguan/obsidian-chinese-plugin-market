import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notice } from "obsidian";
import type { PluginInfo, TranslateResult } from "./translator";
import { makeMockContext, makeMockPlugin } from "./test-utils";
import {
	reportNewPluginDelta,
	buildSearchIndex,
	mergeStatsIntoPlugins,
	mirrorConfig,
} from "./view-data";

// 隔离 Notice：断言「增量加载计数」触发的提示文案与计数，不依赖真实 toast。
vi.mock("obsidian", async () => {
	const actual = await vi.importActual<typeof import("obsidian")>("obsidian");
	return { ...actual, Notice: vi.fn() };
});

function mkPlugin(id: string): PluginInfo {
	return { id, name: id, description: `${id} desc`, author: "au" };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("reportNewPluginDelta 增量加载计数", () => {
	it("首次加载（seen 为空）只播种 seenPluginIds，不弹提示", () => {
		const seenPluginIds = new Set<string>();
		const plugin = makeMockPlugin({ settings: {} });
		const ctx = makeMockContext({
			plugin,
			seenPluginIds,
			t: (k: string) => String(k),
		});
		const current = [mkPlugin("a"), mkPlugin("b")];

		reportNewPluginDelta(ctx, current, {});

		expect(Notice).not.toHaveBeenCalled();
		expect([...ctx.seenPluginIds]).toEqual(["a", "b"]);
	});

	it("空数据：current 为空时不弹提示、seen 仍为空", () => {
		const seenPluginIds = new Set<string>();
		const plugin = makeMockPlugin({ settings: {} });
		const ctx = makeMockContext({
			plugin,
			seenPluginIds,
			t: (k: string) => String(k),
		});

		reportNewPluginDelta(ctx, [], {});

		expect(Notice).not.toHaveBeenCalled();
		expect(ctx.seenPluginIds.size).toBe(0);
	});

	it("二次加载出现 2 个新插件（1 已译 / 1 未译）按计数弹提示并更新 seen", () => {
		const seenPluginIds = new Set<string>(["a"]);
		const plugin = makeMockPlugin({ settings: {} });
		const ctx = makeMockContext({
			plugin,
			seenPluginIds,
			t: (k: string) => String(k),
		});
		const current = [
			mkPlugin("a"),
			mkPlugin("b"), // 新：已译（source=online）
			mkPlugin("c"), // 新：未译（source=original）
		];
		const results: Record<string, TranslateResult> = {
			b: { source: "online" } as TranslateResult,
			c: { source: "original" } as TranslateResult,
		};

		reportNewPluginDelta(ctx, current, results);

		expect(Notice).toHaveBeenCalledTimes(1);
		expect(Notice).toHaveBeenCalledWith(
			"refresh.newPlugins，refresh.newTranslated，refresh.newUntranslated"
		);
		// seen 推进为本轮全集（差量已提取，下次以本轮为基线）
		expect([...ctx.seenPluginIds].sort()).toEqual(["a", "b", "c"]);
	});
});

describe("buildSearchIndex 搜索索引构建", () => {
	it("全量：以 plugins + translatedResults 重建索引", () => {
		const ctx = makeMockContext({
			plugins: [mkPlugin("a"), mkPlugin("b")],
			translatedResults: { a: { source: "online" } as TranslateResult },
			searchIndex: new Map<string, string>(),
		});

		buildSearchIndex(ctx);

		expect(ctx.searchIndex.get("a")).toBeTypeOf("string");
		expect(ctx.searchIndex.get("b")).toBeTypeOf("string");
		expect(ctx.searchIndex.size).toBe(2);
	});

	it("空数据：plugins 为空时索引为空", () => {
		const ctx = makeMockContext({
			plugins: [],
			translatedResults: {},
			searchIndex: new Map<string, string>(),
		});

		buildSearchIndex(ctx);

		expect(ctx.searchIndex.size).toBe(0);
	});

	it("增量：仅更新给定 ids，不清空既有索引", () => {
		const ctx = makeMockContext({
			plugins: [mkPlugin("a"), mkPlugin("b")],
			translatedResults: {},
			searchIndex: new Map<string, string>([["b", "stale-b"]]),
		});

		buildSearchIndex(ctx, new Set(["a"]));

		// 既有 b 未被清空
		expect(ctx.searchIndex.get("b")).toBe("stale-b");
		// 仅 a 被增量更新
		expect(ctx.searchIndex.get("a")).toBeTypeOf("string");
	});
});

describe("mergeStatsIntoPlugins stats 合并", () => {
	it("把 statsMap 的下载量/更新时间写回 plugins，并自增 pluginsRev", () => {
		const a = mkPlugin("a");
		const ctx = makeMockContext({
			plugins: [a],
			statsMap: new Map<string, { downloads: number; updated: number }>([
				["a", { downloads: 100, updated: 123 }],
			]),
			pluginsRev: 0,
		});

		mergeStatsIntoPlugins(ctx);

		expect(a.downloads).toBe(100);
		expect(a.updated).toBe(123);
		expect(ctx.pluginsRev).toBe(1);
	});
});

describe("mirrorConfig 镜像配置投影", () => {
	it("从 settings 投影出 source / customBase", () => {
		const plugin = makeMockPlugin({
			settings: { mirrorSource: "jsdelivr", mirrorCustomBase: "https://x.test" },
		});
		const ctx = makeMockContext({ plugin, settings: plugin.settings });

		const cfg = mirrorConfig(ctx);

		expect(cfg).toEqual({ source: "jsdelivr", customBase: "https://x.test" });
	});
});

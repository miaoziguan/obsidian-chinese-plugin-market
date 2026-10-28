import { describe, it, expect, vi } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { ChinesePluginMarketView } from "@ui/view/translator-view";
import { VIEW_TYPE } from "@shared/constants";

/**
 * 随插件分发的静态清单加载器（plugin-release-dates / -chinese-ecosystem /
 * -bamboo-series / -yulin-picks / -deps / -recommend）。
 *
 * 这些方法共用同一套骨架：拼路径 → adapter.exists/read → JSON.parse →
 * 注入已打开视图并重跑列表管线 → 任何异常一律降级（catch + logger.warn）。
 *
 * 共同契约（本次锁定的核心）：
 *   1. 文件缺失：静默跳过，不抛错、不污染已有集合
 *   2. 数据损坏：同样静默降级，「锦上添花的清单」绝不能拖垮插件启动
 *   3. 数据合法：写入对应字段，并让已打开的视图立刻生效（重跑管线而非只重绘）
 */

type View = Record<string, unknown> & { renderPluginList: ReturnType<typeof vi.fn> };

/** 用原型链伪造 instanceof ChinesePluginMarketView，避免执行视图构造函数 */
function makeView(): View {
	const view = Object.create(ChinesePluginMarketView.prototype) as unknown as View;
	view.renderPluginList = vi.fn();
	return view;
}

function makePlugin(opts: { exists?: boolean; content?: string | Error; leaves?: View[] } = {}) {
	// 显式声明参数，既贴近真实 adapter 签名，也让 mock.calls 可被断言
	const adapter = {
		exists: vi.fn(async (_path: string) => opts.exists ?? true),
		read: vi.fn(async (_path: string) => {
			if (opts.content instanceof Error) throw opts.content;
			return opts.content ?? "{}";
		}),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market" },
		// 注意：源码读的是 leaf.view，不是 leaf 本身
		app: {
			vault: { adapter },
			workspace: { getLeavesOfType: () => (opts.leaves ?? []).map((v) => ({ view: v })) },
		},
	});
	return { plugin, adapter };
}

const call = (plugin: unknown, name: string) =>
	(plugin as Record<string, () => Promise<void>>)[name]();

const LOADERS = [
	"loadReleaseDates",
	"loadChineseEcosystem",
	"loadBambooSeries",
	"loadYulinPicks",
	"loadPluginDeps",
	"loadPluginRecommend",
] as const;

describe("清单加载器：文件缺失时静默跳过", () => {
	it.each(LOADERS.filter((n) => n !== "loadPluginRecommend"))(
		"%s 在文件不存在时不抛错且不做任何注入",
		async (name) => {
			const view = makeView();
			const { plugin, adapter } = makePlugin({ exists: false, leaves: [view] });
			await expect(call(plugin, name)).resolves.toBeUndefined();
			expect(adapter.read).not.toHaveBeenCalled();
			expect(view.renderPluginList).not.toHaveBeenCalled();
		},
	);

	it("loadPluginRecommend 直接尝试读取（不依赖 exists 探测），读取失败走内置兜底", async () => {
		const { plugin } = makePlugin({ content: new Error("ENOENT") });
		await call(plugin, "loadPluginRecommend");
		expect(plugin.recommendedIds.size).toBe(ChinesePluginMarketPlugin.FALLBACK_RECOMMENDED_IDS.length);
		expect(plugin.recommendedTitle).toBe(ChinesePluginMarketPlugin.FALLBACK_RECOMMENDED_TITLE);
	});
});

describe("清单加载器：数据损坏一律降级", () => {
	it.each(LOADERS)("%s 遇到非法 JSON 不抛错", async (name) => {
		const { plugin } = makePlugin({ content: "{ 这不是合法 json" });
		await expect(call(plugin, name)).resolves.toBeUndefined();
	});

	it.each(LOADERS)("%s 遇到读取异常不抛错", async (name) => {
		const { plugin } = makePlugin({ content: new Error("EACCES") });
		await expect(call(plugin, name)).resolves.toBeUndefined();
	});
});

describe("清单加载器：合法数据写入字段", () => {
	it("上线日期把「秒」换算为毫秒（否则筛选窗口全部错位）", async () => {
		const view = makeView();
		const { plugin } = makePlugin({
			content: JSON.stringify({ "obsidian-dataview": 1700000000 }),
			leaves: [view],
		});
		await call(plugin, "loadReleaseDates");
		const map = view.releaseDatesMap as Map<string, number>;
		expect(map.get("obsidian-dataview")).toBe(1700000000 * 1000);
	});

	it("中文生态清单写成集合", async () => {
		const { plugin } = makePlugin({ content: JSON.stringify({ a: true, b: true }) });
		await call(plugin, "loadChineseEcosystem");
		expect([...plugin.chineseEcoSet].sort()).toEqual(["a", "b"]);
	});

	it("竹林系列清单写成集合", async () => {
		const { plugin } = makePlugin({ content: JSON.stringify({ bamboo: true }) });
		await call(plugin, "loadBambooSeries");
		expect([...plugin.bambooSeriesSet]).toEqual(["bamboo"]);
	});

	it("羽鳞精选清单写成集合", async () => {
		const { plugin } = makePlugin({ content: JSON.stringify({ pick: true }) });
		await call(plugin, "loadYulinPicks");
		expect([...plugin.yulinPicksSet]).toEqual(["pick"]);
	});

	it("推荐清单读取标题与 id 列表", async () => {
		const { plugin } = makePlugin({
			content: JSON.stringify({ title: " 官方精选 ", ids: ["x", "y", 42] }),
		});
		await call(plugin, "loadPluginRecommend");
		expect(plugin.recommendedTitle).toBe("官方精选");
		// 非字符串 id 必须被过滤掉，否则会污染后续按 id 查询
		expect([...plugin.recommendedIds].sort()).toEqual(["x", "y"]);
	});

	it("推荐清单 ids 为空时回退内置清单（首页永远有内容）", async () => {
		const { plugin } = makePlugin({ content: JSON.stringify({ title: "空", ids: [] }) });
		await call(plugin, "loadPluginRecommend");
		expect(plugin.recommendedIds.size).toBe(ChinesePluginMarketPlugin.FALLBACK_RECOMMENDED_IDS.length);
	});

	it("依赖数据集 schema 不符时不写入（宁可没有依赖提示，也不能用错数据）", async () => {
		const { plugin } = makePlugin({ content: JSON.stringify({ hello: "world" }) });
		await call(plugin, "loadPluginDeps");
		expect(plugin.pluginDeps).toBeNull();
	});
});

describe("清单加载器：已打开视图即时生效", () => {
	it("上线日期注入视图并重跑列表管线（只重绘不重跑会导致筛选不生效）", async () => {
		const view = makeView();
		const { plugin } = makePlugin({ content: JSON.stringify({ a: 1 }), leaves: [view] });
		await call(plugin, "loadReleaseDates");
		expect(view.renderPluginList).toHaveBeenCalledWith(false);
	});

	it.each([
		["loadChineseEcosystem", "chineseEcoSet"],
		["loadBambooSeries", "bambooSeriesSet"],
		["loadYulinPicks", "yulinPicksSet"],
	] as const)("%s 把集合同步到已打开视图并重跑管线", async (name, field) => {
		const view = makeView();
		const { plugin } = makePlugin({ content: JSON.stringify({ k: true }), leaves: [view] });
		await call(plugin, name);
		expect(view[field]).toBeInstanceOf(Set);
		expect(view.renderPluginList).toHaveBeenCalledWith(false);
	});

	it("非本插件的视图（原型不匹配）不会被注入，避免污染其他视图", async () => {
		const foreign = { renderPluginList: vi.fn() } as unknown as View;
		const { plugin } = makePlugin({ content: JSON.stringify({ a: true }), leaves: [foreign] });
		await call(plugin, "loadChineseEcosystem");
		expect(foreign.renderPluginList).not.toHaveBeenCalled();
	});

	it("视图未打开时仅写入字段，不报错", async () => {
		const { plugin } = makePlugin({ content: JSON.stringify({ a: true }), leaves: [] });
		await call(plugin, "loadChineseEcosystem");
		expect(plugin.chineseEcoSet.has("a")).toBe(true);
	});
});

describe("清单加载器：路径契约", () => {
	it("一律从插件自身目录读取（不能用 vault 根或其他插件目录）", async () => {
		const { plugin, adapter } = makePlugin({ content: "{}" });
		await call(plugin, "loadReleaseDates");
		const path = String(adapter.exists.mock.calls[0]?.[0] ?? "");
		expect(path).toContain("chinese-plugin-market");
		expect(path).toContain("plugin-release-dates.json");
	});

	it("VIEW_TYPE 为注册时使用的常量（改名会让视图注入静默失效）", () => {
		expect(typeof VIEW_TYPE).toBe("string");
		expect(VIEW_TYPE.length).toBeGreaterThan(0);
	});
});

const flushAsync = () => new Promise((resolve) => window.setTimeout(resolve, 0));

/**
 * initDeferredLoad = onLayoutReady 后的延迟初始化总入口。
 * 它串联：本地模型预热 / TM 迁移 / vault 回灌 / 缓存恢复 / 各静态清单。
 *
 * 关键契约（历史事故点）：
 *   · 任何一步失败都不得中断后续步骤（曾因 TM 目录未建导致整条链断掉，首屏干等安全阀）
 *   · scanVaultTM 无论成败都必须放行 tmApprovedReady（否则视图永久挂起）
 *   · 已被 TM 校正的条目要从在线缓存里剔除，避免旧译名压过人工修正
 */
function makeDeferredPlugin() {
	const spies = {
		scheduleLocalEmbeddingWarmup: vi.fn(),
		autoMigrateTMIfNeeded: vi.fn().mockResolvedValue(undefined),
		scanVaultTM: vi.fn().mockResolvedValue(undefined),
		_resolveTmApprovedReady: vi.fn(),
		ensureVectorIndexLoaded: vi.fn().mockResolvedValue(undefined),
		refreshOpenViews: vi.fn(),
		loadReleaseDates: vi.fn().mockResolvedValue(undefined),
		loadChineseEcosystem: vi.fn().mockResolvedValue(undefined),
		loadBambooSeries: vi.fn().mockResolvedValue(undefined),
		loadYulinPicks: vi.fn().mockResolvedValue(undefined),
		loadPluginDeps: vi.fn().mockResolvedValue(undefined),
		loadPluginRecommend: vi.fn().mockResolvedValue(undefined),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, spies, {
		translator: { cache: { kept: {}, dropped: {} }, tmApproved: { dropped: { text: "人工校正" } } },
		storage: {
			loadStatsCache: vi.fn().mockResolvedValue(null),
			loadTrendingHistory: vi.fn().mockResolvedValue([]),
		},
	});
	return { plugin, spies };
}

const runDeferred = (plugin: unknown) =>
	(plugin as { initDeferredLoad(): Promise<void> }).initDeferredLoad();

describe("initDeferredLoad 启动期延迟初始化", () => {
	it("串联全部后台加载步骤", async () => {
		const { plugin, spies } = makeDeferredPlugin();
		await runDeferred(plugin);
		await flushAsync();

		expect(spies.scheduleLocalEmbeddingWarmup).toHaveBeenCalled();
		expect(spies.autoMigrateTMIfNeeded).toHaveBeenCalled();
		expect(spies.scanVaultTM).toHaveBeenCalled();
		expect(spies.ensureVectorIndexLoaded).toHaveBeenCalled();
		// 注：loadPluginRecommend 在 onload 里直接 await（首屏推荐区需要它），
		// 不属于这里延迟链的一部分——不要想当然地把它并进来。
		for (const key of [
			"loadReleaseDates",
			"loadChineseEcosystem",
			"loadBambooSeries",
			"loadYulinPicks",
			"loadPluginDeps",
		] as const) {
			expect(spies[key], `${key} 未被调用`).toHaveBeenCalled();
		}
	});

	it("TM 迁移失败不得中断后续步骤（曾导致整条延迟初始化断链）", async () => {
		const { plugin, spies } = makeDeferredPlugin();
		spies.autoMigrateTMIfNeeded.mockRejectedValue(new Error("ENOENT: tm 目录未建"));

		await runDeferred(plugin);

		expect(spies.scanVaultTM).toHaveBeenCalled();
		expect(spies.ensureVectorIndexLoaded).toHaveBeenCalled();
	});

	it("vault 回灌失败也必须放行 tmApprovedReady（否则首屏永久挂起）", async () => {
		const { plugin, spies } = makeDeferredPlugin();
		spies.scanVaultTM.mockRejectedValue(new Error("解析失败"));

		await expect(runDeferred(plugin)).rejects.toThrow("解析失败");

		expect(spies._resolveTmApprovedReady).toHaveBeenCalled();
	});

	it("已被 TM 校正的条目从在线缓存中剔除（防旧译名压过人工修正）", async () => {
		const { plugin } = makeDeferredPlugin();
		await runDeferred(plugin);

		const cache = (plugin as unknown as { translator: { cache: Record<string, unknown> } }).translator.cache;
		expect(cache.dropped).toBeUndefined();
		expect(cache.kept).toBeDefined();
	});

	it("恢复 stats / trending 缓存（跨会话累积）", async () => {
		const { plugin } = makeDeferredPlugin();
		await runDeferred(plugin);
		await flushAsync();

		const storage = (plugin as unknown as { storage: Record<string, ReturnType<typeof vi.fn>> }).storage;
		expect(storage.loadStatsCache).toHaveBeenCalled();
		expect(storage.loadTrendingHistory).toHaveBeenCalled();
	});

	it("缓存恢复后触发已打开视图刷新", async () => {
		const { plugin, spies } = makeDeferredPlugin();
		await runDeferred(plugin);
		await flushAsync();

		expect(spies.refreshOpenViews).toHaveBeenCalled();
	});
});

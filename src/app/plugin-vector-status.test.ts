import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的「本地向量索引状态 / 预热 / 增量维护」一组（2908-3078）。
 *
 * 既有 plugin-vector-store.test.ts 覆盖了向量索引存储本身，但 getLocalVectorStatus /
 * scheduleLocalEmbeddingWarmup / warmupLocalEmbedding / getViewPlugins / scheduleIndexRefresh /
 * ensureVectorIndexLoaded / buildLocalIndex 早返回分支这 ~170 行一行没跑到。
 *
 * 错误模式是「设置页看不到向量能力自检 / 预热静默失败 / 索引增量维护请求丢失」。
 */

const requestIdleMock = vi.hoisted(() => ({ last: null as { cb: () => void; ms: number } | null }));
vi.mock("@shared/platform", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	requestIdle: (cb: () => void, ms: number) => {
		requestIdleMock.last = { cb, ms };
	},
}));

// LocalEmbeddingProvider 是重活（拉 25MB WASM + 135MB 模型），这里换成哑类只记录 warmup 调用
const localProviderMock = vi.hoisted(() => ({ warmup: vi.fn(async () => {}) }));
vi.mock("@semantic/embedding", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	LocalEmbeddingProvider: class {
		constructor(_a: unknown, _b: unknown, _c: unknown, _d: unknown) {}
		warmup() {
			return localProviderMock.warmup();
		}
	},
}));

const bridgeMock = vi.hoisted(() => ({ installed: vi.fn(() => true) }));
vi.mock("@semantic/workers/worker-backend", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	isWorkerFetchBridgeInstalled: bridgeMock.installed,
}));

type AnyPlugin = Record<string, any>;

function makePlugin(settingsOver: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as unknown as AnyPlugin;
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		settings: {
			profiles: [] as PluginProfile[],
			embeddingSource: "local",
			embeddingWarmupOnStartup: true,
			embeddingRemoteHost: "https://hf-mirror.com",
			embeddingLocalModel: "bge",
			...settingsOver,
		},
		app: {
			vault: { adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => "") } },
			workspace: { getLeavesOfType: vi.fn(() => []) },
		},
		localModelState: { status: "downloading", loaded: 1, total: 2 } as Record<string, unknown>,
		localWarmupDone: false,
		ensureVectorStore: vi.fn(async () => ({})),
		loadPluginTags: vi.fn(async () => {}),
		loadVectorIndex: vi.fn(async () => {}),
		pluginTagsLoadPromise: null,
		vectorIndexLoadPromise: null,
		localIndexState: { status: "idle", progress: 0, total: 0 } as Record<string, unknown>,
		localIndexUnloadRequested: false,
		buildLocalIndexPromise: null,
		indexRefreshTimer: null,
		indexRefreshDirty: false,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	localProviderMock.warmup.mockResolvedValue(undefined);
	bridgeMock.installed.mockReturnValue(true);
	requestIdleMock.last = null;
	// 控制预热守卫：cores < 4 / saveData 默认不满足跳过条件
	Object.defineProperty(navigator, "hardwareConcurrency", { value: 8, configurable: true });
	Object.defineProperty(navigator, "connection", { value: { saveData: false }, configurable: true });
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("getLocalVectorStatus：向量能力自检（设置页可见）", () => {
	it("全部就绪：sqlWasm + sqlite + transform + 桥接均 true，回传下载态与归一化 host", async () => {
		const plugin = makePlugin(
			{},
			{
				app: { vault: { adapter: { exists: vi.fn(async () => true), read: vi.fn(async () => "") } }, workspace: { getLeavesOfType: vi.fn(() => []) } },
				ensureVectorStore: vi.fn(async () => ({ ready: true })),
				localWarmupDone: true,
			},
		);
		const s = await plugin.getLocalVectorStatus();
		expect(s.sqlWasm).toBe(true);
		expect(s.sqliteReady).toBe(true);
		expect(s.transformReady).toBe(true);
		expect(s.bridgeInstalled).toBe(true);
		expect(typeof s.remoteHost).toBe("string");
		expect(s.download).toEqual({ status: "downloading", loaded: 1, total: 2 });
	});

	it("sqlWasm 文件不存在 / adapter 抛错 → sqlWasm 仍为 false（兜底不崩）", async () => {
		const plugin = makePlugin({}, {
			app: { vault: { adapter: { exists: vi.fn(async () => { throw new Error("io"); }), read: vi.fn(async () => "") } }, workspace: { getLeavesOfType: vi.fn(() => []) } },
		});
		const s = await plugin.getLocalVectorStatus();
		expect(s.sqlWasm).toBe(false);
	});

	it("向量库未初始化（ensureVectorStore 返回 null）→ sqliteReady false", async () => {
		const plugin = makePlugin({}, { ensureVectorStore: vi.fn(async () => null) });
		const s = await plugin.getLocalVectorStatus();
		expect(s.sqliteReady).toBe(false);
	});

	it("桥接未装配 → bridgeInstalled false（提示用户镜像源死路）", async () => {
		bridgeMock.installed.mockReturnValueOnce(false);
		const plugin = makePlugin();
		const s = await plugin.getLocalVectorStatus();
		expect(s.bridgeInstalled).toBe(false);
	});
});

describe("scheduleLocalEmbeddingWarmup：启动期预热守卫", () => {
	it("embeddingSource 非 local → 不调度（非本地模式无需预热）", () => {
		const plugin = makePlugin({ embeddingSource: "cloud" });
		plugin.scheduleLocalEmbeddingWarmup();
		expect(requestIdleMock.last).toBeNull();
	});

	it("embeddingWarmupOnStartup 关闭 → 不调度", () => {
		const plugin = makePlugin({ embeddingWarmupOnStartup: false });
		plugin.scheduleLocalEmbeddingWarmup();
		expect(requestIdleMock.last).toBeNull();
	});

	it("低端机（cores < 4）→ 不调度（多线程 worker 更伤）", () => {
		Object.defineProperty(navigator, "hardwareConcurrency", { value: 2, configurable: true });
		const plugin = makePlugin();
		plugin.scheduleLocalEmbeddingWarmup();
		expect(requestIdleMock.last).toBeNull();
	});

	it("省流量（saveData）→ 不调度", () => {
		Object.defineProperty(navigator, "connection", { value: { saveData: true }, configurable: true });
		const plugin = makePlugin();
		plugin.scheduleLocalEmbeddingWarmup();
		expect(requestIdleMock.last).toBeNull();
	});

	it("全部满足 → 在空闲时段调度预热（最长等 30s）", () => {
		const plugin = makePlugin({}, { warmupLocalEmbedding: vi.fn() });
		plugin.scheduleLocalEmbeddingWarmup();
		expect(requestIdleMock.last).not.toBeNull();
		expect(requestIdleMock.last!.ms).toBe(30000);
		// 触发回调 → 真正调用预热
		requestIdleMock.last!.cb();
		expect((plugin as AnyPlugin).warmupLocalEmbedding).toHaveBeenCalled();
	});
});

describe("warmupLocalEmbedding：本地 embedding 预热（幂等 + 失败可重试）", () => {
	it("已预热 → 直接返回（不重复构造 provider）", () => {
		const plugin = makePlugin({}, { localWarmupDone: true, warmupLocalEmbedding: vi.fn() });
		// 直接调用真实方法：localWarmupDone 为 true 应早返回
		(plugin as AnyPlugin).warmupLocalEmbedding();
		expect(localProviderMock.warmup).not.toHaveBeenCalled();
	});

	it("未预热 → 构造 provider 并 warmup；成功后保留标志", async () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).warmupLocalEmbedding();
		await Promise.resolve();
		await Promise.resolve();
		expect(localProviderMock.warmup).toHaveBeenCalled();
		expect((plugin as AnyPlugin).localWarmupDone).toBe(true);
	});

	it("预热失败 → 重置标志允许下次再试（不永久禁用）", async () => {
		localProviderMock.warmup.mockRejectedValueOnce(new Error("oom"));
		const plugin = makePlugin();
		(plugin as AnyPlugin).warmupLocalEmbedding();
		for (let i = 0; i < 5; i++) await Promise.resolve();
		expect((plugin as AnyPlugin).localWarmupDone).toBe(false);
	});
});

describe("getViewPlugins：从已开视图取插件列表", () => {
	it("视图未打开 → 空", () => {
		const plugin = makePlugin({}, { app: { workspace: { getLeavesOfType: vi.fn(() => []) } } });
		expect((plugin as AnyPlugin).getViewPlugins()).toEqual([]);
	});

	it("视图已开但列表为空 → 空", () => {
		const plugin = makePlugin({}, {
			app: { workspace: { getLeavesOfType: vi.fn(() => [{ view: { plugins: [] } }]) } },
		});
		expect((plugin as AnyPlugin).getViewPlugins()).toEqual([]);
	});

	it("视图已开且有列表 → 返回该列表", () => {
		const list = [{ id: "a" }];
		const plugin = makePlugin({}, {
			app: { workspace: { getLeavesOfType: vi.fn(() => [{ view: { plugins: list } }]) } },
		});
		expect((plugin as AnyPlugin).getViewPlugins()).toBe(list);
	});
});

describe("scheduleIndexRefresh：动态向量索引增量维护（防抖 30s）", () => {
	it("embeddingSource 非 local → 不调度", () => {
		const plugin = makePlugin({ embeddingSource: "cloud" });
		plugin.scheduleIndexRefresh("x");
		expect((plugin as AnyPlugin).indexRefreshTimer).toBeNull();
	});

	it("正在构建（buildLocalIndexPromise 存在）→ 仅标脏，请求不丢失", () => {
		const plugin = makePlugin({}, { buildLocalIndexPromise: Promise.resolve() });
		const buildLocalIndex = vi.fn();
		Object.assign(plugin, { buildLocalIndex });
		plugin.scheduleIndexRefresh("x");
		expect((plugin as AnyPlugin).indexRefreshDirty).toBe(true);
		expect((plugin as AnyPlugin).indexRefreshTimer).toBeNull();
		expect(buildLocalIndex).not.toHaveBeenCalled();
	});

	it("正常：30s 防抖后触发增量构建；再次调度先清旧定时器", () => {
		const plugin = makePlugin();
		const buildLocalIndex = vi.fn();
		Object.assign(plugin, { buildLocalIndex });
		plugin.scheduleIndexRefresh("a");
		plugin.scheduleIndexRefresh("b"); // 清掉上一个 30s 定时器
		vi.advanceTimersByTime(31000);
		expect(buildLocalIndex).toHaveBeenCalledWith(false);
		expect((plugin as AnyPlugin).indexRefreshTimer).toBeNull();
	});

	it("触发时若进入构建态 → 标脏而非重复构建", () => {
		const plugin = makePlugin();
		const buildLocalIndex = vi.fn();
		Object.assign(plugin, { buildLocalIndex });
		plugin.scheduleIndexRefresh("a"); // 此时未构建 → 注册 30s 定时器
		Object.assign(plugin, { buildLocalIndexPromise: Promise.resolve() }); // 进入构建态
		vi.advanceTimersByTime(31000); // 定时器触发时检测到构建中 → 标脏，不重复构建
		expect(buildLocalIndex).not.toHaveBeenCalled();
		expect((plugin as AnyPlugin).indexRefreshDirty).toBe(true);
	});
});

describe("ensureVectorIndexLoaded：分类先于向量索引的幂等加载", () => {
	it("首次调用建立 Promise；再次调用复用同一份（不重复加载）", () => {
		const plugin = makePlugin();
		const p1 = (plugin as AnyPlugin).ensureVectorIndexLoaded();
		const p2 = (plugin as AnyPlugin).ensureVectorIndexLoaded();
		expect(p1).toBe(p2);
		expect(plugin.loadPluginTags).toHaveBeenCalledTimes(1);
	});
});

describe("buildLocalIndex：早返回分支（无需重活）", () => {
	it("已请求卸载 → 直接返回", async () => {
		const plugin = makePlugin({}, { localIndexUnloadRequested: true });
		await plugin.buildLocalIndex();
		expect(plugin.loadPluginTags).not.toHaveBeenCalled();
	});

	it("并发去重：已有 buildLocalIndexPromise → 复用同一次（不重复触发 getViewPlugins/embed）", async () => {
		const existing = Promise.resolve();
		const plugin = makePlugin({}, { buildLocalIndexPromise: existing });
		const getViewPlugins = vi.fn(() => []);
		Object.assign(plugin, { getViewPlugins });
		await plugin.buildLocalIndex();
		// 直接早返回，不会重新读取视图插件列表、不会重新 embed
		expect(getViewPlugins).not.toHaveBeenCalled();
		expect((plugin as AnyPlugin).buildLocalIndexPromise).toBe(existing);
	});

	it("无插件数据（视图未打开）→ 保持 idle 并提示一次，不构建", async () => {
		const plugin = makePlugin({}, { getViewPlugins: vi.fn(() => []) });
		await plugin.buildLocalIndex();
		expect((plugin as AnyPlugin).localIndexState.status).toBe("idle");
		expect(plugin.ensureVectorStore).not.toHaveBeenCalled();
	});
});

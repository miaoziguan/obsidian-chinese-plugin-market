import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";
import { embeddingIndexKey, DEFAULT_LOCAL_MODEL } from "@semantic/embedding";

/**
 * 补 app/plugin.ts 的 buildLocalIndex 完整 embed 闭环（3079-3256）。
 *
 * 既有 plugin-vector-status.test.ts 只覆盖了 buildLocalIndex 的早返回分支（无插件数据 / 并发去重 /
 * 已请求卸载），真正的 embed 主流程一行没跑到。这段是「本地向量索引构建」的核心：调用
 * provider.embed 逐条编码、时间片渐进、onPartial 增量发布、落盘、finally 清理与脏重跑。
 *
 * 错误模式是「索引永远建不起来 / 构建中途卸载静默卡死 / 增量维护请求丢失」。
 */

// buildVectorIndex 是重活（逐条 embed + 量化 + 写盘），这里换成可控桩：
// 真正调用 provider.embed（覆盖源码的 embed 闭包 3113-3134），再回调 onPartial 与返回假索引。
const bvState = vi.hoisted(() => ({ mode: "ok" as "ok" | "error" | "large" }));
vi.mock("@semantic/embedding", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	LocalEmbeddingProvider: class {
		constructor(_a?: unknown, _b?: unknown, _c?: unknown, _d?: unknown) {}
		embed(texts: string[]) {
			return Promise.resolve(texts.map(() => [0.1, 0.2]));
		}
	},
	buildVectorIndex: async (
		provider: { embed: (t: string[]) => Promise<number[][]> },
		plugins: { id: string; name: string; description: string }[],
		model: string,
		_prevIdx: unknown,
		_schemaVer: unknown,
		opts?: { onPartial?: (updates: Map<string, number[]>, hashes: Map<string, string>) => void },
	) => {
		if (bvState.mode === "error") throw new Error("build failed");
		const list =
			bvState.mode === "large"
				? Array.from({ length: 600 }, (_, i) => ({ id: "id" + i, name: "n", description: "d" }))
				: plugins;
		const updates = new Map<string, number[]>();
		const hashes = new Map<string, string>();
		for (const p of list) {
			const vecs = await provider.embed([`${p.name} ${p.description}`]); // 驱动源码 embed 闭包
			updates.set(p.id, vecs[0]);
		}
		opts?.onPartial?.(updates, hashes);
		return {
			ids: plugins.map((p) => p.id),
			vectors: plugins.map(() => [0.1, 0.2]),
			model,
			buildStats: { embedded: plugins.length, reused: 0 },
			perIdHash: {},
		};
	},
}));

const loggerMock = vi.hoisted(() => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	logger: loggerMock,
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, unknown> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as unknown as AnyPlugin;
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		settings: { profiles: [] as PluginProfile[], embeddingLocalModel: undefined } as Record<string, unknown>,
		app: { vault: { adapter: {} }, workspace: { getLeavesOfType: vi.fn(() => []) } },
		getViewPlugins: vi.fn(() => [{ id: "p1", name: "n1", description: "d1" }]),
		translator: {
			getAllPluginTags: vi.fn(() => ({})),
			cache: {},
			getCategorySchemaVersion: vi.fn(() => 3),
			getVectorIndex: vi.fn(() => null),
			setVectorIndex: vi.fn(),
		},
		ensureVectorIndexLoaded: vi.fn(async () => {}),
		saveVectorIndex: vi.fn(async () => {}),
		scheduleIndexRefresh: vi.fn(),
		localIndexState: { status: "idle", progress: 0, total: 0 } as Record<string, unknown>,
		localIndexUnloadRequested: false,
		indexRefreshDirty: false,
		buildLocalIndexPromise: null,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	bvState.mode = "ok";
	loggerMock.warn.mockClear();
});

describe("buildLocalIndex：完整 embed 闭环", () => {
	it("成功构建：embed 闭环 + 增量发布 + 落盘 + done 状态", async () => {
		const plugin = makePlugin();
		await plugin.buildLocalIndex();
		expect(plugin.translator.setVectorIndex).toHaveBeenCalled();
		expect(plugin.saveVectorIndex).toHaveBeenCalled(); // 最终落盘
		expect((plugin as AnyPlugin).localIndexState.status).toBe("done");
		expect((plugin as AnyPlugin).buildLocalIndexPromise).toBeNull(); // finally 清空
		expect(plugin.scheduleIndexRefresh).not.toHaveBeenCalled(); // 无脏标记
		// ensureVectorIndexLoaded 被调用（避免丢落盘索引的全量重建回归）
		expect(plugin.ensureVectorIndexLoaded).toHaveBeenCalled();
	});

	it("force 重建：丢弃 prevIdx 全量重 embed", async () => {
		const plugin = makePlugin();
		await plugin.buildLocalIndex(true);
		expect((plugin as AnyPlugin).localIndexState.status).toBe("done");
		expect(plugin.saveVectorIndex).toHaveBeenCalled();
	});

	it("复用 prevIdx 增量种子（model 匹配 → 注入 partial 向量与 hash）", async () => {
		const model = embeddingIndexKey({ source: "local", localModel: DEFAULT_LOCAL_MODEL });
		const plugin = makePlugin({
			translator: {
				getAllPluginTags: vi.fn(() => ({})),
				cache: {},
				getCategorySchemaVersion: vi.fn(() => 3),
				getVectorIndex: vi.fn(() => ({ model, ids: ["p1"], vectors: [[0.1]], perIdHash: { p1: "h1" } })),
				setVectorIndex: vi.fn(),
			},
		});
		await plugin.buildLocalIndex();
		expect((plugin as AnyPlugin).localIndexState.status).toBe("done");
		// publish 注入的 partial 含 p1 的复用向量
		const published = (plugin.translator.setVectorIndex as ReturnType<typeof vi.fn>).mock.calls[0][0];
		expect(published.ids).toContain("p1");
		expect(published.partial).toBe(true);
	});

	it("大批量 onPartial 触发 checkpoint 增量落盘（>=512）", async () => {
		bvState.mode = "large";
		const plugin = makePlugin();
		await plugin.buildLocalIndex();
		expect(plugin.saveVectorIndex).toHaveBeenCalled(); // checkpoint + 最终
		expect((plugin as AnyPlugin).localIndexState.status).toBe("done");
	});

	it("buildVectorIndex 抛错 → 记为 error 状态，finally 清空 promise（不卡死）", async () => {
		bvState.mode = "error";
		const plugin = makePlugin();
		await plugin.buildLocalIndex();
		expect(loggerMock.warn).toHaveBeenCalled();
		expect((plugin as AnyPlugin).localIndexState.status).toBe("error");
		expect((plugin as AnyPlugin).buildLocalIndexPromise).toBeNull();
	});

	it("构建期间标记脏 → finally 触发 scheduleIndexRefresh 再维护一次", async () => {
		const plugin = makePlugin({ indexRefreshDirty: true, indexRefreshDirtyReason: "列表更新" });
		await plugin.buildLocalIndex();
		expect((plugin as AnyPlugin).indexRefreshDirty).toBe(false); // 已消费
		expect(plugin.scheduleIndexRefresh).toHaveBeenCalledWith("列表更新");
	});
});

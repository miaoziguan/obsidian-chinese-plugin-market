import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的 loadVectorIndex 尾部（3327-3345）：向量索引加载的兜底与旧版迁移分支。
 *
 * 既有 plugin*.test.ts 没驱动这个方法，错误模式是「空库/无 SQLite 时向量索引状态错乱、
 * 异常后没兜底为 null 导致搜索崩溃」。
 *
 * 手法：ensureVectorStore / loadLegacyVectorIndex / saveVectorIndex 经 Object.assign 打桩，
 * 直接调私有方法（AnyPlugin 转型），覆盖：空库但有旧版 → 迁移并落盘；空库且无旧版 → null；
 * SQLite 不可用（store 为 null）→ 退化为旧版内存索引；getAllVecs 抛错 → catch 兜底 null。
 */

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const translator = {
		setVectorIndex: vi.fn(),
		getVectorIndex: vi.fn(() => ({ ids: [], vectors: [] })),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { vault: { adapter: { exists: vi.fn(), read: vi.fn(), readBinary: vi.fn() } } },
		translator,
		ensureVectorStore: vi.fn(),
		loadLegacyVectorIndex: vi.fn(async () => null),
		saveVectorIndex: vi.fn(async () => {}),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("loadVectorIndex 尾部兜底 / 旧版迁移（3327-3345）", () => {
	it("空库但有旧版索引 → 迁移进 SQLite 并落盘", async () => {
		const legacy = { ids: ["a", "b"], vectors: [] as number[][] };
		const plugin = makePlugin({
			ensureVectorStore: vi.fn(async () => ({ getAllVecs: vi.fn(() => new Map()) })),
			loadLegacyVectorIndex: vi.fn(async () => legacy),
		});
		await (plugin as AnyPlugin).loadVectorIndex();
		expect((plugin as AnyPlugin).translator.setVectorIndex).toHaveBeenCalledWith(legacy);
		expect((plugin as AnyPlugin).saveVectorIndex).toHaveBeenCalled();
	});

	it("空库且无旧版索引 → 置 null（不落盘）", async () => {
		const plugin = makePlugin({
			ensureVectorStore: vi.fn(async () => ({ getAllVecs: vi.fn(() => new Map()) })),
			loadLegacyVectorIndex: vi.fn(async () => null),
		});
		await (plugin as AnyPlugin).loadVectorIndex();
		expect((plugin as AnyPlugin).translator.setVectorIndex).toHaveBeenCalledWith(null);
		expect((plugin as AnyPlugin).saveVectorIndex).not.toHaveBeenCalled();
	});

	it("SQLite 不可用（store 为 null）→ 退化为旧版内存索引", async () => {
		const legacy = { ids: ["a"], vectors: [] as number[][] };
		const plugin = makePlugin({
			ensureVectorStore: vi.fn(async () => null),
			loadLegacyVectorIndex: vi.fn(async () => legacy),
		});
		await (plugin as AnyPlugin).loadVectorIndex();
		expect((plugin as AnyPlugin).translator.setVectorIndex).toHaveBeenCalledWith(legacy);
	});

	it("getAllVecs 抛错 → catch 兜底置 null", async () => {
		const plugin = makePlugin({
			ensureVectorStore: vi.fn(async () => ({ getAllVecs: vi.fn(() => { throw new Error("boom"); }) })),
		});
		await (plugin as AnyPlugin).loadVectorIndex();
		expect((plugin as AnyPlugin).translator.setVectorIndex).toHaveBeenCalledWith(null);
	});
});

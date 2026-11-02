import { describe, it, expect, vi, beforeEach } from "vitest";
import { logger } from "@shared/logger";
import { decodeVectorIndex } from "@semantic/vec-codec";
import ChinesePluginMarketPlugin from "@app/plugin";

vi.mock("@shared/logger", async (importOriginal) => {
	const o = await importOriginal<typeof import("@shared/logger")>();
	return { ...o, logger: { ...o.logger, warn: vi.fn() } };
});

vi.mock("@semantic/vec-codec", () => ({
	decodeVectorIndex: vi.fn(() => ({ ids: [1], vectors: [[0.1]] })),
}));

type AnyPlugin = Record<string, any>;

function makeTranslator() {
	return {
		loadData: vi.fn(),
		saveData: vi.fn(),
		setApiConfig: vi.fn(),
		setBaiduConfig: vi.fn(),
		setSelfHostedTranslators: vi.fn(),
		setAIConfig: vi.fn(),
		setPluginTags: vi.fn(),
		setVectorIndex: vi.fn(),
		buildPluginTagMap: vi.fn(),
		removeTMApproved: vi.fn(),
		tmApproved: {} as Record<string, unknown>,
		getPluginTags: vi.fn(() => ({})),
	};
}

function makePlugin(extra: Record<string, any> = {}) {
	const translator = makeTranslator();
	const adapter = {
		exists: vi.fn(async () => false),
		read: vi.fn(async () => ""),
		readBinary: vi.fn(async () => new Uint8Array([1, 2, 3])),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {
			vault: { adapter, configDir: ".obsidian" },
			workspace: { getLeavesOfType: vi.fn(() => []) },
			metadataCache: { resolved: true, on: vi.fn() },
		},
		storage: { getPluginData: vi.fn(async () => ({})), savePluginData: vi.fn(async () => {}) },
		translator,
		noteStorage: { adapter: {} },
		settings: { profiles: [], market: { plugins: [], lastSync: 0, syncStatus: "idle" }, betaAutoUpdate: false } as any,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("waitMetadataResolved：元数据就绪后继续初始化", () => {
	it("metadataCache 已 resolved → 立即 resolve，不挂定时器", async () => {
		const plugin = makePlugin({ app: { vault: { adapter: { exists: vi.fn(), read: vi.fn(), readBinary: vi.fn() } }, workspace: { getLeavesOfType: vi.fn(() => []) }, metadataCache: { resolved: true, on: vi.fn() } } });
		await (plugin as AnyPlugin).waitMetadataResolved();
		expect((plugin as AnyPlugin).app.metadataCache.on).not.toHaveBeenCalled();
	});

	it("metadataCache.on 不是函数 → 立即 resolve（兼容无 on 的环境）", async () => {
		const plugin = makePlugin({ app: { vault: { adapter: { exists: vi.fn(), read: vi.fn(), readBinary: vi.fn() } }, workspace: { getLeavesOfType: vi.fn(() => []) }, metadataCache: { resolved: false, on: null } } });
		await (plugin as AnyPlugin).waitMetadataResolved();
		expect((plugin as AnyPlugin).app.metadataCache.on).toBeNull();
	});

	it("on 存在 → resolved 事件触发后 resolve，并清掉兜底定时器", async () => {
		const mc = { resolved: false, on: vi.fn() };
		const plugin = makePlugin({ app: { vault: { adapter: { exists: vi.fn(), read: vi.fn(), readBinary: vi.fn() } }, workspace: { getLeavesOfType: vi.fn(() => []) }, metadataCache: mc } });
		const p = (plugin as AnyPlugin).waitMetadataResolved();
		expect(mc.on).toHaveBeenCalledWith("resolved", expect.any(Function));
		const cb = mc.on.mock.calls[0][1];
		cb(); // 模拟元数据就绪
		await p;
	});

	it("长时间不就绪 → 兜底超时后 resolve（不永久挂起）", async () => {
		vi.useFakeTimers();
		try {
			const mc = { resolved: false, on: vi.fn() };
			const plugin = makePlugin({ app: { vault: { adapter: { exists: vi.fn(), read: vi.fn(), readBinary: vi.fn() } }, workspace: { getLeavesOfType: vi.fn(() => []) }, metadataCache: mc } });
			const p = (plugin as AnyPlugin).waitMetadataResolved(500);
			vi.advanceTimersByTime(500);
			await p;
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("loadLegacyVectorIndex：旧版向量索引一次性迁移", () => {
	it(".bin 存在 → 读取二进制并经 codec 解码返回", async () => {
		const plugin = makePlugin();
		const vault = (plugin as AnyPlugin).app.vault;
		vault.adapter.exists.mockImplementation(async (p: string) => p.endsWith(".bin"));
		vault.adapter.readBinary.mockResolvedValue(new Uint8Array([9, 9, 9]));
		const idx = await (plugin as AnyPlugin).loadLegacyVectorIndex();
		expect(decodeVectorIndex).toHaveBeenCalledWith(new Uint8Array([9, 9, 9]));
		expect(idx).toEqual({ ids: [1], vectors: [[0.1]] });
	});

	it(".bin 不存在但 .json 存在且合法 → 解析返回", async () => {
		const plugin = makePlugin();
		const vault = (plugin as AnyPlugin).app.vault;
		vault.adapter.exists.mockImplementation(async (p: string) => p.endsWith(".json"));
		vault.adapter.read.mockResolvedValue(JSON.stringify({ ids: [1, 2], vectors: [[0.1], [0.2]] }));
		const idx = await (plugin as AnyPlugin).loadLegacyVectorIndex();
		expect(idx).toEqual({ ids: [1, 2], vectors: [[0.1], [0.2]] });
	});

	it(".json 存在但字段不合法 → 不算索引，返回 null", async () => {
		const plugin = makePlugin();
		const vault = (plugin as AnyPlugin).app.vault;
		vault.adapter.exists.mockImplementation(async (p: string) => p.endsWith(".json"));
		vault.adapter.read.mockResolvedValue(JSON.stringify({ foo: 1 }));
		const idx = await (plugin as AnyPlugin).loadLegacyVectorIndex();
		expect(idx).toBeNull();
	});

	it("两者都不存在 → 返回 null", async () => {
		const plugin = makePlugin();
		const idx = await (plugin as AnyPlugin).loadLegacyVectorIndex();
		expect(idx).toBeNull();
	});

	it("读取 .bin 抛错 → 记日志并返回 null（不阻断启动）", async () => {
		const plugin = makePlugin();
		const vault = (plugin as AnyPlugin).app.vault;
		vault.adapter.exists.mockImplementation(async (p: string) => p.endsWith(".bin"));
		vault.adapter.readBinary.mockRejectedValue(new Error("ENOSPC"));
		const idx = await (plugin as AnyPlugin).loadLegacyVectorIndex();
		expect(idx).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});
});

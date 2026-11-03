import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的 persistVectorIndex 写盘失败兜底（3426-3428）。方法体（3354-3425）此前已由
 * 向量索引相关测试覆盖，唯独「flush 抛错 → catch 记录、不影响搜索功能」这条异常分支是零覆盖。
 * 错误模式是「向量索引落盘失败（磁盘满/权限）时抛出未捕获异常、拖垮调用方」。
 *
 * 手法：translator.getVectorIndex 返回非空索引、ensureVectorStore 返回一个 flush() 抛错的假 store、
 * pluginTagMap 为空 Map，直接驱动 persistVectorIndex 走到 flush 抛错 → catch。logger 经 vi.mock 换成
 * 带 spy 的桩以断言被调用。本方法自包含，无需 onload。私人方法经 AnyPlugin 转型访问。
 */

const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", () => ({ logger: loggerMock }));

type AnyPlugin = Record<string, any>;

const index = {
	ids: ["a"],
	vectors: [[0.1, 0.2]],
	model: "x",
	hash: "h",
	partial: false,
	perIdHash: { a: "1" },
	categorySchemaVersion: "1",
	fieldsHash: "f",
};

function makePlugin(extra: Record<string, any> = {}) {
	const store = {
		getMeta: vi.fn(() => undefined),
		setMeta: vi.fn(),
		replaceAll: vi.fn(),
		upsertMany: vi.fn(),
		deleteMany: vi.fn(),
		flush: vi.fn(async () => {
			throw new Error("disk full");
		}),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		translator: { getVectorIndex: vi.fn(() => index) },
		ensureVectorStore: vi.fn(async () => store),
		pluginTagMap: new Map<string, string>(),
		...extra,
		__store: store,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	loggerMock.warn.mockClear();
});

describe("persistVectorIndex：写盘失败兜底（3426-3428）", () => {
	it("flush 抛错 → catch 记录且不抛出（覆盖 3426-3428）", async () => {
		const plugin = makePlugin();
		await expect((plugin as AnyPlugin).persistVectorIndex()).resolves.toBeUndefined();
		expect((plugin as AnyPlugin).__store.flush).toHaveBeenCalled();
		expect(loggerMock.warn).toHaveBeenCalled();
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * ensureVectorStore —— SQLite 向量库的懒初始化。
 *
 * 这里最重要的不是「能开库」，而是**失败必须一次性且明确**：
 *   · wasm 缺失 → 标记失败，本会话不再重试（避免每次搜索都刷一遍日志）
 *   · 沙箱加载 sql.js 失败 → 降级内存索引，绝不阻塞主功能
 *   · 盘上向量库损坏 → persist.delete 后由 open 以空库重建，而非整体崩掉
 */
const vecMock = vi.hoisted(() => ({
	initSqlJsStatic: vi.fn(async () => ({}) as unknown),
	open: vi.fn(async (_persist: unknown, _path: string, _sql: unknown) => ({ kind: "fake-store" }) as unknown),
}));

vi.mock("@semantic/vec-store", () => ({
	SqliteVectorStore: { open: vecMock.open },
	initSqlJsStatic: vecMock.initSqlJsStatic,
}));

vi.mock("sql.js", () => ({ default: {} }));

type Persist = {
	exists(p: string): Promise<boolean>;
	read(p: string): Promise<Uint8Array>;
	write(p: string, bytes: Uint8Array): Promise<void>;
	delete(p: string): Promise<void>;
};

function makePlugin(over: Record<string, unknown> = {}) {
	const adapter = {
		exists: vi.fn(async (_p: string) => true),
		readBinary: vi.fn(async (_p: string) => new Uint8Array([1, 2, 3]).buffer),
		writeBinary: vi.fn(async (_p: string, _b: ArrayBuffer) => {}),
		remove: vi.fn(async (_p: string) => {}),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		app: { vault: { adapter } },
		vectorStore: null,
		vectorStoreInitFailed: false,
		...over,
	});
	// 两个路径是原型上的只读 getter（由 manifest.id 推导），
	// 直接赋值会抛错；用自有属性遮蔽以便固定断言路径
	Object.defineProperty(plugin, "sqlWasmFilePath", { value: "sql-wasm.wasm", configurable: true });
	Object.defineProperty(plugin, "vectorStoreFilePath", { value: "vectors.db", configurable: true });
	return { plugin, adapter };
}

const internals = (plugin: unknown) =>
	plugin as unknown as { vectorStore: unknown; vectorStoreInitFailed: boolean };

const ensure = (plugin: unknown) =>
	(plugin as { ensureVectorStore(): Promise<unknown> }).ensureVectorStore();

beforeEach(() => {
	vi.clearAllMocks();
	vecMock.open.mockResolvedValue({ kind: "fake-store" });
	vecMock.initSqlJsStatic.mockResolvedValue({});
});

describe("ensureVectorStore：短路与失败标记", () => {
	it("已有实例时直接复用，不再读 wasm", async () => {
		const existing = { kind: "existing" };
		const { plugin, adapter } = makePlugin({ vectorStore: existing });

		await expect(ensure(plugin)).resolves.toBe(existing);
		expect(adapter.exists).not.toHaveBeenCalled();
	});

	it("本会话已失败过则直接返回 null（不重试、不刷日志）", async () => {
		const { plugin, adapter } = makePlugin({ vectorStoreInitFailed: true });

		await expect(ensure(plugin)).resolves.toBeNull();
		expect(adapter.exists).not.toHaveBeenCalled();
	});

	it("wasm 未随插件分发时禁用向量库并打上失败标记", async () => {
		const { plugin, adapter } = makePlugin();
		adapter.exists.mockResolvedValue(false);

		await expect(ensure(plugin)).resolves.toBeNull();

		expect(internals(plugin).vectorStoreInitFailed).toBe(true);
		expect(vecMock.initSqlJsStatic).not.toHaveBeenCalled();
	});

	it("初始化抛错时降级为 null 且打上失败标记（沙箱限制不该拖垮主功能）", async () => {
		const { plugin } = makePlugin();
		vecMock.initSqlJsStatic.mockRejectedValue(new Error("CJS 无 ESM 导出"));

		await expect(ensure(plugin)).resolves.toBeNull();

		expect(internals(plugin).vectorStoreInitFailed).toBe(true);
		expect(internals(plugin).vectorStore).toBeNull();
	});

	it("成功路径：读 wasm → 初始化 → open，并缓存实例", async () => {
		const { plugin, adapter } = makePlugin();

		const store = await ensure(plugin);

		expect(store).toEqual({ kind: "fake-store" });
		expect(adapter.readBinary).toHaveBeenCalledWith("sql-wasm.wasm");
		expect(vecMock.initSqlJsStatic).toHaveBeenCalled();
		expect(vecMock.open).toHaveBeenCalled();
		expect(internals(plugin).vectorStore).toBe(store);
	});

	it("第二次调用复用缓存，不重复 open", async () => {
		const { plugin } = makePlugin();

		await ensure(plugin);
		await ensure(plugin);

		expect(vecMock.open).toHaveBeenCalledTimes(1);
	});
});

describe("ensureVectorStore：persist 适配器（字节与损坏自愈）", () => {
	const capturePersist = async () => {
		let persist: Persist | null = null;
		vecMock.open.mockImplementation(async (p: unknown) => {
			persist = p as Persist;
			return { kind: "fake-store" };
		});
		const { plugin, adapter } = makePlugin();
		await ensure(plugin);
		return { persist: persist as unknown as Persist, adapter };
	};

	it("exists 直接委托给 vault adapter", async () => {
		const { persist, adapter } = await capturePersist();
		adapter.exists.mockResolvedValue(false);

		await expect(persist.exists("vectors.db")).resolves.toBe(false);
		expect(adapter.exists).toHaveBeenCalledWith("vectors.db");
	});

	it("read 把 ArrayBuffer 包成 Uint8Array", async () => {
		const { persist, adapter } = await capturePersist();
		adapter.readBinary.mockResolvedValue(new Uint8Array([9, 8]).buffer);

		const bytes = await persist.read("vectors.db");

		expect(bytes).toBeInstanceOf(Uint8Array);
		expect([...bytes]).toEqual([9, 8]);
	});

	it("write 把 Uint8Array 复制成独立 ArrayBuffer（越过可能共享的视图）", async () => {
		const { persist, adapter } = await capturePersist();

		await persist.write("vectors.db", new Uint8Array([7, 6, 5]));

		const [, buf] = adapter.writeBinary.mock.calls[0] as unknown as [string, ArrayBuffer];
		expect(buf).toBeInstanceOf(ArrayBuffer);
		expect(buf.byteLength).toBe(3);
		expect([...new Uint8Array(buf)]).toEqual([7, 6, 5]);
	});

	it("delete 委托给 adapter.remove（盘上损坏库的自愈入口）", async () => {
		const { persist, adapter } = await capturePersist();

		await persist.delete("vectors.db");

		expect(adapter.remove).toHaveBeenCalledWith("vectors.db");
	});
});

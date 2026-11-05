/**
 * 本地语义 worker 单例的释放语义（泄漏回归）。
 *
 * 背景：worker 是独立线程，其 WASM 模型不随 JS 上下文 GC。自我更新走
 * disable → enable（不重启 Obsidian），若卸载时不 terminate，旧 worker 会一直驻留，
 * 且新实例（全新 JS 模块，instances 是新表）会另建 worker 并重新加载模型
 * → 每更新一次泄漏一份模型内存，表现为「更新后打开整个 Obsidian 卡一段时间」。
 *
 * 这里只验证「单例表被清空」这一契约：WorkerLocalBackend 构造函数不做任何 IO
 * （worker 懒启动于 init/bootWorker），故 jsdom 下可安全创建实例并断言释放。
 */
import { describe, it, expect, vi, beforeAll, afterEach, beforeEach } from "vitest";
import {
	WorkerLocalBackend,
	setWorkerSourceLoader,
	setWorkerFetchBridge,
	isWorkerFetchBridgeInstalled,
	setModelProgressReporter,
	reportModelProgress,
	disposeAllShared,
} from "@semantic/workers/worker-backend";
import { logger } from "@shared/logger";

describe("WorkerLocalBackend 单例释放", () => {
	afterEach(() => {
		WorkerLocalBackend.disposeAllShared();
	});

	it("同 model+镜像源复用同一实例（释放前的既有语义）", () => {
		const a = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		const b = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		expect(a).toBe(b);
	});

	it("disposeAllShared 清空单例表：释放后 getShared 会新建实例而非复用旧的", () => {
		const first = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		const released = WorkerLocalBackend.disposeAllShared();
		expect(released).toBeGreaterThanOrEqual(1);
		const after = WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small" });
		expect(after).not.toBe(first);
	});

	it("镜像源不同的实例一并释放（切镜像后旧 worker 不残留）", () => {
		WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small", remoteHost: "https://hf-mirror.com/" });
		WorkerLocalBackend.getShared({ model: "Xenova/multilingual-e5-small", remoteHost: "https://huggingface.co/" });
		expect(WorkerLocalBackend.disposeAllShared()).toBe(2);
		// 再次释放应为空操作（幂等，便于 onunload 重复调用）
		expect(WorkerLocalBackend.disposeAllShared()).toBe(0);
	});
});

// ─────────────────────────────────────────────────────────────
// 追加用例：补齐主线程侧逻辑（模块装配函数、embed/warmup/init/bootWorker/
// handleMessage 各分支 / fetch 桥接 / dispose / failInit）。原 3 例保留。
// 用 FakeWorker + URL.createObjectURL 桩驱动，不依赖真实 Worker 线程。
// ─────────────────────────────────────────────────────────────

class FakeWorker {
	url: string;
	onmessage: ((e: { data: unknown }) => void) | null = null;
	onerror: ((e: unknown) => void) | null = null;
	postMessage = vi.fn();
	terminate = vi.fn();
	constructor(url: string) {
		this.url = url;
	}
}

const inst = (model: string): WorkerLocalBackend => WorkerLocalBackend.getShared({ model });
const priv = (o: unknown, name: string, ...args: unknown[]): unknown =>
	(o as Record<string, (...a: unknown[]) => unknown>)[name](...args);

describe("WorkerLocalBackend 行为补全（主线程侧逻辑）", () => {
	beforeAll(() => {
		(globalThis as unknown as { Worker: unknown }).Worker = FakeWorker;
		(URL as unknown as { createObjectURL: unknown; revokeObjectURL: unknown }).createObjectURL = vi.fn(() => "blob:mock");
		(URL as unknown as { revokeObjectURL: unknown }).revokeObjectURL = vi.fn();
	});
	beforeEach(() => {
		setWorkerSourceLoader(() => Promise.resolve("// worker source"));
		setWorkerFetchBridge(async () => ({ status: 200, buffer: new ArrayBuffer(8), headers: {} }));
		setModelProgressReporter(vi.fn());
	});
	afterEach(() => {
		vi.restoreAllMocks();
		disposeAllShared();
	});

	it("模块装配：setWorkerFetchBridge 后 isWorkerFetchBridgeInstalled 为真，未注入为假", () => {
		expect(isWorkerFetchBridgeInstalled()).toBe(true);
		setWorkerFetchBridge(null as never);
		expect(isWorkerFetchBridgeInstalled()).toBe(false);
		setWorkerFetchBridge(async () => ({ status: 200, buffer: null }));
		expect(isWorkerFetchBridgeInstalled()).toBe(true);
	});

	it("reportModelProgress 调用已注册的 reporter", () => {
		const rep = vi.fn();
		setModelProgressReporter(rep);
		reportModelProgress({ status: "ready" });
		expect(rep).toHaveBeenCalledWith({ status: "ready" });
	});

	it("disposeAllShared 无实例时返回 0（幂等）", () => {
		expect(disposeAllShared()).toBe(0);
	});

	it("embed([])：空数组直接返回 []，不启动 worker", async () => {
		const i = inst("X");
		const r = await i.embed([]);
		expect(r).toEqual([]);
		expect((i as unknown as { worker: unknown }).worker).toBeNull();
	});

	it("embed 正常：ready + result → 向量数组", async () => {
		const i = inst("X");
		const p = i.embed(["hi"]);
		await new Promise((res) => window.setTimeout(res, 10));
		const w = (i as unknown as { worker: FakeWorker }).worker;
		expect(w).toBeInstanceOf(FakeWorker);
		w.onmessage!({ data: { type: "ready", dimension: 384 } });
		// 让 embed 恢复并执行 embedBatch（建立 pending id=1）后再回传 result，否则 result 会早于 pending 触发
		await new Promise((res) => window.setTimeout(res, 0));
		w.onmessage!({ data: { type: "result", id: 1, vectors: [new Float32Array([1, 2, 3])] } });
		expect(await p).toEqual([[1, 2, 3]]);
	});

	it("failed 后 embed 直接抛「已因沙箱限制禁用」", async () => {
		const i = inst("X");
		(i as unknown as { failed: boolean }).failed = true;
		await expect(i.embed(["hi"])).rejects.toThrow("已因沙箱限制禁用");
	});

	it("init 失败（loader 抛错）→ embed 抛错且实例从单例表移除", async () => {
		setWorkerSourceLoader(() => {
			throw new Error("no file");
		});
		const i = inst("X");
		await expect(i.embed(["hi"])).rejects.toThrow(/no file/);
		expect(disposeAllShared()).toBe(0);
	});

	it("warmup：failed 直接返回；loader 抛错时静默不抛", async () => {
		const a = inst("A");
		(a as unknown as { failed: boolean }).failed = true;
		await expect(a.warmup()).resolves.toBeUndefined();
		setWorkerSourceLoader(() => {
			throw new Error("no");
		});
		const b = inst("B");
		await expect(b.warmup()).resolves.toBeUndefined();
	});

	it("handleMessage：log → logger.warn", () => {
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		priv(inst("X"), "handleMessage", { type: "log", message: "boom" });
		expect(warn).toHaveBeenCalled();
	});

	it("handleMessage：progress → 上报 downloading（含百分比）", () => {
		const rep = vi.fn();
		setModelProgressReporter(rep);
		priv(inst("X"), "handleMessage", { type: "progress", loaded: 50, total: 100 });
		expect(rep).toHaveBeenCalledWith({ status: "downloading", loaded: 50, total: 100 });
	});

	it("handleMessage：ready → ready=true 且上报 ready", () => {
		const rep = vi.fn();
		setModelProgressReporter(rep);
		priv(inst("X"), "handleMessage", { type: "ready", dimension: 384 });
		expect((inst("X") as unknown as { ready: boolean }).ready).toBe(true);
		expect(rep).toHaveBeenCalledWith({ status: "ready" });
	});

	it("handleMessage：init-error → 上报 error 且实例从单例表移除", () => {
		const rep = vi.fn();
		setModelProgressReporter(rep);
		priv(inst("X"), "handleMessage", { type: "init-error", message: "boom" });
		expect(rep).toHaveBeenCalledWith({ status: "error", error: "boom" });
		expect(disposeAllShared()).toBe(0);
	});

	it("handleMessage：result 命中不存在的 id → 静默 return 不抛", () => {
		expect(() =>
			priv(inst("X"), "handleMessage", { type: "result", id: 999, vectors: [] }),
		).not.toThrow();
	});

	it("handleMessage：fetch（桥接未注入）→ 回传 error", async () => {
		setWorkerFetchBridge(null as never);
		const i = inst("X");
		const w = new FakeWorker("x");
		(i as unknown as { worker: FakeWorker }).worker = w;
		priv(i, "handleMessage", { type: "fetch", id: 7, url: "http://x", method: "GET" });
		await new Promise((res) => window.setTimeout(res, 5));
		expect(w.postMessage).toHaveBeenCalledWith(
			expect.objectContaining({ type: "fetch-result", id: 7, error: expect.stringContaining("fetch 桥接未注入") }),
			expect.anything(),
		);
	});

	it("handleMessage：fetch（桥接注入）→ 回传 status + buffer", async () => {
		const i = inst("X");
		const w = new FakeWorker("x");
		(i as unknown as { worker: FakeWorker }).worker = w;
		priv(i, "handleMessage", { type: "fetch", id: 8, url: "http://x", method: "GET" });
		await new Promise((res) => window.setTimeout(res, 5));
		const call = (w.postMessage as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
			type: string; id: number; status: number;
		};
		expect(call.type).toBe("fetch-result");
		expect(call.id).toBe(8);
		expect(call.status).toBe(200);
	});

	it("dispose：terminate worker 且拒绝在途 embed（pending 清理）", async () => {
		const i = inst("X");
		const w = new FakeWorker("x");
		(i as unknown as { worker: FakeWorker }).worker = w;
		const p = priv(i, "embedBatch", ["hi"]) as Promise<unknown>;
		i.dispose();
		await expect(p).rejects.toThrow("backend disposed");
		expect(w.terminate).toHaveBeenCalled();
	});
});

import { describe, it, expect, vi } from "vitest";
import {
	createModelDownloadBridge,
	type BridgeHttpRequest,
	type BridgeHttpResponse,
	type BridgeProgress,
	type BridgeSourceCache,
} from "./model-download-bridge";

/**
 * 模型下载桥接：worker 的下载请求由主线程代发。
 *
 * 这是从 plugin.onload 的闭包里抽出来的（原先定义时不执行、永远零覆盖）。
 * 抽取保持逐行等价，本文件锁定它最容易被改坏的六个行为：
 *   1. HEAD 直通，不做源探测
 *   2. 源探测：选第一个活着的，全死则显式报错（不能让 worker 干等）
 *   3. 探测结果缓存 10 分钟，避免每个文件都重新探测
 *   4. 服务端不支持 Range（200）时整包返回
 *   5. 分块下载后必须按序合并，且每块都上报真实进度
 *   6. 某块失败要切另一源**续传**（只切不回），不能从头再来
 */
const OFFICIAL = "https://huggingface.co/";
const MIRROR = "https://hf-mirror.com/";
const FILE_URL = "https://huggingface.co/org/model.bin";

function makeDeps(over: Record<string, unknown> = {}) {
	let cache: BridgeSourceCache | null = null;
	const progress: BridgeProgress[] = [];
	const warns: string[] = [];
	const request = vi.fn(async (_o: BridgeHttpRequest) => ({ status: 200, headers: {} }) as BridgeHttpResponse);

	const deps = {
		request,
		normalizeHost: (raw?: string) => raw ?? "",
		getPreferredHost: () => MIRROR,
		reportProgress: (p: BridgeProgress) => progress.push(p),
		getCache: () => cache,
		setCache: (c: BridgeSourceCache) => {
			cache = c;
		},
		logger: {
			warn: (...args: unknown[]) => warns.push(String(args[0])),
			debug: () => {},
		},
		now: () => 1_000_000,
		officialHost: OFFICIAL,
		chunkBytes: 4,
		chunkTimeoutMs: 5_000,
		probeTimeoutMs: 1_000,
		...over,
	};
	return { deps, request, progress, warns, getCache: () => cache };
}

/** 伪服务端：按 Range 返回切片，支持指定总大小 */
function serveBytes(total: number) {
	const data = new Uint8Array(total).map((_, i) => (i + 1) % 256);
	const fn = vi.fn(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> => {
		if (o.method === "HEAD") return { status: 200, headers: {} };
		const m = /bytes=(\d+)-(\d+)/.exec(o.headers?.Range ?? "");
		if (!m) return { status: 200, headers: {}, arrayBuffer: data.buffer.slice(0) };
		const start = Number(m[1]);
		const end = Math.min(Number(m[2]), total - 1);
		return {
			status: 206,
			headers: { "content-range": `bytes ${start}-${end}/${total}` },
			arrayBuffer: data.slice(start, end + 1).buffer,
		};
	});
	return { fn, data };
}

describe("download bridge：HEAD 与源探测", () => {
	it("HEAD 直接透传，不做探测", async () => {
		const { deps, request } = makeDeps();
		request.mockResolvedValue({ status: 200, headers: { etag: "x" } });
		const bridge = createModelDownloadBridge(deps);

		const r = await bridge(FILE_URL, "HEAD");

		expect(r).toEqual({ status: 200, buffer: null, headers: { etag: "x" } });
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("探测选第一个可用源（镜像挂掉时落到官方源）", async () => {
		const { deps, request, getCache } = makeDeps();
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> => {
			if (o.method === "HEAD") {
				if (o.url.includes("hf-mirror")) throw new Error("reset");
				return { status: 200, headers: {} };
			}
			return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) };
		});
		const bridge = createModelDownloadBridge(deps);

		await bridge(FILE_URL, "GET");

		expect(getCache()?.host).toBe(OFFICIAL);
	});

	it("所有源都不可达时返回 status 0 与可操作错误文案（不让 worker 干等 90s）", async () => {
		const { deps, request } = makeDeps();
		request.mockRejectedValue(new Error("blocked"));
		const bridge = createModelDownloadBridge(deps);

		const r = await bridge(FILE_URL, "GET");

		expect(r.status).toBe(0);
		expect(r.buffer).toBeNull();
		expect(r.error).toContain("所有下载源均不可达");
	});

	it("探测结果在 TTL 内复用，不重复探测", async () => {
		const { deps, request } = makeDeps();
		const { fn } = serveBytes(4);
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> =>
			o.method === "HEAD" ? { status: 200, headers: {} } : fn(o),
		);
		const bridge = createModelDownloadBridge(deps);

		await bridge(FILE_URL, "GET");
		const headCalls = request.mock.calls.filter((c) => c[0].method === "HEAD").length;
		await bridge(FILE_URL, "GET");
		const headCallsAfter = request.mock.calls.filter((c) => c[0].method === "HEAD").length;

		expect(headCallsAfter).toBe(headCalls);
	});

	it("探测结果过期后重新探测", async () => {
		let now = 1_000_000;
		const { deps, request } = makeDeps({ now: () => now });
		const { fn } = serveBytes(4);
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> =>
			o.method === "HEAD" ? { status: 200, headers: {} } : fn(o),
		);
		const bridge = createModelDownloadBridge(deps);

		await bridge(FILE_URL, "GET");
		const before = request.mock.calls.filter((c) => c[0].method === "HEAD").length;
		now += 11 * 60_000;
		await bridge(FILE_URL, "GET");
		const after = request.mock.calls.filter((c) => c[0].method === "HEAD").length;

		expect(after).toBeGreaterThan(before);
	});
});

describe("download bridge：整包与分块", () => {
	it("服务端不支持 Range（返回 200）时整包直接返回", async () => {
		const { deps, request } = makeDeps();
		const body = new Uint8Array([1, 2, 3]).buffer;
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> =>
			o.method === "HEAD" ? { status: 200, headers: {} } : { status: 200, headers: {}, arrayBuffer: body },
		);
		const bridge = createModelDownloadBridge(deps);

		const r = await bridge(FILE_URL, "GET");

		expect(r.status).toBe(200);
		expect(r.buffer).toBe(body);
	});

	it("按块下载并按序合并成完整文件", async () => {
		const { deps } = makeDeps();
		const { fn, data } = serveBytes(10); // chunkBytes=4 → 4 + 4 + 2
		deps.request = fn;
		const bridge = createModelDownloadBridge(deps);

		const r = await bridge(FILE_URL, "GET");

		expect(r.status).toBe(200);
		expect([...new Uint8Array(r.buffer as ArrayBuffer)]).toEqual([...data]);
	});

	it("每块都上报真实进度（先归零，再逐块累加）", async () => {
		const { deps, progress } = makeDeps();
		const { fn } = serveBytes(10);
		deps.request = fn;
		const bridge = createModelDownloadBridge(deps);

		await bridge(FILE_URL, "GET");

		// 首个事件把进度归零，避免上一个文件的 100% 被误读
		expect(progress[0]).toEqual({ status: "downloading", loaded: 0, total: 0 });
		const loadedValues = progress.map((p) => p.loaded);
		expect(loadedValues).toContain(4);
		expect(loadedValues).toContain(8);
		expect(progress[progress.length - 1]).toEqual({ status: "downloading", loaded: 10, total: 10 });
	});

	it("缺少 content-range 时只取首块（total 未知，不无限请求）", async () => {
		const { deps, request } = makeDeps();
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> =>
			o.method === "HEAD"
				? { status: 200, headers: {} }
				: { status: 206, headers: {}, arrayBuffer: new Uint8Array([7, 7]).buffer },
		);
		const bridge = createModelDownloadBridge(deps);

		const r = await bridge(FILE_URL, "GET");

		expect(request.mock.calls.filter((c) => c[0].method === "GET")).toHaveLength(1);
		expect([...new Uint8Array(r.buffer as ArrayBuffer)]).toEqual([7, 7]);
	});
});

describe("download bridge：切源续传", () => {
	it("某块失败时切另一源续传，而不是从头重下", async () => {
		const { deps, request } = makeDeps();
		const { data } = serveBytes(10);
		const seen: string[] = [];
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> => {
			if (o.method === "HEAD") return { status: 200, headers: {} };
			const range = o.headers?.Range ?? "";
			seen.push(`${new URL(o.url).host} ${range}`);
			// 镜像源在第二块时挂掉
			if (o.url.includes("hf-mirror") && range.startsWith("bytes=4")) {
				throw new Error("ECONNRESET");
			}
			const m = /bytes=(\d+)-(\d+)/.exec(range)!;
			const start = Number(m[1]);
			const end = Math.min(Number(m[2]), 10 - 1);
			return {
				status: 206,
				headers: { "content-range": `bytes ${start}-${end}/10` },
				arrayBuffer: data.slice(start, end + 1).buffer,
			};
		});
		const bridge = createModelDownloadBridge(deps);

		const r = await bridge(FILE_URL, "GET");

		// 首块走镜像，第二块失败后同偏移改走官方
		expect(seen[0]).toContain("hf-mirror");
		expect(seen.some((s) => s.includes("huggingface") && s.includes("bytes=4"))).toBe(true);
		expect([...new Uint8Array(r.buffer as ArrayBuffer)]).toEqual([...data]);
	});

	it("切源后仍是失败则抛出（不吞掉错误）", async () => {
		const { deps, request } = makeDeps();
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> => {
			if (o.method === "HEAD") return { status: 200, headers: {} };
			throw new Error("ECONNRESET");
		});
		const bridge = createModelDownloadBridge(deps);

		await expect(bridge(FILE_URL, "GET")).rejects.toThrow("ECONNRESET");
	});

	it("非 206/200 状态被视为失败并触发切源", async () => {
		const { deps, request } = makeDeps();
		const { data } = serveBytes(4);
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> => {
			if (o.method === "HEAD") return { status: 200, headers: {} };
			if (o.url.includes("hf-mirror")) return { status: 500, headers: {} };
			return {
				status: 206,
				headers: { "content-range": "bytes 0-3/4" },
				arrayBuffer: data.buffer.slice(0),
			};
		});
		const bridge = createModelDownloadBridge(deps);

		const r = await bridge(FILE_URL, "GET");

		expect(r.status).toBe(200);
		expect([...new Uint8Array(r.buffer as ArrayBuffer)]).toEqual([...data]);
	});
});

describe("download bridge：超时", () => {
	it("单块超时即报错，不发生无声挂死", async () => {
		const { deps, request } = makeDeps({ chunkTimeoutMs: 5, probeTimeoutMs: 5 });
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> => {
			if (o.method === "HEAD") return { status: 200, headers: {} };
			return new Promise<BridgeHttpResponse>(() => {}); // 永不返回
		});
		const bridge = createModelDownloadBridge(deps);

		await expect(bridge(FILE_URL, "GET")).rejects.toThrow(/超时/);
	});

	it("探测超时视为该源不可达，继续尝试下一个", async () => {
		const { deps, request, getCache } = makeDeps({ probeTimeoutMs: 5 });
		request.mockImplementation(async (o: BridgeHttpRequest): Promise<BridgeHttpResponse> => {
			if (o.method === "HEAD") {
				if (o.url.includes("hf-mirror")) return new Promise<BridgeHttpResponse>(() => {});
				return { status: 200, headers: {} };
			}
			return { status: 200, headers: {}, arrayBuffer: new ArrayBuffer(0) };
		});
		const bridge = createModelDownloadBridge(deps);

		await bridge(FILE_URL, "GET");

		expect(getCache()?.host).toBe(OFFICIAL);
	});
});

/**
 * Embedding Worker — 在 Web Worker 里跑 @huggingface/transformers 推理。
 *
 * 为什么用 worker：Obsidian 的 Electron 渲染进程沙箱无法用原生 import() 加载
 * transformers（ESM + WASM）。vault-curate 的成熟做法是：把 transformers +
 * onnxruntime 打包进一个 Web Worker（iife，browser 平台），worker 源码字符串
 * 内联进 main.js，运行时用 Blob URL 实例化。这样绕开沙箱，且推理不阻塞 UI。
 *
 * 协议：
 *   init {modelId, dtype, wasmPaths?}  → 加载 pipeline → 回 ready{dimension}
 *   embed {id, texts}                  → 回 result{id, vectors: Float32Array[]}
 *   progress {loaded, total, phase}    → 下载/加载进度
 *   log {message}                      → worker 日志转发（worker console 不可见）
 *   dispose                            → 释放模型
 */
declare const self: {
	postMessage: (data: unknown, transfer?: Transferable[]) => void;
	onmessage: ((event: MessageEvent) => void) | null;
};

type InitMsg = {
	type: "init";
	modelId: string;
	dtype?: "fp32" | "fp16" | "q8" | "q4";
	/** ONNX wasm 路径（WASM 回退路径用；webgpu 忽略） */
	wasmPaths?: string;
	/** HF 模型下载镜像源（写入 transformers env.remoteHost）；未传则用 transformers 默认（官方 HF）。
	 *  主线程侧经 normalizeRemoteHost 后总是传值（默认 hf-mirror.com）。 */
	remoteHost?: string;
};
type EmbedMsg = { type: "embed"; id: number; texts: string[] };
type DisposeMsg = { type: "dispose" };
/** 主线程桥接下载的回包（见 worker-backend setWorkerFetchBridge） */
type FetchResultMsg = {
	type: "fetch-result";
	id: number;
	status: number;
	buffer: ArrayBuffer | null;
	headers?: Record<string, string> | null;
	error?: string;
};
type IncomingMsg = InitMsg | EmbedMsg | DisposeMsg | FetchResultMsg;

type Extractor = (
	text: string | string[],
	options: { pooling: "mean"; normalize: boolean }
) => Promise<{ data: Float32Array; dims: number[] }>;

let extractor: Extractor | null = null;
let modelDimension: number | null = null;

/** 桥接 fetch 的在途请求表（id → resolve/reject），主线程 fetch-result 回包时结算。 */
const bridgePending = new Map<number, { resolve: (r: Response) => void; reject: (e: Error) => void; method: string }>();
let bridgeFetchId = 0;

function handleFetchResult(m: FetchResultMsg): void {
	const p = bridgePending.get(m.id);
	if (!p) return;
	bridgePending.delete(m.id);
	if (m.error || (!m.buffer && p.method !== "HEAD")) {
		p.reject(new Error(m.error ?? "bridge fetch failed"));
		return;
	}
	try {
		p.resolve(new Response(p.method === "HEAD" ? null : m.buffer, { status: m.status || 200, headers: m.headers ?? undefined }));
	} catch (e: unknown) {
		p.reject(e instanceof Error ? e : new Error(String(e)));
	}
}

function postLog(msg: string): void {
	self.postMessage({ type: "log", message: msg });
}

self.onmessage = (event: MessageEvent<IncomingMsg>) => {
	const data = event.data;
	// 桥接回包优先路由（不走 init/embed 分发）
	if (data && (data as FetchResultMsg).type === "fetch-result") {
		handleFetchResult(data as FetchResultMsg);
		return;
	}
	void (async () => {
		const msg = data;
		try {
			if (msg.type === "init") await handleInit(msg);
			else if (msg.type === "embed") await handleEmbed(msg);
			else if (msg.type === "dispose") {
				extractor = null;
				modelDimension = null;
			}
		} catch (err: unknown) {
			const m = err instanceof Error ? err.message : String(err);
			const stack = err instanceof Error ? err.stack : undefined;
			if (msg.type === "embed") {
				self.postMessage({ type: "result", id: msg.id, vectors: null, error: m });
			} else {
				self.postMessage({ type: "init-error", message: m, stack });
			}
		}
	})();
};

async function handleInit(msg: InitMsg): Promise<void> {
	// Obsidian Electron 渲染进程在 worker 里仍暴露 process（release.name === 'node'），
	// 会触发 transformers env.js 的 Node 检测，破坏模型加载。移除以强制走浏览器路径。
	Object.defineProperty(self, "process", {
		get: () => undefined,
		configurable: true,
	});
	// 同时屏蔽 globalThis.process（部分构建引用它）
	try {
		Object.defineProperty(self, "process", {
			get: () => undefined,
			configurable: true,
		});
	} catch {
		/* ignore */
	}

	// CORS 下载桥接：worker 内跨域 fetch 受浏览器 CORS 约束（hf-mirror 等镜像在
	// app:// origin 下 CORS 校验失败 → init 秒死静默降级关键词路，2026-09-16 实测）。
	// 把 http(s) fetch 委托主线程用 requestUrl（Electron net 层，无 CORS 约束）代发，
	// 回包组装标准 Response（transformers.js 照常写 CacheStorage，二次加载零网络）。
	// 桥接失败自动回退原生 fetch（官方 HF 等 CORS 友好源行为不变）。
	// ⚠️ 必须在 import transformers **之前**安装：transformers/ort 在模块求值时捕获
	// fetch 引用（实测 import 后覆写 self.fetch 不生效，桥接零调用）。
	const selfWithFetch = self as unknown as { fetch?: typeof fetch };
	const nativeFetch = typeof selfWithFetch.fetch === "function" ? selfWithFetch.fetch.bind(selfWithFetch) : null;
	if (nativeFetch) {
		selfWithFetch.fetch = ((input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
			const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
			if (!/^https?:/i.test(url)) return nativeFetch(input, init);
			const method =
				(init?.method ?? (typeof input === "object" && !(input instanceof URL) ? input.method : "GET")) ||
				"GET";
			const id = ++bridgeFetchId;
			const bridged = new Promise<Response>((resolve, reject) => {
				bridgePending.set(id, { resolve, reject, method });
				self.postMessage({ type: "fetch", id, url, method });
			});
			// 兜底=原生 fetch，但镜像源在浏览器 CORS 下必死（最初根因），回退不改 URL
			// 等于兜底必死（2026-09-16 deploy#10 教训：「下载：✗ 所有设备初始化失败」）。
			// 回退前把 hf-mirror 重写为官方源（ACAO:* 实测可用，慢但有真实进度）。
			return bridged.catch(() => {
				const rewritten = url.replace(/^https?:\/\/hf-mirror\.com\//i, "https://huggingface.co/");
				return nativeFetch(rewritten, init);
			});
		});
		postLog("[embedding-worker] fetch 桥接已安装（主线程代发，绕浏览器 CORS）");
	}

	// esbuild alias 会把 @huggingface/transformers 映射到 transformers.web.js
	const tfm = await import("@huggingface/transformers");

	// 模型下载镜像源（可选）：国内 HF 直连被限速（实测 ~20KB/s），hf-mirror.com ~540KB/s。
	// env.remoteHost 是 transformers.js 拼接模型 URL 的基址（默认 https://huggingface.co/）。
	// 注意：浏览器 CacheStorage 按 URL 缓存，换镜像源后模型会重新下载（各自独立缓存）。
	if (msg.remoteHost) {
		tfm.env.remoteHost = msg.remoteHost;
		postLog(`[embedding-worker] remoteHost=${msg.remoteHost}`);
	}

	// 配置 ORT wasm：wasm 回退路径用（webgpu 忽略）
	const ortWasm = (tfm.env as unknown as {
		backends?: { onnx?: { wasm?: { proxy?: boolean; numThreads?: number; wasmPaths?: string } } };
	}).backends?.onnx?.wasm;
	if (ortWasm) {
		ortWasm.proxy = false;
		ortWasm.numThreads = 1;
		if (msg.wasmPaths) ortWasm.wasmPaths = msg.wasmPaths;
	}

	const pipeline = tfm.pipeline;

	// WebGPU 后端不接受 int8 量化（HF Hub 只有 fp32/fp16 的 webgpu 文件），
	// WASM 后端用 q8 快 4 倍。按 device 选 dtype。
	const dtypeForDevice = (device: "webgpu" | "wasm"): "fp32" | "fp16" | "q8" | "q4" => {
		if (device === "webgpu") return "fp32";
		return msg.dtype ?? "q8";
	};

	const buildPipeline = (device: "webgpu" | "wasm") =>
		pipeline("feature-extraction", msg.modelId, {
			device,
			dtype: dtypeForDevice(device),
			progress_callback: (p: unknown) => {
				const pe = p as { status?: string; loaded?: number; total?: number; file?: string };
				if (pe && pe.status && typeof pe.loaded === "number" && typeof pe.total === "number") {
					self.postMessage({
						type: "progress",
						loaded: pe.loaded,
						total: pe.total,
						phase: `${pe.status}${pe.file ? ` ${pe.file}` : ""}`,
					});
				}
			},
		});

	// 探针 embed 学习维度，带超时（部分模型在 WebGPU 上 probe 可能挂起，超时即降级）
	// Web Worker 内没有 window 全局，定时器必须走 self（或 globalThis）。
	const wself = self as unknown as {
		setTimeout: (cb: () => void, ms: number) => unknown;
		clearTimeout: (h: unknown) => void;
	};
	const setT = wself.setTimeout.bind(wself);
	const clearT = wself.clearTimeout.bind(wself);
	const probeWithTimeout = (ext: Extractor, ms: number): Promise<{ data: Float32Array; dims: number[] }> =>
		new Promise((resolve, reject) => {
			const timer = setT(() => reject(new Error(`probe 超时（${ms / 1000}s）`)), ms);
			ext("_", { pooling: "mean", normalize: true })
				.then((r) => {
					clearT(timer);
					resolve(r);
				})
				.catch((e) => {
					clearT(timer);
					reject(e instanceof Error ? e : new Error(String(e)));
				});
		});

	const hasWebGpu =
		typeof (self as unknown as { navigator?: { gpu?: unknown } }).navigator?.gpu !== "undefined";
	postLog(`[embedding-worker] hasWebGpu=${hasWebGpu}`);

	// 依次尝试：webgpu → wasm，每次 build + probe 都纳入，probe 失败/挂起也触发降级
	const devices: Array<"webgpu" | "wasm"> = hasWebGpu ? ["webgpu", "wasm"] : ["wasm"];
	let built: unknown = null;
	let readyDim: number | null = null;
	for (const device of devices) {
		try {
			postLog(`[embedding-worker] trying device=${device} dtype=${device === "webgpu" ? "fp32" : (msg.dtype ?? "q8")} model=${msg.modelId}`);
			const ext = (await buildPipeline(device)) as Extractor;
			// WebGPU 的 fp32 probe 若挂起（部分模型/bundle 兼容问题），超时降级 wasm
			const probe = await probeWithTimeout(ext, device === "webgpu" ? 15_000 : 60_000);
			const dim = probe.dims[probe.dims.length - 1];
			built = ext;
			readyDim = dim;
			postLog(`[embedding-worker] device=${device} ready (dim=${dim})`);
			break;
		} catch (err: unknown) {
			const m = err instanceof Error ? err.message : String(err);
			postLog(`[embedding-worker] device=${device} failed (${m})`);
		}
	}
	if (!built || readyDim == null) {
		throw new Error("所有设备（webgpu/wasm）初始化失败");
	}
	extractor = built as Extractor;
	modelDimension = readyDim;

	self.postMessage({ type: "ready", dimension: modelDimension });
}

async function handleEmbed(msg: EmbedMsg): Promise<void> {
	if (!extractor) throw new Error("worker not initialised (call init first)");
	// 批量推理：一次处理整批文本（transformers.js feature-extraction 支持数组），
	// 返回 shape [batch, dim]。相比逐条 extractor(text)（每条约一次 GPU 推理），
	// 批量能大幅提速（构建索引 embed 数千条时尤为关键，~10-100x）。
	const out = await extractor(msg.texts, { pooling: "mean", normalize: true });
	const data = out.data;
	const batch = msg.texts.length;
	if (batch <= 0 || data.length === 0) {
		self.postMessage({ type: "result", id: msg.id, vectors: [], error: undefined });
		return;
	}
	const dim = data.length / batch;
	const vectors: Float32Array[] = [];
	for (let i = 0; i < batch; i++) {
		const copy = new Float32Array(dim);
		copy.set(data.subarray(i * dim, (i + 1) * dim));
		vectors.push(copy);
	}
	const transfers = vectors.map((v) => v.buffer);
	self.postMessage({ type: "result", id: msg.id, vectors }, transfers);
}

export {};

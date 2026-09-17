/**
 * 主线程侧：通过 Web Worker 运行本地 embedding（worker 内跑 @huggingface/transformers）。
 *
 * worker 源码由构建时内联进 main.js（见 esbuild.config.mjs 的 inlineWorkerSourcePlugin），
 * 运行时从插件模块拿到源码字符串，用 Blob URL 实例化 Worker——绕开 Obsidian 沙箱对
 * node_modules 包的原生 import 限制。
 *
 * 实现 LocalModelBackend 接口，可注入 LocalEmbeddingProvider（embedding.ts），
 * 对上层透明：LocalEmbeddingProvider 仍负责分批，本 backend 只负责「一批文本 → 向量」。
 */
import type { LocalModelBackend } from "@semantic/embedding";
import { logger } from "@shared/logger";

export type WorkerBackendConfig = {
	model: string;
	/** ONNX wasm 路径（WASM 回退路径用） */
	wasmPaths?: string;
	/** HF 模型下载镜像源（已归一化，worker 内写入 transformers env.remoteHost）；主线程侧总是传值（默认 hf-mirror.com） */
	remoteHost?: string;
};

/**
 * Worker 源码加载器（PERF-3）：由 app 层在启动时注入，运行时从插件目录读
 * embedding-worker.bundle.js 独立文件，替代原先「构建期内联进 main.js 的巨字符串」。
 * 纯关键词用户因此不再为内联 worker 源码付出 main.js 体积/解析成本。
 */
type WorkerSourceLoader = () => Promise<string>;
let workerSourceLoader: WorkerSourceLoader | null = null;

/** 注入 worker 源码加载器（app 层用 Obsidian adapter 读文件）。幂等。 */
export function setWorkerSourceLoader(loader: WorkerSourceLoader): void {
	workerSourceLoader = loader;
}

/**
 * 模型下载桥接（CORS 逃生通道）。
 *
 * 为什么需要：worker 内的跨域 fetch 受浏览器 CORS 约束。实测（2026-09-16，Playwright
 * 真 Chromium 复现）hf-mirror.com 等镜像在浏览器 CORS 校验下 `net::ERR_FAILED`
 * （node/curl 无 CORS 概念故冒烟测试通过——该盲区已留痕 P-0059），而 Obsidian 页面
 * origin 为 app:// 自定义 scheme，无法靠「换 origin」解决。官方 huggingface.co 有
 * ACAO:* 能过 CORS 但国内直连 ~20KB/s。
 *
 * 做法：worker 把 http(s) fetch 经 postMessage 委托给主线程，主线程用 HttpClient
 * （Obsidian requestUrl，Electron net 层，**无 CORS 约束**）取回字节，worker 侧组装
 * 标准 Response 交给 transformers.js（CacheStorage 照常缓存，二次加载零网络）。
 * 未注入桥接时 worker 回退原生 fetch（纯浏览器测试 / CORS 友好源仍可用）。
 */
export type WorkerFetchBridge = (
	url: string,
	method: string
) => Promise<{ status: number; buffer: ArrayBuffer | null; headers?: Record<string, string>; error?: string }>;
let workerFetchBridge: WorkerFetchBridge | null = null;

/** 装配期注入下载桥接（app/plugin.ts onload 调用）。幂等。 */
export function setWorkerFetchBridge(fn: WorkerFetchBridge): void {
	workerFetchBridge = fn;
}

/** 桥接是否已装配（设置页状态行展示用）。未装配时 worker 回退原生 fetch（受 CORS 约束）。 */
export function isWorkerFetchBridgeInstalled(): boolean {
	return workerFetchBridge !== null;
}

/**
 * 本地模型下载/加载进度上报器（首次触发时供搜索视图/设置页展示同款进度条）。
 * 由 app 层（plugin）注册，把 worker 的 `progress`/`ready`/`init-error` 事件
 * 统一归约成 { status, loaded, total }，写入 plugin.localModelState 供 UI 轮询。
 * 默认 no-op：未注册时 worker 仍正常加载，只是没有进度 UI。
 *
 * 为什么走模块级注册而非构造注入：WorkerLocalBackend 经 getShared 单例缓存，
 * 上层 LocalEmbeddingProvider 构造链（ai.ts → embedding.ts）未透传 UI 回调，
 * 模块级上报器以最小侵入把「下载进度」这一种跨层信号暴露出去，不改动 provider 链。
 */
export type ModelProgress = {
	status: "downloading" | "ready" | "error";
	loaded?: number;
	total?: number;
	error?: string;
};
type ModelProgressReporter = (p: ModelProgress) => void;
let modelProgressReporter: ModelProgressReporter | null = null;

/** 注册本地模型进度上报器（plugin.onload 调用一次）。 */
export function setModelProgressReporter(fn: ModelProgressReporter): void {
	modelProgressReporter = fn;
}

/** 主动上报模型下载进度（供 app 层分块下载桥接逐块汇报真实百分比）。 */
export function reportModelProgress(p: ModelProgress): void {
	modelProgressReporter?.(p);
}

type PendingEmbed = {
	resolve: (vecs: Float32Array[]) => void;
	reject: (err: Error) => void;
};

const INIT_TIMEOUT_MS = 240_000;
const EMBED_TIMEOUT_MS = 120_000;

export class WorkerLocalBackend implements LocalModelBackend {
	readonly name = "transformers.js (worker)";

	/** 按 model 单例缓存：同一模型复用同一 worker，模型只加载一次。
	 *  解决「每次搜索新建 provider → 新建 worker → 重新加载模型」的冷启动慢。 */
	private static instances = new Map<string, WorkerLocalBackend>();

	/** 本实例在 instances Map 中的 key（model 兜底后的归一值），失败时用于从 Map 移除自身。 */
	private readonly modelKey: string;

	/** 获取（或创建）某模型的共享实例。所有 LocalEmbeddingProvider 用同 model+镜像源时返回同一实例。 */
	static getShared(cfg: WorkerBackendConfig): WorkerLocalBackend {
		// model 兜底为默认 e5-small（与 embedding.ts DEFAULT_LOCAL_MODEL 保持一致；
		// 不能直接 import——embedding.ts 依赖本模块，会形成循环），确保预热/搜索共享同一 worker。
		// 镜像源进 key：切换 remoteHost 后新建实例（旧实例随下次重载自然释放），
		// 否则改了镜像仍复用旧 worker、新配置不生效。
		const model = cfg.model || "Xenova/multilingual-e5-small";
		const key = cfg.remoteHost ? `${model}|${cfg.remoteHost}` : model;
		let inst = WorkerLocalBackend.instances.get(key);
		if (!inst) {
			inst = new WorkerLocalBackend({ ...cfg, model }, key);
			WorkerLocalBackend.instances.set(key, inst);
		}
		return inst;
	}

	private worker: Worker | null = null;
	private workerUrl: string | null = null;
	private initPromise: Promise<void> | null = null;
	private initResolve: (() => void) | null = null;
	private initReject: ((err: Error) => void) | null = null;
	private nextId = 1;
	private readonly pending = new Map<number, PendingEmbed>();
	private failed = false;
	/** 模型是否已完成 init（ready 收到）。区分「init 阶段」与「运行期」错误（#29）。 */
	private ready = false;

	constructor(
		private readonly cfg: WorkerBackendConfig,
		modelKey = cfg.model || "Xenova/multilingual-e5-small",
	) {
		this.modelKey = modelKey;
	}

	async embed(texts: string[]): Promise<number[][]> {
		if (texts.length === 0) return [];
		if (this.failed) throw new Error("本地 embedding 已因沙箱限制禁用（本会话）");
		await this.init();
		const vecs = await this.embedBatch(texts);
		return vecs.map((v) => Array.from(v));
	}

	/** 预热：提前启动 worker + 加载模型（对齐 vault-curate 的 warmup），
	 *  让首次搜索免于冷启动等待。幂等；失败静默（首次 embed 时再报）。 */
	async warmup(): Promise<void> {
		if (this.failed) return;
		try {
			await this.init();
		} catch {
			/* 预热失败不阻断：首次 embed 时再抛清晰错误 */
		}
	}

	private async init(): Promise<void> {
		if (this.initPromise) return this.initPromise;
		if (this.worker) return;
		this.initPromise = new Promise<void>((resolve, reject) => {
			this.initResolve = resolve;
			this.initReject = reject;
		});
		try {
			await this.bootWorker();
		} catch (e: unknown) {
			this.failInit(e instanceof Error ? e : new Error(String(e)));
		}
		return this.initPromise;
	}

	private async bootWorker(): Promise<void> {
		logger.debug(`[Chinese Plugin Market] boot embedding worker（model=${this.cfg.model}${this.cfg.remoteHost ? ` · remoteHost=${this.cfg.remoteHost}` : ""}）`);
		// PERF-3：worker 源码运行时从插件目录读独立文件（替代构建期内联巨字符串）
		if (!workerSourceLoader) {
			throw new Error("worker 源码加载器未注入（app 层需调用 setWorkerSourceLoader）");
		}
		const workerSource = await workerSourceLoader();
		const blob = new Blob([workerSource], { type: "application/javascript" });
		this.workerUrl = URL.createObjectURL(blob);
		const worker = new Worker(this.workerUrl);
		this.worker = worker;

		worker.onmessage = (event: MessageEvent) => this.handleMessage(event.data);
		worker.onerror = (event: ErrorEvent) => {
			// init 阶段（模型尚未就绪）：整体失败 fail-fast（符合单例自恢复设计）。
			// 运行期错误：只 reject 在途 embed，保留 worker 供后续重试，不杀掉整个
			// 会话的本地语义搜索（#29：原先任意 embed 崩溃就 failInit→dispose，后续
			// getShared 新建实例重加载模型，冷启动可达 240s，语义搜索长时间不可用）。
			if (!this.ready) {
				this.failInit(new Error(event.message || "embedding worker error"));
				return;
			}
			logger.warn("[Chinese Plugin Market] embedding worker 运行期错误（保留 worker 供重试）：", event.message);
			for (const p of this.pending.values()) {
				p.reject(new Error(event.message || "embedding worker error"));
			}
			this.pending.clear();
		};

		// 初始化超时采用「按进展续表」而非固定窗口：worker 每收到一批下载 progress
		// 就重置计时器。原因：默认模型 e5-small 冷缓存首载 = tokenizer 17MB + 权重
		// 118MB ≈ 135MB，镜像源 ~540KB/s 也要 ~4.2min，超过旧的固定 240s 窗口必死；
		// 且浏览器 CacheStorage 中断不留 partial、重试从零下载——固定窗口会让用户在
		// 「差一点就下完」时被反复杀掉。改为：下载活着就不超时，停滞 240s 才判死。
		this.armInitTimer();

		worker.postMessage({
			type: "init",
			modelId: this.cfg.model,
			dtype: "q8",
			wasmPaths: this.cfg.wasmPaths,
			remoteHost: this.cfg.remoteHost,
		});
	}

	private initTimer: number | null = null;

	/** 初始化看门狗：INIT_TIMEOUT_MS 是「无进展窗口」——每次下载 progress 到达就续表
	 *  （见 handleMessage），ready 后清除。停滞满窗口才判死（failInit 可自恢复）。 */
	private armInitTimer(): void {
		if (this.initTimer !== null) window.clearTimeout(this.initTimer);
		this.initTimer = window.setTimeout(() => {
			this.initTimer = null;
			this.failInit(new Error(`本地模型加载超时（${INIT_TIMEOUT_MS / 1000}s 无进展），可能是下载停滞或网络不可用`));
		}, INIT_TIMEOUT_MS);
	}

	private embedBatch(texts: string[]): Promise<Float32Array[]> {
		if (!this.worker) throw new Error("worker not ready");
		const id = this.nextId++;
		return new Promise<Float32Array[]>((resolve, reject) => {
			const timer = window.setTimeout(() => {
				this.pending.delete(id);
				reject(new Error(`embed 超时（${EMBED_TIMEOUT_MS / 1000}s）`));
			}, EMBED_TIMEOUT_MS);
			this.pending.set(id, {
				resolve: (vecs) => {
					window.clearTimeout(timer);
					resolve(vecs);
				},
				reject: (err) => {
					window.clearTimeout(timer);
					reject(err);
				},
			});
			this.worker!.postMessage({ type: "embed", id, texts });
		});
	}

	private handleMessage(msg: unknown): void {
		const m = msg as
			| { type: "ready"; dimension: number }
			| { type: "init-error"; message: string; stack?: string }
			| { type: "progress"; loaded: number; total: number; phase?: string }
			| { type: "fetch"; id: number; url: string; method: string }
			| { type: "result"; id: number; vectors: Float32Array[] | null; error?: string }
			| { type: "log"; message: string };
		if (m.type === "log") {
			logger.warn(`[Chinese Plugin Market] ${m.message}`);
			return;
		}
		if (m.type === "fetch") {
			this.handleBridgeFetch(m.id, m.url, m.method);
			return;
		}
		if (m.type === "ready") {
			if (this.initTimer !== null) {
				window.clearTimeout(this.initTimer);
				this.initTimer = null;
			}
			logger.debug(`[Chinese Plugin Market] 本地 embedding 就绪（dim=${m.dimension}）`);
			this.ready = true;
			modelProgressReporter?.({ status: "ready" });
			this.initResolve?.();
		} else if (m.type === "init-error") {
			modelProgressReporter?.({ status: "error", error: m.message });
			this.failInit(new Error(`本地模型加载失败：${m.message}`));
		} else if (m.type === "progress") {
			// 下载仍在推进 → 续表（首载 135MB 远超单个 240s 窗口，只要活着就不该杀）
			if (!this.ready) this.armInitTimer();
			logger.debug(`[Chinese Plugin Market] 模型下载 ${Math.round((m.loaded / Math.max(1, m.total)) * 100)}%${m.phase ? ` ${m.phase}` : ""}`);
			// 上报下载进度：供首次本地搜索时复用设置页同款进度条/百分比
			if (typeof m.loaded === "number" && typeof m.total === "number" && m.total > 0) {
				modelProgressReporter?.({ status: "downloading", loaded: m.loaded, total: m.total });
			}
		} else if (m.type === "result") {
			const p = this.pending.get(m.id);
			if (!p) return;
			this.pending.delete(m.id);
			if (m.error || !m.vectors) p.reject(new Error(m.error ?? "embed failed"));
			else p.resolve(m.vectors);
		}
	}

	/** 在途桥接下载的心跳定时器（dispose 时统一清理）。 */
	private readonly bridgeHeartbeats = new Set<number>();

	/**
	 * 处理 worker 的 fetch 委托：主线程经桥接（requestUrl，无 CORS）取字节回传。
	 * 在途期间每 30s 续一次初始化看门狗——单文件（118MB 权重）下载时长可能远超
	 * 240s 空闲窗，但「在途」本身就是活着的证据，不该被判死。
	 */
	private handleBridgeFetch(id: number, url: string, method: string): void {
		if (!this.ready) this.armInitTimer();
		// 可观测性：桥接下载是 requestUrl 整包返回（无字节级进度），下载期间 worker 不会
		// 发 progress，界面会数分钟无任何动静（用户误判为卡死）。此处发一个「不确定态」
		// downloading（total=0），设置页据此显示「进行中（无百分比）」而非静止。
		if (!this.ready) modelProgressReporter?.({ status: "downloading", loaded: 0, total: 0 });
		const hb = window.setInterval(() => {
			if (!this.ready) this.armInitTimer();
		}, 30_000);
		this.bridgeHeartbeats.add(hb);
		void (async () => {
			let out: { status: number; buffer: ArrayBuffer | null; headers?: Record<string, string>; error?: string };
			try {
				out = workerFetchBridge
					? await workerFetchBridge(url, method)
					: { status: 0, buffer: null, error: "fetch 桥接未注入（app 装配期应调用 setWorkerFetchBridge）" };
			} catch (e: unknown) {
				out = { status: 0, buffer: null, error: e instanceof Error ? e.message : String(e) };
			}
			window.clearInterval(hb);
			this.bridgeHeartbeats.delete(hb);
			if (!this.ready) this.armInitTimer();
			const buffer = out.buffer ?? null;
			try {
				this.worker?.postMessage(
					{ type: "fetch-result", id, status: out.status, buffer, headers: out.headers ?? null, error: out.error },
					buffer ? [buffer] : []
				);
			} catch {
				/* worker 已终止：静默 */
			}
		})();
	}

	private failInit(err: Error): void {
		this.failed = true;
		this.initReject?.(err);
		// 从单例 Map 移除自身：失败多为瞬时（模型下载超时/网络慢），不应让整个会话的
		// 本地语义搜索永久失效。移除后下次 getShared 会创建干净实例（failed 重置为 false），
		// 用户重试或下次搜索即可恢复，而非死锁在本实例的 failed 标志上。
		WorkerLocalBackend.instances.delete(this.modelKey);
		this.dispose();
	}

	dispose(): void {
		// 看门狗一并拆除：防止 dispose 后残留 timer 触发 failInit 改动全局单例表
		if (this.initTimer !== null) {
			window.clearTimeout(this.initTimer);
			this.initTimer = null;
		}
		for (const hb of this.bridgeHeartbeats) window.clearInterval(hb);
		this.bridgeHeartbeats.clear();
		if (this.worker) {
			try {
				this.worker.postMessage({ type: "dispose" });
			} catch {
				/* ignore */
			}
			this.worker.terminate();
			this.worker = null;
		}
		if (this.workerUrl) {
			URL.revokeObjectURL(this.workerUrl);
			this.workerUrl = null;
		}
		for (const p of this.pending.values()) p.reject(new Error("backend disposed"));
		this.pending.clear();
		this.initPromise = null;
		this.initResolve = null;
		this.initReject = null;
	}
}

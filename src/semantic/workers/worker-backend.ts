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

	/** 获取（或创建）某模型的共享实例。所有 LocalEmbeddingProvider 用同 model 时返回同一实例。 */
	static getShared(cfg: WorkerBackendConfig): WorkerLocalBackend {
		// model 兜底为默认 bge，确保预热/搜索用同一 key 共享同一 worker
		const model = cfg.model || "Xenova/bge-small-zh-v1.5";
		const key = `${model}`;
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
		modelKey = cfg.model || "Xenova/bge-small-zh-v1.5",
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
		logger.debug(`[Chinese Plugin Market] boot embedding worker（model=${this.cfg.model}）`);
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

		const initTimer = window.setTimeout(() => {
			this.failInit(new Error(`本地模型加载超时（${INIT_TIMEOUT_MS / 1000}s），可能是模型下载太慢或网络不可用`));
		}, INIT_TIMEOUT_MS);

		worker.postMessage({
			type: "init",
			modelId: this.cfg.model,
			dtype: "q8",
			wasmPaths: this.cfg.wasmPaths,
		});
		// 保留 timer 引用以便 ready 后清除
		this.initTimer = initTimer;
	}

	private initTimer: number | null = null;

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
			| { type: "result"; id: number; vectors: Float32Array[] | null; error?: string }
			| { type: "log"; message: string };
		if (m.type === "log") {
			logger.warn(`[Chinese Plugin Market] ${m.message}`);
			return;
		}
		if (m.type === "ready") {
			if (this.initTimer !== null) {
				window.clearTimeout(this.initTimer);
				this.initTimer = null;
			}
			logger.debug(`[Chinese Plugin Market] 本地 embedding 就绪（dim=${m.dimension}）`);
			this.ready = true;
			this.initResolve?.();
		} else if (m.type === "init-error") {
			this.failInit(new Error(`本地模型加载失败：${m.message}`));
		} else if (m.type === "progress") {
			logger.debug(`[Chinese Plugin Market] 模型下载 ${Math.round((m.loaded / Math.max(1, m.total)) * 100)}%${m.phase ? ` ${m.phase}` : ""}`);
		} else if (m.type === "result") {
			const p = this.pending.get(m.id);
			if (!p) return;
			this.pending.delete(m.id);
			if (m.error || !m.vectors) p.reject(new Error(m.error ?? "embed failed"));
			else p.resolve(m.vectors);
		}
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

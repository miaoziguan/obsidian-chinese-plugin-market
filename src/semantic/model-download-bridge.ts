/**
 * 本地模型下载桥接（worker ↔ 主线程 requestUrl）。
 *
 * 为什么需要它：worker 内的跨域 fetch 受浏览器 CORS 约束，hf-mirror 等镜像在
 * `app://` origin 下会直接失败 → 本地语义静默降级为关键词路。故把下载委托给
 * 主线程的 requestUrl（Electron net 层，无 CORS 约束），字节回传 worker 组装 Response。
 *
 * 为什么分块：requestUrl 对上百 MB 的整包响应既没有进度、又有挂死/上限风险
 * （2026-09-16 实测 118MB 整包长时间不到齐）。按 8MB/块下载后每块即时上报真实百分比，
 * 单块失败整单报错，由 worker 回退原生 fetch 兜底。
 *
 * 本模块原本是 plugin.ts `onload` 内一个 120+ 行的闭包，因为闭包定义时不执行、
 * 无法被覆盖，导致整段下载逻辑长期零测试。抽出来只做一件事：把「依赖」显式化。
 * 逻辑与抽取前逐行等价，未做任何行为变更。
 */

/** 单块字节数（8MB） */
const DEFAULT_CHUNK_BYTES = 8 * 1024 * 1024;
/** 单块超时：任一块挂死 90s 即整单报错，交由 worker 回退原生 fetch */
const DEFAULT_CHUNK_TIMEOUT_MS = 90_000;
/** 源可用性探测超时 */
const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
/** 源探测结果缓存时长（10 分钟） */
const DEFAULT_CACHE_TTL_MS = 10 * 60_000;
/** 官方源（永远作为最后一个候选） */
const DEFAULT_OFFICIAL_HOST = "https://huggingface.co/";

export interface BridgeHttpRequest {
	url: string;
	method?: string;
	headers?: Record<string, string>;
}

export interface BridgeHttpResponse {
	status: number;
	headers: Record<string, string>;
	arrayBuffer?: ArrayBuffer;
}

/**
 * 与 worker-backend 的 ModelProgress 保持一致（含可选字段），
 * 这样调用方可以直接把 reportModelProgress 作为依赖注入，无需包装层。
 */
export interface BridgeProgress {
	status: "downloading" | "ready" | "error";
	loaded?: number;
	total?: number;
	error?: string;
}

export interface BridgeSourceCache {
	host: string;
	at: number;
}

export interface BridgeResult {
	status: number;
	buffer: ArrayBuffer | null;
	headers: Record<string, string>;
	/** 仅当所有候选源均不可达时出现；worker 据此给出可操作的错误提示 */
	error?: string;
}

export interface ModelDownloadBridgeDeps {
	/** 发起 HTTP（生产环境注入了 Obsidian requestUrl 适配器） */
	request(opts: BridgeHttpRequest): Promise<BridgeHttpResponse>;
	/** 规范化用户配置的镜像地址（无效时返回空串） */
	normalizeHost(raw?: string): string;
	/** 用户配置的镜像地址（可空） */
	getPreferredHost(): string | undefined;
	/** 进度上报：worker 下载量化模型时供界面展示百分比 */
	reportProgress(p: BridgeProgress): void;
	/** 读取源探测结果缓存 */
	getCache(): BridgeSourceCache | null;
	/** 写入源探测结果缓存 */
	setCache(cache: BridgeSourceCache): void;
	logger: { warn(...args: unknown[]): void; debug(...args: unknown[]): void };
	/** 可注入时钟（测试用；默认 Date.now） */
	now?(): number;
	officialHost?: string;
	chunkBytes?: number;
	chunkTimeoutMs?: number;
	probeTimeoutMs?: number;
	cacheTtlMs?: number;
}

export type ModelFetchBridge = (url: string, method: string) => Promise<BridgeResult>;

/** 把 HTTP 状态异常（非 206/200）显式抛出，交由切源逻辑处理 */
function assertRangeOk(r: BridgeHttpResponse): BridgeHttpResponse {
	if (r.status !== 206 && r.status !== 200) throw new Error(`HTTP ${r.status}`);
	return r;
}

export function createModelDownloadBridge(deps: ModelDownloadBridgeDeps): ModelFetchBridge {
	const officialHost = deps.officialHost ?? DEFAULT_OFFICIAL_HOST;
	const CHUNK = deps.chunkBytes ?? DEFAULT_CHUNK_BYTES;
	const CHUNK_TIMEOUT_MS = deps.chunkTimeoutMs ?? DEFAULT_CHUNK_TIMEOUT_MS;
	const PROBE_TIMEOUT_MS = deps.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
	const CACHE_TTL_MS = deps.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
	const clock = () => (deps.now ? deps.now() : Date.now());

	/** 单块超时包装：超时即整单报错，杜绝「无声挂死」状态（2026-09-16 用户反馈卡死） */
	const withTimeout = <T,>(p: Promise<T>, label: string, ms = CHUNK_TIMEOUT_MS): Promise<T> =>
		new Promise<T>((resolve, reject) => {
			const t = window.setTimeout(() => reject(new Error(`${label} 超时（${ms / 1000}s）`)), ms);
			p.then(
				(v) => {
					window.clearTimeout(t);
					resolve(v);
				},
				(e) => {
					window.clearTimeout(t);
					reject(e instanceof Error ? e : new Error(String(e)));
				},
			);
		});

	return async (url, method) => {
		// HEAD 只问存在性，不涉及分块
		if (method === "HEAD") {
			const r = await deps.request({ url, method });
			return { status: r.status, buffer: null, headers: r.headers };
		}

		const rewriteHost = (u: string, host: string) => u.replace(/^https?:\/\/[^/]+\//, host);

		// ── 源可用性探测（带缓存）──
		// 2026-09-16 实测：hf-mirror 与官方会**同时**被网络层封锁（http=000 / TLS reset），
		// 而无探测时每个文件都要对死源白等 90s/块才切换。探测=对候选源发 HEAD（10s 超时），
		// 选第一个活着的；全死则立即显式报错（设置页红字），不再无谓消耗。
		const candidates = [...new Set([deps.normalizeHost(deps.getPreferredHost()) ?? officialHost, officialHost])];
		const now = clock();
		const cache = deps.getCache();
		const cacheValid = !!cache && now - cache.at < CACHE_TTL_MS && candidates.includes(cache.host);
		if (!cacheValid) {
			let chosen: string | null = null;
			for (const h of candidates) {
				try {
					await withTimeout(
						deps.request({ url: rewriteHost(url, h), method: "HEAD" }),
						`源探测(${h})`,
						PROBE_TIMEOUT_MS,
					);
					chosen = h;
					break;
				} catch {
					deps.logger.warn(`[Chinese Plugin Market] 源探测不可达：${h}`);
				}
			}
			if (!chosen) {
				return {
					status: 0,
					buffer: null,
					headers: {},
					error: `所有下载源均不可达（${candidates.join(" / ")}），请稍后重试或在设置中更换镜像`,
				};
			}
			deps.setCache({ host: chosen, at: now });
		}

		// 文件粒度重置进度：避免上一个文件的 100% 被误读为当前文件进度
		deps.reportProgress({ status: "downloading", loaded: 0, total: 0 });
		const short = url.slice(url.lastIndexOf("/") + 1) || url;
		let base = rewriteHost(url, (deps.getCache() as BridgeSourceCache).host);

		// 下载中某块失败 → 切另一候选源续传（同文件 Range 偏移通用；只切不回）
		const fetchChunk = async (range: string, label: string): Promise<BridgeHttpResponse> => {
			const once = (u: string, tag: string) =>
				withTimeout(deps.request({ url: u, method: "GET", headers: { Range: range } }), tag).then(assertRangeOk);
			try {
				return await once(base, label);
			} catch (e: unknown) {
				const curHost = new URL(base).origin + "/";
				const other = candidates.find((c) => c !== curHost);
				if (!other) throw e;
				deps.logger.warn(
					`[Chinese Plugin Market] 桥接 ${short}：${label} 失败（${(e as Error)?.message ?? e}），切 ${other} 续传后续块`,
				);
				base = rewriteHost(url, other);
				deps.setCache({ host: other, at: clock() });
				return await once(base, `${label}@${other}`);
			}
		};

		const first = await fetchChunk(`bytes=0-${CHUNK - 1}`, `首块`);
		// 服务端不支持 Range（非 206 但 200）：整包已回，直接用
		if (first.status !== 206) {
			deps.logger.debug(`[Chinese Plugin Market] 桥接 ${short}：不支持 Range（HTTP ${first.status}），整包返回`);
			return { status: first.status, buffer: first.arrayBuffer ?? null, headers: first.headers };
		}

		const rangeHdr = first.headers["content-range"] ?? first.headers["Content-Range"] ?? "";
		const totalMatch = /\/(\d+)$/.exec(rangeHdr);
		const total = totalMatch ? Number(totalMatch[1]) : 0;
		const parts: Uint8Array[] = [];
		let loaded = 0;
		const push = (buf: ArrayBuffer | undefined) => {
			if (!buf) return;
			parts.push(new Uint8Array(buf));
			loaded += buf.byteLength;
			deps.reportProgress({ status: "downloading", loaded, total: total || loaded });
		};

		push(first.arrayBuffer);
		let offset = loaded;
		let chunkNo = 1;
		while (total > 0 && offset < total) {
			const end = Math.min(offset + CHUNK, total) - 1;
			const r = await fetchChunk(`bytes=${offset}-${end}`, `块${chunkNo}`);
			push(r.arrayBuffer);
			deps.logger.debug(
				`[Chinese Plugin Market] 桥接 ${short}：块${chunkNo} 完成 ${loaded}/${total}（${new URL(base).host}）`,
			);
			offset = end + 1;
			chunkNo++;
		}

		const merged = new Uint8Array(loaded);
		let at = 0;
		for (const p of parts) {
			merged.set(p, at);
			at += p.byteLength;
		}
		deps.reportProgress({ status: "downloading", loaded, total: total || loaded });
		return { status: 200, buffer: merged.buffer, headers: first.headers };
	};
}

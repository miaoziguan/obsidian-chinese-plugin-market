/**
 * HTTP 端口（依赖倒置）——底层不再直接依赖 Obsidian。
 *
 * 分层约定：data / domain / translation / semantic / shared 属于「下层」，
 * 不允许 import "obsidian"。它们只面向本文件声明的 `HttpClient` 接口编程，
 * 由 app 层（plugin.ts）在装配期把 Obsidian `requestUrl` 适配后注入进来。
 *
 * 好处：
 * - 下层可在纯 Node/vitest 环境下直接跑，无需 mock "obsidian" 模块；
 * - 未来替换实现（fetch / 自建代理 / 桌面端 Node http）只改装配点。
 */

/** 对齐 Obsidian requestUrl 的响应子集（调用方用到的字段） */
export interface HttpResponse {
	status: number;
	json: unknown;
	text: string;
	headers: Record<string, string>;
}

export interface HttpRequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** 预留：可选代理地址。当前实现直接忽略（跟随宿主网络栈）。 */
	proxy?: string;
}

/** 下层唯一认识的网络能力接口 */
export interface HttpClient {
	request(opts: HttpRequestOptions): Promise<HttpResponse>;
}

/**
 * 未注入时的兜底实现：抛出明确错误而非静默返回空响应。
 * 静默降级会让「忘记装配」变成难以定位的线上零结果，显式失败更容易发现。
 */
const notInstalled: HttpClient = {
	request() {
		return Promise.reject(
			new Error("[Chinese Plugin Market] HttpClient 未注入：请在 app 装配期调用 setHttpClient()"),
		);
	},
};

let current: HttpClient = notInstalled;

/** 装配期注入实现（app/plugin.ts onload 最早期调用） */
export function setHttpClient(client: HttpClient): void {
	current = client;
}

/** 取当前实现（主要供内部与单测使用） */
export function getHttpClient(): HttpClient {
	return current;
}

/** 仅供单测：还原为未注入状态 */
export function resetHttpClient(): void {
	current = notInstalled;
}

/**
 * 统一网络请求层（AI 搜索 / 翻译 / embedding 共用）。
 *
 * 直接用 Obsidian 自带的 requestUrl。实测在 Obsidian 里 requestUrl 本身就能
 * 正常联网，无需自建隧道。早期为「可选代理地址」引入的 Node net/tls 自建
 * CONNECT 隧道在 Obsidian 的 Electron 运行环境下会出现握手成功但收不到响应的
 * 挂死问题，故移除，恢复为直接 requestUrl。
 *
 * 响应形状对齐 requestUrl 的 RequestUrlResponse（status / json / text / headers），
 * 让调用方无需改动。proxy 字段保留以兼容调用方签名，但当前直接忽略（走 requestUrl）。
 */

import { requestUrl } from "obsidian";

/** 对齐 Obsidian requestUrl 的响应子集（调用方用到的字段） */
export interface NetResponse {
	status: number;
	json: any;
	text: string;
	headers: Record<string, string>;
}

export interface NetRequestOptions {
	url: string;
	method?: string;
	headers?: Record<string, string>;
	body?: string;
	/** 预留：可选代理地址。当前直接走 Obsidian requestUrl，忽略此字段。 */
	proxy?: string;
}

/**
 * 发起 HTTP(S) 请求，直接走 Obsidian requestUrl（保持原有行为，跟随系统代理/直连）。
 */
export async function netRequest(opts: NetRequestOptions): Promise<NetResponse> {
	const resp = await requestUrl({
		url: opts.url,
		method: opts.method ?? "GET",
		headers: opts.headers,
		body: opts.body,
		throw: false,
	});
	return { status: resp.status, json: resp.json, text: resp.text, headers: resp.headers };
}

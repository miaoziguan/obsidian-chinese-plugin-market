/**
 * 统一网络请求层（AI 搜索 / 翻译 / embedding 共用）。
 *
 * 依赖倒置：本文件不再直接 import "obsidian"，而是通过 `@data/net/http-port`
 * 的 `HttpClient` 接口调用宿主注入的实现（app/plugin.ts 装配期注入 requestUrl 适配器）。
 * 这样 data / domain / translation / semantic 全层可脱离 Obsidian 独立测试与复用。
 *
 * 历史说明：早期为「可选代理地址」引入的 Node net/tls 自建 CONNECT 隧道在 Obsidian 的
 * Electron 运行环境下会出现握手成功但收不到响应的挂死问题，故移除。proxy 字段保留以兼容
 * 调用方签名，但当前实现直接忽略（跟随系统代理/直连）。
 */

import { getHttpClient, type HttpRequestOptions, type HttpResponse } from "@data/net/http-port";

/** 对齐 Obsidian requestUrl 的响应子集（调用方用到的字段） */
export type NetResponse = HttpResponse;

export type NetRequestOptions = HttpRequestOptions;

/**
 * 发起 HTTP(S) 请求，委托给装配期注入的 HttpClient。
 */
export async function netRequest(opts: NetRequestOptions): Promise<NetResponse> {
	return getHttpClient().request({
		url: opts.url,
		method: opts.method ?? "GET",
		headers: opts.headers,
		body: opts.body,
	});
}

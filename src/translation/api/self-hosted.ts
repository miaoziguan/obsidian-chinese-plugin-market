/**
 * 自托管翻译源（DeepLX / LibreTranslate 等本地服务）。
 *
 * 与 Google/MyMemory 这类「连厂商云服务器」不同，自托管源跑在用户本机
 * （如 http://localhost:1188），数据不出本机、零成本、零限流、不受代理/被墙影响，
 * 且 DeepLX 质量显著优于 Google。作为可选增强：设置里填了地址才启用，
 * 不填则 Translator 不构造任何实例，行为完全不变。
 *
 * 复用 guard.ts 的 withTimeout + CircuitBreaker，与 GoogleClient 的熔断/超时策略一致；
 * 同样对返回做质量校验（空译文 / 原文回显视为无效，返回 null 走上层 fallback）。
 */

import type { PluginInfo, TranslateResult } from "@domain/catalog/translator";
import { logger } from "@shared/logger";
import { netRequest } from "@data/net/net";
import { withTimeout, CircuitBreaker } from "@translation/api/guard";

/** 自托管翻译源统一接口（与 GoogleClient.translate 形态一致） */
export interface SelfHostedTranslator {
	/** 稳定性探针 key（settings 列表去重 / 日志用） */
	readonly key: string;
	/** 供应商标记（写入 TranslateResult.provider） */
	readonly provider: "deeplx" | "libretranslate";
	/** 熔断开路期间返回 false，fallback 链应跳过 */
	isAvailable(): boolean;
	/** 翻译单个插件（name + desc），成功返回 source="online"；失败/未变化返回 null */
	translate(plugin: PluginInfo): Promise<TranslateResult | null>;
}

/** 质量校验：大小写归一后译文与原文相同 → 视为未翻译（回显），返回 null */
function isUnchanged(translated: string, original: string): boolean {
	return translated.trim().toLowerCase() === original.trim().toLowerCase();
}

/**
 * DeepLX 客户端（逆向 DeepL 网页版的开源本地服务，兼容官方 /v2/translate）。
 * 接口：POST {baseUrl}/translate
 * 请求体：{ text: [..], source_lang: "EN", target_lang: "ZH" }
 * 响应：{ translations: [{ text, detected_source_lang }] }
 */
export class DeepLXClient implements SelfHostedTranslator {
	readonly provider = "deeplx" as const;
	readonly key: string;
	private baseUrl: string;
	private breaker = new CircuitBreaker(2, 60_000);

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.key = `deeplx:${this.baseUrl}`;
	}

	isAvailable(): boolean {
		return !this.breaker.isOpen();
	}

	async translate(plugin: PluginInfo): Promise<TranslateResult | null> {
		if (this.breaker.isOpen()) return null;
		try {
			const [nameR, descR] = await Promise.all([
				this.callApi(plugin.name),
				this.callApi(plugin.description),
			]);
			// HTTP 层已成功：复位熔断器（否则 consecutive 会累计成"永久开路"）
			this.breaker.recordSuccess();
			// 两者都未变化（都没翻出来）→ 视为无效，走上层 fallback
			if (isUnchanged(nameR, plugin.name) && isUnchanged(descR, plugin.description)) {
				return null;
			}
			return {
				translatedName: isUnchanged(nameR, plugin.name) ? plugin.name : nameR,
				translatedDesc: isUnchanged(descR, plugin.description) ? plugin.description : descR,
				source: "online",
				provider: "deeplx",
			};
		} catch (e: unknown) {
			this.breaker.recordFailure(false);
			logger.warn(`[Chinese Plugin Market] DeepLX 翻译失败 (${plugin.id}):`, e);
			return null;
		}
	}

	private async callApi(text: string): Promise<string> {
		const truncated = text.length > 500 ? text.slice(0, 500) : text;
		const resp = await withTimeout(
			netRequest({
				url: `${this.baseUrl}/translate`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					text: [truncated],
					source_lang: "EN",
					target_lang: "ZH",
				}),
			}),
			8000,
			"DeepLX"
		);
		const json = resp.json as { translations?: Array<{ text?: string }> };
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`DeepLX HTTP ${resp.status}：${(resp.text || "").slice(0, 120)}`);
		}
		if (!json || !Array.isArray(json.translations) || !json.translations[0]?.text) {
			throw new Error("DeepLX 返回非预期结构");
		}
		return json.translations[0].text;
	}
}

/**
 * LibreTranslate 客户端（开源翻译引擎本地实例）。
 * 接口：POST {baseUrl}/translate
 * 请求体：{ q, source: "en", target: "zh", format: "text" }
 * 响应：{ translatedText }
 */
export class LibreTranslateClient implements SelfHostedTranslator {
	readonly provider = "libretranslate" as const;
	readonly key: string;
	private baseUrl: string;
	private breaker = new CircuitBreaker(2, 60_000);

	constructor(baseUrl: string) {
		this.baseUrl = baseUrl.replace(/\/+$/, "");
		this.key = `libretranslate:${this.baseUrl}`;
	}

	isAvailable(): boolean {
		return !this.breaker.isOpen();
	}

	async translate(plugin: PluginInfo): Promise<TranslateResult | null> {
		if (this.breaker.isOpen()) return null;
		try {
			const [nameR, descR] = await Promise.all([
				this.callApi(plugin.name),
				this.callApi(plugin.description),
			]);
			// HTTP 层已成功：复位熔断器（否则 consecutive 会累计成"永久开路"）
			this.breaker.recordSuccess();
			if (isUnchanged(nameR, plugin.name) && isUnchanged(descR, plugin.description)) {
				return null;
			}
			return {
				translatedName: isUnchanged(nameR, plugin.name) ? plugin.name : nameR,
				translatedDesc: isUnchanged(descR, plugin.description) ? plugin.description : descR,
				source: "online",
				provider: "libretranslate",
			};
		} catch (e: unknown) {
			this.breaker.recordFailure(false);
			logger.warn(`[Chinese Plugin Market] LibreTranslate 翻译失败 (${plugin.id}):`, e);
			return null;
		}
	}

	private async callApi(text: string): Promise<string> {
		const truncated = text.length > 500 ? text.slice(0, 500) : text;
		const resp = await withTimeout(
			netRequest({
				url: `${this.baseUrl}/translate`,
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					q: truncated,
					source: "en",
					target: "zh",
					format: "text",
				}),
			}),
			8000,
			"LibreTranslate"
		);
		const json = resp.json as { translatedText?: string };
		if (resp.status < 200 || resp.status >= 300) {
			throw new Error(`LibreTranslate HTTP ${resp.status}：${(resp.text || "").slice(0, 120)}`);
		}
		if (!json || typeof json.translatedText !== "string" || !json.translatedText.trim()) {
			throw new Error("LibreTranslate 返回非预期结构");
		}
		return json.translatedText;
	}
}

/**
 * 由设置列表构建自托管翻译源实例（按质量优先级排序后返回）。
 * - 过滤空 baseUrl
 * - 质量序：DeepLX > LibreTranslate
 * 返回空数组时 Translator 不插入任何节点，行为完全不变。
 */
export function buildSelfHostedTranslators(
	list: { type: "deeplx" | "libretranslate"; baseUrl: string }[] | undefined,
): SelfHostedTranslator[] {
	if (!list || list.length === 0) return [];
	const rank: Record<string, number> = { deeplx: 0, libretranslate: 1 };
	return list
		.filter((t) => t.baseUrl && t.baseUrl.trim())
		.map((t) => {
			const base = t.baseUrl.trim().replace(/\/+$/, "");
			if (t.type === "deeplx") return new DeepLXClient(base);
			return new LibreTranslateClient(base);
		})
		.sort((a, b) => rank[a.provider] - rank[b.provider]);
}

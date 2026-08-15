/**
 * 翻译 API 客户端集合
 *
 * 从 Translator God Object 中抽出，化为四个独立、可单测的客户端：
 * - MyMemoryClient — 免费翻译 API（每日 5000 字符）
 * - TencentClient — 腾讯翻译 API（TC3-HMAC-SHA256）
 * - LLMClient — OpenAI 兼容 LLM 调用
 * - callAITranslate — AI 翻译（复用 LLMClient）
 */

import { logger } from "@shared/logger";
import { tencentTranslate, type TencentApiConfig } from "@translation/api/tencent-signer";
import type { TranslateResult, PluginInfo } from "@domain/catalog/translator";
import { parseJSON, extractLLMContent, supportsJsonMode, normalizeBaseUrl } from "@shared/utils";
import { netRequest } from "@data/net/net";
import {
	withTimeout,
	CircuitBreaker,
	CircuitOpenError,
	isFatalError,
} from "@translation/api/guard";

// 在线翻译超时（弱网下快速失败，落到下一来源）
const MYMEMORY_TIMEOUT = 4000;
const TENCENT_TIMEOUT = 5000;
const GOOGLE_TIMEOUT = 5000;
const LLM_TIMEOUT = 30000;

// ───────── 类型 ─────────

/** MyMemory 翻译返回 */
interface MyMemoryResult {
	translatedName: string;
	translatedDesc: string;
	match: number;
}

/** MyMemory http://api.mymemory.translated.net/get 原始 JSON */
interface MyMemoryResponse {
	responseStatus: number;
	responseDetails?: string;
	responseData?: {
		translatedText?: string;
		match?: number;
	};
}

// ───────── MyMemoryClient ─────────

const QUOTA_HINTS = ["PLEASE SELECT", "QUOTA", "MYMEMORY WARNING", "TRY AGAIN"];

export class MyMemoryClient {
	private enabled = true;
	private blocked = false;
	private blockedDate: string | null = null;
	// 弱网/瞬时错误的快速熔断：连续失败达阈值后短时间内跳过，避免每个插件都重试
	private netBreaker = new CircuitBreaker(3, 60_000);

	setEnabled(v: boolean) { this.enabled = v; }

	/** 从持久化恢复拦截状态（可选，用于跨会话保持每日限制） */
	restoreBlockedDate(d: string | null) {
		if (d) {
			// 跨天自动解除
			if (d !== todayStr()) return;
			this.blocked = true;
			this.blockedDate = d;
		}
	}

	/** 翻译单个插件（name + desc），成功返回 source="online"，失败/被限流返回 null */
	async translate(plugin: PluginInfo): Promise<TranslateResult | null> {
		if (!this.enabled) return null;

		// 跨天自动恢复
		if (this.blocked && this.blockedDate && this.blockedDate !== todayStr()) {
			this.blocked = false;
			this.blockedDate = null;
		}
		if (this.blocked) return null;
		// 弱网熔断中：直接跳过，不发起请求
		if (this.netBreaker.isOpen()) return null;

		try {
			const namePromise = this.callApi(plugin.name);
			const descPromise = this.callApi(plugin.description);
			const [nameR, descR] = await Promise.allSettled([namePromise, descPromise]);
			// 任一段真实失败（网络/超时/配额提示）→ 整条走降级，避免「半失败」被固化为 online
			// （unchanged 已不再是失败：无需翻译的词由 callApi 标记 unchanged，不是 rejected）
			if (nameR.status === "rejected" || descR.status === "rejected") {
				const reason: unknown =
					nameR.status === "rejected" ? nameR.reason : (descR as PromiseRejectedResult).reason;
				throw reason instanceof Error ? reason : new Error("name and description both failed");
			}
			const nameRes = nameR.value;
			const descRes = descR.value;
			// 两段都未变（专有名词整条无需翻译）→ 判无效走降级（不记熔断，见 catch 特殊处理，
			// 语义对齐 Google「结果未变化」兜底路径）
			if (nameRes.unchanged && descRes.unchanged) {
				throw new Error("MyMemory 翻译结果未变化");
			}
			this.netBreaker.recordSuccess();
			return {
				translatedName: nameRes.unchanged ? plugin.name : nameRes.text,
				translatedDesc: descRes.unchanged ? plugin.description : descRes.text,
				source: "online",
				provider: "mymemory",
			};
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/429|quota|mymemory warning|配额|额度|rate.?limit/i.test(msg)) {
				if (!this.blocked) {
					this.blocked = true;
					this.blockedDate = todayStr();
					logger.warn(
						"[Chinese Plugin Market] MyMemory 额度已耗尽（429/配额），今日内不再调用 MyMemory，未译插件将走其他来源或原文兜底（跨天自动恢复）。"
					);
				}
			} else if (msg === "MyMemory 翻译结果未变化") {
				// 无需翻译：正常兜底路径，不算失败、不记熔断
			} else {
				// 非配额类（含弱网/超时）→ 计入瞬时熔断
				this.netBreaker.recordFailure(isFatalError(e));
				logger.warn(`[Chinese Plugin Market] MyMemory 翻译失败 (${plugin.id}):`, e);
			}
			return null;
		}
	}

	/** 翻译单段文本（供 mergeOffline 批量使用） */
	async translateText(text: string): Promise<MyMemoryResult | null> {
		if (!this.enabled || this.blocked || this.netBreaker.isOpen()) return null;
		try {
			const res = await this.callApi(text);
			this.netBreaker.recordSuccess();
			return { translatedName: res.text, translatedDesc: "", match: 0 };
		} catch (e: unknown) {
			this.netBreaker.recordFailure(isFatalError(e));
			return null;
		}
	}

	/** 是否已触达每日限额 */
	isBlocked(): boolean { return this.blocked; }

	/** 持久化 blockedDate */
	getBlockedDate(): string | null { return this.blockedDate; }

	// ── 内部 ──

	private async callApi(text: string): Promise<BlockResult> {
		if (!text || text.trim().length === 0) return { text, unchanged: true };
		const truncated = text.length > 500 ? text.substring(0, 500) : text;
		const encoded = encodeURIComponent(truncated);
		const url = `https://api.mymemory.translated.net/get?q=${encoded}&langpair=en|zh-CN`;
		const response = await withTimeout(
			netRequest({ url, method: "GET", headers: { "Accept": "application/json" } }),
			MYMEMORY_TIMEOUT,
			"MyMemory"
		);
		const json = response.json as MyMemoryResponse;
		if (!json || typeof json !== "object") {
			throw new Error("MyMemory 返回非 JSON 响应");
		}
		const parsed = json;

		if (parsed.responseStatus === 200 && parsed.responseData?.translatedText) {
			const translated = parsed.responseData.translatedText;
			const isQuotaHint = QUOTA_HINTS.some((h) => translated.toUpperCase().includes(h));
			const isUnchanged = translated.trim().toLowerCase() === text.trim().toLowerCase();
			const isAllCaps = translated.toUpperCase() === translated && text.toUpperCase() !== text;
			if (isQuotaHint) {
				throw new Error("MyMemory 未返回有效译文（配额提示）");
			}
			// 原文/全大写回显（专有名词无需翻译）：同 Google「结果未变化」语义，标记 unchanged 保留原文，
			// 不算失败、不记熔断（否则热门大牌连锁回显会使 MyMemory 层提前熔断，后续批量翻译失效）
			if (isUnchanged || isAllCaps) {
				return { text: truncated, unchanged: true };
			}
			return { text: translated, unchanged: false };
		}
		throw new Error(`MyMemory API 错误: ${parsed.responseStatus} ${parsed.responseDetails || ""}`);
	}
}

/** 单段翻译结果：text 为译文（unchanged 时为原文）；unchanged 表示服务原样返回（无需翻译） */
interface BlockResult {
	text: string;
	unchanged: boolean;
}

// ───────── GoogleClient ─────────

/**
 * Google 翻译（非官方 web 接口，零配置免费）。
 *
 * 走 translate.googleapis.com 的逆向前端接口（client=gtx），无需 API Key，
 * 开箱即用，作为比 MyMemory 社区记忆库质量更好的免费兜底。
 *
 * 注意：非官方接口，无 SLA、返回结构偶有变动、隐性限流，故：
 *   - 同样挂熔断器（弱网/瞬时失败快速跳过，避免逐条挂起）；
 *   - 对返回做质量校验（空译文/原文回显/全大写 视为无效）。
 * 任何失败都返回 null，由上层 fallback 链继续走 MyMemory / 原文。
 */
export class GoogleClient {
	private enabled = true;
	private blocked = false;
	private blockedDate: string | null = null;
	// 弱网/瞬时错误的快速熔断：连续失败达阈值后短时间内跳过，避免每个插件都重试
	private netBreaker = new CircuitBreaker(3, 60_000);

	setEnabled(v: boolean) { this.enabled = v; }
	isEnabled() { return this.enabled; }

	/** 从持久化恢复拦截状态（可选，用于跨会话保持每日限制） */
	restoreBlockedDate(d: string | null) {
		if (d) {
			// 跨天自动解除
			if (d !== todayStr()) return;
			this.blocked = true;
			this.blockedDate = d;
		}
	}
	isBlocked() { return this.blocked; }
	getBlockedDate(): string | null { return this.blockedDate; }

	/** 翻译单个插件（name + desc），成功返回 source="online" provider="google"，失败/被限流返回 null */
	async translate(plugin: PluginInfo): Promise<TranslateResult | null> {
		if (!this.enabled) return null;
		if (this.blocked) return null;
		if (this.netBreaker.isOpen()) return null;

		try {
			const [nameR, descR] = await Promise.allSettled([
				this.callApi(plugin.name),
				this.callApi(plugin.description),
			]);
			// 任一段 rejected（结构/空/超时等硬失败）→ 收集原因，走 fallback
			if (nameR.status === "rejected" || descR.status === "rejected") {
				const reason: unknown =
					nameR.status === "rejected" ? nameR.reason : (descR as PromiseRejectedResult).reason;
				throw reason instanceof Error ? reason : new Error("name and description both failed");
			}

			const nameRes = nameR.value;
			const descRes = descR.value;
			// 只有当 name 和 description 都完全未变（Google 一个都没翻出来）时，才视为无效，走 MyMemory 兜底。
			// 否则接受「部分未变」：例如插件名是专有名词，Google 返回原文，但描述已翻译——仍比完全 fallback 要好。
			if (nameRes.unchanged && descRes.unchanged) {
				logger.debug(`[Chinese Plugin Market] Google 翻译未变化（${plugin.id}），走 MyMemory 兜底`);
				throw new Error("Google 翻译结果未变化");
			}

			this.netBreaker.recordSuccess();
			return {
				translatedName: nameRes.unchanged ? plugin.name : nameRes.text,
				translatedDesc: descRes.unchanged ? plugin.description : descRes.text,
				source: "online",
				provider: "google",
			};
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			if (/429|quota|rate.?limit|额度|配额|too many/i.test(msg)) {
				if (!this.blocked) {
					this.blocked = true;
					this.blockedDate = todayStr();
					logger.warn(
						"[Chinese Plugin Market] Google 翻译触发限流，今日内不再调用 Google，未译插件将走 MyMemory / 原文兜底（跨天自动恢复）。"
					);
				}
			} else if (msg === "Google 翻译结果未变化") {
				// 正常 fallback 路径，不算硬失败：不记熔断、不打 warn
			} else {
				this.netBreaker.recordFailure(isFatalError(e));
				logger.warn(`[Chinese Plugin Market] Google 翻译失败 (${plugin.id}):`, e);
			}
			return null;
		}
	}

	/** 翻译单段文本（供外部批量使用） */
	async translateText(text: string): Promise<string | null> {
		if (!this.enabled || this.blocked || this.netBreaker.isOpen()) return null;
		try {
			const res = await this.callApi(text);
			this.netBreaker.recordSuccess();
			return res.unchanged ? text : res.text;
		} catch (e: unknown) {
			this.netBreaker.recordFailure(isFatalError(e));
			return null;
		}
	}

	// ── 内部 ──

	private async callApi(text: string): Promise<{ text: string; unchanged: boolean }> {
		if (!text || text.trim().length === 0) return { text, unchanged: true };
		const truncated = text.length > 500 ? text.substring(0, 500) : text;
		const encoded = encodeURIComponent(truncated);
		const url =
			`https://translate.googleapis.com/translate_a/single` +
			`?client=gtx&sl=en&tl=zh-CN&dt=t&q=${encoded}`;
		const response = await withTimeout(
			netRequest({ url, method: "GET", headers: { "Accept": "application/json" } }),
			GOOGLE_TIMEOUT,
			"Google 翻译"
		);
		const json = response.json as unknown[][];
		if (!Array.isArray(json) || !Array.isArray(json[0])) {
			throw new Error("Google 返回非预期结构");
		}
		// 拼接所有片段的译文（json[0][i][0]）
		const pieces: string[] = [];
		for (const seg of json[0]) {
			if (Array.isArray(seg) && typeof seg[0] === "string") pieces.push(seg[0]);
		}
		const translated = pieces.join("");
		if (!translated.trim()) {
			throw new Error("Google 未返回有效译文");
		}
		const isUnchanged = translated.trim().toLowerCase() === truncated.trim().toLowerCase();
		// 不再单独拦截「全大写」：专有名词（如 MCP/Agent）Google 常返回全大写形式，
		// 这种回显已被 isUnchanged（大小写归一后比较）捕获并交由上层按未变化处理；
		// 单独拦截会把正常全大写英文译文误判为无效而抛错告警。
		return { text: translated, unchanged: isUnchanged };
	}
}

function todayStr(): string {
	// 用本地日期而非 UTC：MyMemory「每日」限额按用户本地跨天恢复，
	// 否则中国时区要到早上 8 点才解除，与提示文案不符。
	const d = new Date();
	const m = String(d.getMonth() + 1).padStart(2, "0");
	const day = String(d.getDate()).padStart(2, "0");
	return `${d.getFullYear()}-${m}-${day}`;
}

// ───────── TencentClient ─────────

export class TencentClient {
	private config: TencentApiConfig | null = null;
	// 凭证无效/超配额/弱网时熔断：连续失败达阈值后短时间内跳过，避免每个插件都重试
	private breaker = new CircuitBreaker(2, 60_000, 24 * 3600_000);

	setConfig(c: TencentApiConfig) { this.config = c; }

	/** 熔断器是否开路（开路期间应跳过腾讯翻译，直接走其他来源） */
	isAvailable(): boolean { return !this.breaker.isOpen(); }

	async translate(text: string): Promise<string> {
		if (!this.config) throw new Error("未配置翻译 API");
		if (this.breaker.isOpen()) throw new CircuitOpenError("腾讯翻译");
		try {
			const translated = await withTimeout(
				tencentTranslate(text, this.config),
				TENCENT_TIMEOUT,
				"腾讯翻译"
			);
			this.breaker.recordSuccess();
			return translated;
		} catch (e: unknown) {
			// 开路错误属内部熔断信号，不再重复计入
			if (e instanceof CircuitOpenError) throw e;
			this.breaker.recordFailure(isFatalError(e));
			throw e;
		}
	}
}

// ───────── LLMClient ─────────

export class LLMClient {
	private breaker = new CircuitBreaker(2, 60_000, 24 * 3600_000);

	constructor(
		private config: {
			baseURL: string;
			apiKey: string;
			model: string;
			temperature?: number;
		}
	) {}

	/** 更新部分配置（用于运行时切换模型/Key） */
	updateConfig(patch: Partial<{ baseURL: string; apiKey: string; model: string; temperature: number }>) {
		Object.assign(this.config, patch);
	}

	/** 熔断器是否开路（开路期间 AI 翻译应跳过，走 MyMemory/腾讯/原文） */
	isAvailable(): boolean { return !this.breaker.isOpen(); }

	/**
	 * 调用 LLM 并返回 content 文本。
	 * @param maxTokens 输出最大 token 数
	 * @param forceJson 是否强制 JSON 输出（白名单模型安全）
	 */
	async call(
		systemPrompt: string,
		userPrompt: string,
		maxTokens: number,
		forceJson = true
	): Promise<string> {
		if (this.breaker.isOpen()) throw new CircuitOpenError("AI 翻译");
		const body: Record<string, unknown> = {
			model: this.config.model,
			messages: [
				{ role: "system", content: systemPrompt },
				{ role: "user", content: userPrompt },
			],
			temperature: this.config.temperature ?? 0.1,
			max_tokens: maxTokens,
		};
		if (forceJson && supportsJsonMode(this.config.model)) {
			body.response_format = { type: "json_object" };
		}

		try {
			const response = await withTimeout(
				netRequest({
					url: `${normalizeBaseUrl(this.config.baseURL)}/v1/chat/completions`,
					method: "POST",
					headers: {
						"Authorization": `Bearer ${this.config.apiKey}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				}),
				LLM_TIMEOUT,
				"AI 翻译"
			);

			if (response.status < 200 || response.status >= 300) {
				let detail = "";
				try {
					const errJson = response.json as {
						error?: { message?: string };
						message?: string;
					} | null;
					detail = errJson?.error?.message || errJson?.message || "";
				} catch {
					detail = (response.text || "").slice(0, 120);
				}
				const hint = LLMClient.httpStatusHint(response.status);
				throw new Error(
					`HTTP ${response.status}${hint ? `（${hint}）` : ""}${detail ? `：${detail}` : ""}`
				);
			}

			const content = extractLLMContent(response.json);
			this.breaker.recordSuccess();
			return content;
		} catch (e: unknown) {
			if (e instanceof CircuitOpenError) throw e;
			this.breaker.recordFailure(isFatalError(e));
			throw e;
		}
	}

	/** HTTP 状态码 → 常见原因提示 */
	static httpStatusHint(status: number): string {
		switch (status) {
			case 401: return "API Key 无效或未授权";
			case 403: return "无权限访问（Key 或账户受限）";
			case 404: return "接口地址或模型不存在，检查 Base URL / 模型名";
			case 429: return "请求过于频繁或额度耗尽";
			case 500:
			case 502:
			case 503: return "服务端错误，稍后重试";
			default: return "";
		}
	}
}

// ───────── AI 翻译 ─────────

/**
 * AI 翻译：用 LLM 把插件 name/description 译为自然中文。
 * 成功返回 source="ai" 的结果；失败返回 null（由调用方降级到机翻）。
 */
export async function callAITranslate(
	llm: LLMClient,
	plugin: PluginInfo,
): Promise<TranslateResult | null> {
	const system =
		"你是 Obsidian 插件本地化专家。把用户给出的插件英文 name 与 description 翻译成自然、简洁的中文，" +
		"符合中文用户习惯：name 译为简短中文名（通用英文术语可保留），description 译为通顺中文。" +
		'只输出 JSON：{"name": "中文name", "description": "中文description"}，不要任何解释或额外文字。';
	const user = `name: ${plugin.name}\ndescription: ${plugin.description}`;
	// 熔断器开路（端点不可达/超配额）时直接跳过，避免逐条无谓请求
	if (!llm.isAvailable()) return null;
	try {
		const content = await llm.call(system, user, 1024);
		const parsed = parseJSON(content);
		const name = typeof parsed.name === "string" ? parsed.name.trim() : "";
		const description = typeof parsed.description === "string" ? parsed.description.trim() : "";
		if (!name) return null;
		return {
			translatedName: name,
			translatedDesc: description || plugin.description,
			source: "ai",
		};
	} catch (e: unknown) {
		logger.warn(`[Chinese Plugin Market] AI 翻译失败 (${plugin.id}):`, e);
		return null;
	}
}

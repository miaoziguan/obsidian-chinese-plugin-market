/**
 * 腾讯翻译（免费）客户端 —— 逆向 transmart.qq.com/api/imt（零配置、无密钥）。
 *
 * 对应腾讯「腾讯翻译 (Transmart) Chrome 扩展」使用的同源接口：
 * - text_analysis          文本语种检测（翻译前必须先拿到 source.lang，空串会直接失败）
 * - auto_translation_block 文本块翻译
 *
 * 零成本免费、无配额焦虑，作为 fallback 免费来源插在 Google 与 MyMemory 之间；
 * 也可作为用户显式选择的翻译通道（工具栏「翻译 ▼」下拉）。
 * 复用 guard.ts 的 withTimeout + CircuitBreaker，与 Google/MyMemory 的容错策略一致；
 * 同样对返回做质量校验（空译文 / 原文回显 视为无效；全大写回显经归一后归入原文回显）。
 */

import type { PluginInfo, TranslateResult } from "@domain/catalog/translator";
import { logger } from "@shared/logger";
import { netRequest } from "@data/net/net";
import { withTimeout, CircuitBreaker, isFatalError } from "@translation/api/guard";

const TRANSMART_API_URL = "https://transmart.qq.com/api/imt";
const TRANSMART_TIMEOUT = 5000;
/** 与现有在线免费层（Google/MyMemory/自托管）一致：超长文本只取前 500 字符（暂不按句分块） */
const TEXT_CHAR_LIMIT = 500;
/**
 * 批量块（换行拼接）的字符上限。
 * 实测：1052 字符 / 10 行、2062 字符 / 20 行均完整返回且行数严格保留（约 1.3~1.6s），
 * 500 只是历史保守值，并非通道硬限制。取 2000 留出余量 —— 再大收益递减、
 * 且一旦被服务端截断就会破坏「按行对齐」的还原依据。
 */
const BATCH_CHAR_LIMIT = 2000;

/** client_key 前缀（对齐腾讯 Transmart 扩展的生成规则） */
const CLIENT_KEY_PREFIX = "tencent_transmart_crx_";

/** 生成 client_key：固定前缀 + 基于 UA 的 Base64，整体截前 100 字符 */
export function generateClientKey(userAgent: string): string {
	return (CLIENT_KEY_PREFIX + btoa(userAgent)).slice(0, 100);
}

/** transmart.qq.com/api/imt 响应的关键字段（其余忽略） */
interface TransmartResponse {
	header?: { ret_code?: string };
	language?: string;
	auto_translation?: string;
}

/** 单段翻译结果：text 为译文（unchanged 时为原文）；unchanged 表示腾讯原样返回（无需翻译） */
interface BlockResult {
	text: string;
	unchanged: boolean;
}

export class TransmartClient {
	private enabled = true;
	private netBreaker = new CircuitBreaker(3, 60_000);
	private readonly clientKey: string;

	constructor(userAgent?: string) {
		// 仅作 client_key 随机种子：不读 navigator（Obsidian 规范禁 navigator API，
		// 且 UA 只是伪造 client_key 的种子，无 UA 时用空串亦可）
		this.clientKey = generateClientKey(userAgent ?? "");
	}

	setEnabled(v: boolean) {
		this.enabled = v;
	}

	/** 未启用 / 熔断开路时返回 false，fallback 链应跳过 */
	isAvailable(): boolean {
		return this.enabled && !this.netBreaker.isOpen();
	}

	/**
	 * 翻译单个插件（name + desc）。成功返回 source="online"、provider="tencent-transmart"；
	 * 失败 / 检测到中文源（无需翻译）返回 null，由上层 fallback 链继续。
	 *
	 * 与 Google 层保持一致的「unchanged」语义：
	 * - 单段返回原文（专有名词无需翻译）不算失败，标记 unchanged；
	 * - name/desc 任一段真正译出即整体成功（未变那段保留原名）；
	 * - 仅当两段都 unchanged（腾讯全都没翻出来）才判无效走降级；
	 * - 回显不计熔断，只有网络/超时/空译文等真实失败才记 recordFailure。
	 */
	async translate(plugin: PluginInfo): Promise<TranslateResult | null> {
		if (!this.isAvailable()) return null;

		try {
			// 先检测源语种：source.lang 不可为空，空串会导致 API 返回 error/busy
			const srcLang = await this.detectLanguage(plugin.name);
			// 中文源文本视为无需翻译（本插件面向 en→zh）
			if (srcLang === "zh") return null;

			const [nameR, descR] = await Promise.allSettled([
				this.translateText(plugin.name, srcLang),
				this.translateText(plugin.description, srcLang),
			]);
			// 任一段真实失败（网络/超时/空译文）→ 整条走降级，避免「半失败」被固化成 online
			if (nameR.status === "rejected" || descR.status === "rejected") {
				const reason: unknown =
					nameR.status === "rejected" ? nameR.reason : (descR as PromiseRejectedResult).reason;
				throw reason instanceof Error ? reason : new Error("腾讯翻译（免费）name/description 均未译出");
			}
			const nameRes = nameR.value;
			const descRes = descR.value;
			// 两段都未变（腾讯对整条原文回显）：判无效走降级（不计熔断，见 catch 特殊处理）
			if (nameRes.unchanged && descRes.unchanged) {
				throw new Error("腾讯翻译（免费）原文回显");
			}
			this.netBreaker.recordSuccess();
			return {
				translatedName: nameRes.unchanged ? plugin.name : nameRes.text,
				translatedDesc: descRes.unchanged ? plugin.description : descRes.text,
				source: "online",
				provider: "tencent-transmart",
			};
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			// 纯「无需翻译/回显」是正常兜底路径（同 Google 的「未变化」）：不记熔断、不打 warn
			if (msg.includes("原文回显")) return null;
			this.netBreaker.recordFailure(isFatalError(e));
			logger.warn(
				`[Chinese Plugin Market] 腾讯翻译（免费）翻译失败 (${plugin.id}) name="${plugin.name.slice(0, 40)}":`,
				e
			);
			return null;
		}
	}

	/** 语种检测（text_analysis）：失败 / 空结果回退 "en"（文档建议，不阻塞翻译） */
	private async detectLanguage(text: string): Promise<string> {
		try {
			const json = await this.callApi({
				header: { fn: "text_analysis", client_key: this.clientKey },
				text,
			});
			return (json.language || "en").trim() || "en";
		} catch {
			return "en";
		}
	}

	/**
	 * 翻译单个长文本块（详情页 README 分段用）：自动检测语种，中文段原样返回（无需翻译），
	 * 超 500 字符截断（README 分段由调用方按此限制切好，此处仅兜底）。
	 * 失败抛错；原文回显段视为「未变」返回原文，由调用方按段保留。
	 */
	async translateSegment(text: string): Promise<string> {
		if (!this.isAvailable()) throw new Error("腾讯翻译（免费）当前不可用");
		if (!text || !text.trim()) return text;
		const srcLang = await this.detectLanguage(text);
		if (srcLang === "zh") return text;
		const r = await this.translateText(text, srcLang);
		this.netBreaker.recordSuccess();
		return r.text;
	}

	/**
	 * 批量翻译短串（设置页 DOM 通道专用）：把多条用换行拼成一个块，一次请求译完再按行拆分。
	 *
	 * 实测依据：腾讯通道对 \n 分隔的文本**严格保留行数**（20 条进 → 20 行出，逐行对齐），
	 * 于是「一屏几十条设置项文案」从 2N 个请求（每条 detect + translate）压缩到 1 个请求，
	 * 首屏耗时从约 35 秒降到数秒。源语言固定按 "en" 送 —— 调用方已过滤掉含 CJK 的文本，
	 * 省掉每条一次的 text_analysis 往返。
	 *
	 * 失败 / 行数不符 / 任一条含换行 / 超长一律返回 null，由调用方降级为逐条翻译
	 * （正确性优先：宁可慢，也不能把译文错配到别的设置项上）。
	 */
	async translateSegments(texts: string[]): Promise<string[] | null> {
		if (!this.isAvailable() || texts.length === 0) return null;
		// 含换行的串会破坏「按行对齐」的还原依据，整块放弃批量
		if (texts.some((t) => !t.trim() || t.includes("\n"))) return null;
		const joined = texts.join("\n");
		if (joined.length > BATCH_CHAR_LIMIT) return null;
		try {
			const r = await this.translateText(joined, "en", BATCH_CHAR_LIMIT);
			if (r.unchanged) return null; // 整块原文回显：交给逐条处理
			const lines = r.text.split("\n").map((s) => s.trim());
			if (lines.length !== texts.length) return null;
			if (lines.some((s) => !s)) return null; // 出现空行说明对齐不可靠
			this.netBreaker.recordSuccess();
			return lines;
		} catch (e: unknown) {
			this.netBreaker.recordFailure(isFatalError(e));
			logger.warn("[Chinese Plugin Market] 腾讯翻译（免费）批量分段失败:", e);
			return null;
		}
	}

	/** 单段翻译结果：text 为译文（unchanged 时为原文）；unchanged 表示腾讯原样返回（无需翻译） */

	/**
	 * 翻译单段文本（auto_translation_block）：超 maxLen 字符截断。
	 * 空译文 / 真实 API 错误抛错；原文回显（含全大写经归一命中）不算失败，标记 unchanged 返回 ——
	 * 专有名词返回原文是正常结果，判失败只会触发降级 + 熔断累积（热门大牌连锁致整批失效）。
	 */
	private async translateText(
		text: string,
		srcLang: string,
		maxLen: number = TEXT_CHAR_LIMIT,
	): Promise<BlockResult> {
		if (!text || !text.trim()) return { text, unchanged: true };
		const truncated = text.length > maxLen ? text.substring(0, maxLen) : text;
		const json = await this.callApi({
			header: { fn: "auto_translation_block", client_key: this.clientKey },
			source: { lang: srcLang, text_block: truncated },
			target: { lang: "zh" },
		});
		const translated = json.auto_translation ?? "";
		if (!translated.trim()) throw new Error("腾讯翻译（免费）未返回有效译文");
		// 原文回显判定：全大写回显（如 HOTKEYS++）经 toLowerCase 归一后同样命中。
		// 正常全大写英文译文（如专有名词 NASA）也归入 unchanged → 保留原文，不误伤为失败。
		if (translated.trim().toLowerCase() === truncated.trim().toLowerCase()) {
			return { text: truncated, unchanged: true };
		}
		return { text: translated, unchanged: false };
	}

	/** 统一 POST transmart.qq.com/api/imt；ret_code !== "succ"（busy/error）视为失败。
	 *  busy（限流）是瞬时态，最多退避重试 2 次再放弃，避免高并发翻译立刻触发限流时整批失败。 */
	private async callApi(body: Record<string, unknown>): Promise<TransmartResponse> {
		const RETRY_BUSY = 2;
		for (let attempt = 0; attempt <= RETRY_BUSY; attempt++) {
			const response = await withTimeout(
				netRequest({
					url: TRANSMART_API_URL,
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify(body),
				}),
				TRANSMART_TIMEOUT,
				"腾讯翻译（免费）"
			);
			const json = response.json as TransmartResponse | null;
			if (!json || typeof json !== "object") {
				throw new Error("腾讯翻译（免费）返回非 JSON 响应");
			}
			const code = json.header?.ret_code;
			if (code === "succ") return json;
			if (code === "busy" && attempt < RETRY_BUSY) {
				await new Promise((r) => window.setTimeout(r, 600 * (attempt + 1)));
				continue;
			}
			throw new Error(`腾讯翻译（免费）API 错误: ${code ?? "unknown"}`);
		}
		throw new Error("腾讯翻译（免费）API 错误: busy 重试耗尽");
	}
}

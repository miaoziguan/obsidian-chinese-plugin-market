/**
 * 百度机器翻译 API 通道（通用翻译 API v2）。
 *
 * 与腾讯云翻译（TC3-HMAC-SHA256）、自托管源（DeepLX/LibreTranslate）并列的可选翻译源。
 * 百度通用翻译走「appid + 密钥」做 MD5 明文签名，质量与腾讯云翻译同档、优于免费
 * Google/MyMemory，作为多源 fallback 链中的可选节点。
 *
 * 接入方式对称 TencentClient：setConfig / isAvailable（熔断）/ translate，由 Translator
 * 在主翻译链中按质量序调用。
 */

import { netRequest } from "@data/net/net";
import { CircuitBreaker, withTimeout } from "@translation/api/guard";
import { logger } from "@shared/logger";
import { md5Hex } from "@shared/md5";

/** 百度翻译请求超时（与其它在线翻译源一致，避免弱网/网关无响应时挂起整条 fallback 链） */
const BAIDU_TIMEOUT = 8000;

export interface BaiduApiConfig {
	appId: string;
	key: string;
}

/** 百度翻译网关错误码 → 友好提示 */
const BAIDU_ERROR_MESSAGES: Record<string, string> = {
	"52000": "成功",
	"52001": "请求超时，请重试",
	"52002": "系统错误，请重试",
	"52003": "未授权（appid 或密钥错误）",
	"54000": "必填参数缺失（appid / q / salt / sign）",
	"54001": "签名错误（sign 校验失败，密钥不匹配）",
	"54003": "访问频率受限（QPS 超限），请稍后重试",
	"54004": "账户余额不足",
	"54005": "长 query 频率受限（单日配额），请稍后重试",
	"58000": "非法请求（appid 未授权或 IP 不在白名单）",
	"58001": "语言不支持（from/to 组合无效）",
	"90107": "appid 未开通翻译服务权限",
};

/**
 * 百度机器翻译客户端。
 * 仅翻译英文 → 中文（en → zh）场景：插件名/描述均为英文原文。
 */
export class BaiduTranslateClient {
	private config: BaiduApiConfig | null = null;
	// 凭证无效/超配额/弱网时熔断：连续失败达阈值后短时间内跳过，避免每个插件都重试
	private breaker = new CircuitBreaker(2, 60_000, 24 * 3600_000);

	/** 熔断器是否开路（开路期间应跳过百度翻译，直接走其他来源） */
	isAvailable(): boolean {
		return !!this.config && !this.breaker.isOpen();
	}

	setConfig(c: BaiduApiConfig | null): void {
		this.config = c;
	}

	async translate(text: string): Promise<string> {
		if (!text.trim()) return text;
		if (!this.config) throw new Error("未配置百度翻译 appid/密钥");
		const { appId, key } = this.config;
		const salt = String(Math.floor(Math.random() * 1e8));
		const sign = md5Hex(appId + text + salt + key);
		const params = new URLSearchParams({
			q: text,
			from: "en",
			to: "zh",
			appid: appId,
			salt,
			sign,
		});
		let resp;
		try {
			resp = await withTimeout(
				netRequest({
					url: "https://fanyi-api.baidu.com/api/trans/vip/translate",
					method: "POST",
					headers: { "Content-Type": "application/x-www-form-urlencoded" },
					body: params.toString(),
				}),
				BAIDU_TIMEOUT,
				"百度翻译"
			);
		} catch (e: unknown) {
			this.breaker.recordFailure();
			const msg = e instanceof Error ? e.message : String(e);
			logger.warn("[Baidu] 翻译请求失败：", msg);
			throw new Error(`百度翻译网络请求失败：${msg}`);
		}
		// HttpResponse.json 类型为 unknown。Obsidian adapter 实际返回已解析对象（非函数），
		// 这里保留「若为函数则调用」的兼容分支；显式收窄为 () => unknown 以消除 no-unsafe-call。
		const jsonField = resp.json;
		const rawJson: unknown =
			typeof jsonField === "function" ? (jsonField as () => unknown)() : jsonField;
		const json = rawJson as {
			error_code?: string;
			error_msg?: string;
			trans_result?: { dst: string }[];
		};
		if (json.error_code) {
			this.breaker.recordFailure();
			const hint = BAIDU_ERROR_MESSAGES[json.error_code] ?? json.error_msg ?? "未知错误";
			logger.warn(`[Baidu] 翻译失败 ${json.error_code}：${hint}`);
			throw new Error(`百度翻译失败（${json.error_code}）：${hint}`);
		}
		const dst = json.trans_result?.[0]?.dst;
		if (!dst) {
			this.breaker.recordFailure();
			logger.warn("[Baidu] 翻译结果为空");
			throw new Error("百度翻译返回为空");
		}
		this.breaker.recordSuccess();
		return dst;
	}
}

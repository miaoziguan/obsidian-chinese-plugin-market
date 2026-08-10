/**
 * 翻译在线客户端的容错原语：超时 + 熔断器。
 *
 * 解决的问题（弱网 / 超配额降级体验）：
 * 1. 三个在线翻译（MyMemory / 腾讯 / LLM）原本都没有超时，弱网下请求会
 *    一直挂起，卡住整条回退链；withTimeout 让慢请求快速失败并落到下一来源。
 * 2. 腾讯 / LLM 原本没有熔断，凭证无效或超配额时每翻译一个插件都会 throw +
 *    catch + 刷日志，成百上千条结果就重试成百上千次；CircuitBreaker 在连续
 *    失败后短时间内「开路」，让本批次剩余插件直接跳过该来源。
 */

/** 超时错误（区别于真实的网络/HTTP 错误） */
export class TimeoutError extends Error {
	constructor(ms: number, label = "") {
		super(
			`请求超时（>${ms}ms）${label ? `：${label}` : ""}（未在阈值内收到响应，已跳过该来源）`
		);
		this.name = "TimeoutError";
	}
}

/** 熔断器开路时抛出的错误（调用方应视为「该来源暂时不可用」，直接降级） */
export class CircuitOpenError extends Error {
	constructor(label = "翻译服务") {
		super(
			`${label} 熔断器已开路，暂时跳过（服务连续失败过多，本批次直接降级）`
		);
		this.name = "CircuitOpenError";
	}
}

/**
 * 给一个 Promise 套上超时。超时后 reject TimeoutError，但 original 仍在后台
 * 运行（不会被取消，只是结果被丢弃），避免悬挂引用。
 */
export function withTimeout<T>(original: Promise<T>, ms: number, label = ""): Promise<T> {
	return new Promise<T>((resolve, reject) => {
		const timer = window.setTimeout(() => reject(new TimeoutError(ms, label)), ms);
		original.then(
			(v) => {
				window.clearTimeout(timer);
				resolve(v);
			},
			(e) => {
				window.clearTimeout(timer);
				reject(e instanceof Error ? e : new Error(String(e)));
			}
		);
	});
}

/**
 * 简单熔断器：连续失败达到阈值即「开路」一段时间；期间调用 isOpen() 为 true，
 * 调用方应跳过该来源。冷却结束后进入「半开」状态允许一次试探；成功则复位，
 * 失败（尤其 fatal）会重新开路（fatal 用更长的冷却，如鉴权/配额永久失效）。
 */
export class CircuitBreaker {
	private consecutive = 0;
	private openedAt = 0;
	private cooldown = 0;

	/**
	 * @param threshold   连续失败多少次后开路（瞬时错误，含超时）
	 * @param baseCooldownMs 瞬时错误开路后的冷却时长
	 * @param fatalCooldownMs fatal 错误（鉴权/配额）开路后的冷却时长
	 */
	constructor(
		private readonly threshold: number,
		private readonly baseCooldownMs: number,
		private readonly fatalCooldownMs: number = baseCooldownMs
	) {}

	/** 当前是否处于开路（冷却中）；冷却结束自动复位为半开试探 */
	isOpen(): boolean {
		if (this.openedAt === 0) return false;
		if (Date.now() - this.openedAt >= this.cooldown) {
			// 进入半开：允许一次试探
			this.openedAt = 0;
			this.consecutive = 0;
			return false;
		}
		return true;
	}

	/** 本次调用成功：复位计数与开路状态 */
	recordSuccess(): void {
		this.consecutive = 0;
		this.openedAt = 0;
	}

	/**
	 * 本次调用失败。
	 * @param fatal 是否为「鉴权/配额/超时」类错误（开路更久）
	 */
	recordFailure(fatal = false): void {
		if (fatal) {
			this.openedAt = Date.now();
			this.cooldown = this.fatalCooldownMs;
			this.consecutive = 0;
			return;
		}
		this.consecutive += 1;
		if (this.consecutive >= this.threshold) {
			this.openedAt = Date.now();
			this.cooldown = this.baseCooldownMs;
		}
	}
}

/**
 * 从错误信息判断是否为「fatal」类（鉴权/配额），应触发长冷却。
 *
 * 注意：TimeoutError 不再视为 fatal。瞬时超时是弱网抖动，当天内会自己恢复，
 * 走瞬时错误的短冷却（baseCooldownMs）即可；若也按 fatal 24h 开路，会让
 * 「一次抖动 = 该来源整天被跳过」的错误降级。真正不会自愈的是鉴权（401/403）
 * 与配额（429/quota），它们才用长冷却。
 */
export function isFatalError(e: unknown): boolean {
	const msg = e instanceof Error ? e.message : String(e);
	return /401|403|429|quota|额度|配额|rate.?limit|unauthorized|forbidden|api key/i.test(msg);
}

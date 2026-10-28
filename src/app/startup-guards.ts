/**
 * onload 启动期的两个「沉默失败」防护。
 *
 * 它们原先内联在 onload 里，都是那种「平时不生效、出事时才救命」的代码，
 * 正因如此最容易被后续改动顺手删掉或改错，却没有任何测试会失败。
 */

/**
 * 安全加载 data.json。
 *
 * Obsidian 的 loadData() 在 JSON 损坏时会直接从 JSON.parse 抛出，
 * 而 onload 里任何未捕获异常都会让**整个插件加载中止** —— 用户看到的是
 * 「插件彻底不可用」，且没有任何提示。这里兜底为空白状态：设置可重建，
 * 插件必须永远能启动。
 */
export async function loadSettingsDataSafely(deps: {
	load(): Promise<unknown>;
	warn(message: string, error: unknown): void;
}): Promise<Record<string, unknown>> {
	try {
		return ((await deps.load()) as Record<string, unknown>) ?? {};
	} catch (e: unknown) {
		deps.warn("[Chinese Plugin Market] data.json 解析失败，已回退空白状态（原文件可能损坏）：", e);
		return {};
	}
}

export interface TmApprovedValveDeps {
	/**
	 * 原始的 resolve 实现。
	 * 必须由调用方在**替换前**捕获——否则超时回调会调到替换后的包装版本，形成递归。
	 */
	originalResolve(): void;
	/** 用包装后的实现替换实例方法（包装体负责记录「已放行」） */
	setResolve(fn: () => void): void;
	warn(message: string): void;
	timeoutMs?: number;
	timer?(fn: () => void, ms: number): unknown;
}

/**
 * tmApprovedReady 的 30s 安全阀。
 *
 * 极少数情况下 scanVaultTM 会在重 IO（写大 JSON / 重扫）时卡住不返回，
 * 导致 tmApprovedReady 永不 resolve、首屏视图永久停在加载页。这里兜底强制放行，
 * 视图降级为「无 vault 译名兜底」，下个 reload 会重新尝试回灌。
 *
 * 用闭包标志位而非重复 resolve 判定：Promise 重复 resolve 是 no-op，
 * 若只靠它，回灌正常完成时也会到点打印「兜底超时」假报警，误导排查。
 */
export function armTmApprovedSafetyValve(deps: TmApprovedValveDeps): void {
	let settled = false;
	deps.setResolve(() => {
		settled = true;
		deps.originalResolve();
	});
	const timer = deps.timer ?? ((fn: () => void, ms: number) => window.setTimeout(fn, ms));
	timer(
		() => {
			if (settled) return; // 回灌已正常完成，不误报
			deps.warn(
				"[Chinese Plugin Market] tmApprovedReady 兜底超时（30s）：视图已降级继续，vault 译名可能未回灌。",
			);
			deps.originalResolve();
		},
		deps.timeoutMs ?? 30_000,
	);
}

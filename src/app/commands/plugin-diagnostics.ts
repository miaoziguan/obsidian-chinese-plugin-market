/**
 * 命令面板里的两个「诊断类」命令体。
 *
 * 从 plugin.onload 的内联 callback 抽出来的理由很简单：`addCommand({...})` 这层
 * 注册在 onload 执行时就会被覆盖，**只有 callback 内部的行永远不执行**。
 * 这两段恰好是 callback 里有真实分支逻辑的部分（视图守卫、可滚动判定、更新结果文案），
 * 留在闭包里等于长期零测试。
 *
 * 抽取保持行为等价：文案、超时、判定阈值一字未改。
 */

/** 视图能力的最小面：只声明诊断用到的字段 */
export interface MarketViewLike {
	scrollViewport?: HTMLElement | null;
	ctx: { outdatedIds?: { size: number } };
}

export interface ScrollDiagnosticDeps {
	/** 返回当前市场视图；未打开时为 null */
	findView(): MarketViewLike | null;
	notify(message: string, timeout?: number): void;
	logDebug(info: unknown): void;
}

export interface CheckUpdatesDeps {
	findView(): MarketViewLike | null;
	notify(message: string, timeout?: number): void;
	refreshOutdated(ctx: MarketViewLike["ctx"]): Promise<void>;
	t(key: string, vars?: Record<string, string>): string;
}

/** 视图未打开时的统一提示（两个命令共用，避免一处改了另一处忘了） */
const NEED_VIEW = "请先打开插件搜索视图";

/**
 * 诊断滚动布局：把 viewport 与其父容器的**实际计算样式**打出来。
 * 用于排查「列表高度不对 / 无法滚动 / 被 flex 压塌」这类只能在运行时观察的问题。
 */
export function runScrollLayoutDiagnostic(deps: ScrollDiagnosticDeps): void {
	const view = deps.findView();
	if (!view) {
		deps.notify(NEED_VIEW);
		return;
	}
	const vp = view.scrollViewport;
	if (!vp) {
		deps.notify("scrollViewport 不存在");
		return;
	}
	const cs = getComputedStyle(vp);
	const root = vp.parentElement;
	const rcs = root ? getComputedStyle(root) : null;
	const info = {
		viewportClientH: vp.clientHeight,
		viewportScrollH: vp.scrollHeight,
		viewportScrollTop: vp.scrollTop,
		viewportDisplay: cs.display,
		viewportPosition: cs.position,
		viewportHeight: cs.height,
		viewportOverflowY: cs.overflowY,
		rootClass: root?.className ?? "(无)",
		rootDisplay: rcs?.display ?? "(无)",
		rootPosition: rcs?.position ?? "(无)",
		rootHeight: rcs?.height ?? "(无)",
		canScroll: vp.scrollHeight > vp.clientHeight + 1,
	};
	deps.logDebug(info);
	const msg =
		`列表高度=${info.viewportClientH}px | 内容总高=${info.viewportScrollH}px | 可滚动=${info.canScroll}\n` +
		`viewport: display=${info.viewportDisplay} position=${info.viewportPosition} overflowY=${info.viewportOverflowY}\n` +
		`root(.${info.rootClass}): display=${info.rootDisplay} position=${info.rootPosition} height=${info.rootHeight}`;
	deps.notify(msg, 15000);
}

/**
 * 一键检查已安装插件更新：结果只有三种出口——无更新 / 有 n 个更新 / 检查失败。
 * 失败必须单独出口，否则用户会把「检查失败」误读成「已是最新」。
 */
export async function runCheckUpdates(deps: CheckUpdatesDeps): Promise<void> {
	const view = deps.findView();
	if (!view) {
		deps.notify(NEED_VIEW);
		return;
	}
	try {
		await deps.refreshOutdated(view.ctx);
		const n = view.ctx.outdatedIds?.size ?? 0;
		if (n <= 0) deps.notify(deps.t("action.checkUpdate.upToDate"));
		else deps.notify(deps.t("action.checkUpdate.available", { n: String(n) }));
	} catch {
		deps.notify(deps.t("action.checkUpdate.failed"));
	}
}

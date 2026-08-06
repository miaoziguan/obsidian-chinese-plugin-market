/**
 * 列表区单一状态机。
 *
 * 历史上引导 / 加载 / 错误 / AI 等待 / AI 配置 / 列表六种互斥画面
 * 靠 showingGuide 布尔 + 各处手动切换 resultCountEl.display 协调，
 * 已多次产出「找到 0 个」误导计数、空态覆盖引导页等回归。
 * 收敛为单一 listState：状态互斥、计数可见性由状态派生，不再手动开关。
 */

export type ListState = "guide" | "loading" | "error" | "aiPending" | "aiConfig" | "list";

/** setListState 只依赖 ctx 的这两个字段，便于测试与解耦（避免模块环依赖） */
export interface ListStateHost {
	listState: ListState;
	resultCountEl: HTMLElement | null;
}

/**
 * 统一切换列表区状态：落状态 + 派生「找到 N 个」计数的可见性。
 * 计数只在 list 态显示——其余态（引导/加载/错误/AI）显示计数都是误导。
 */
export function setListState(ctx: ListStateHost, state: ListState): void {
	ctx.listState = state;
	if (ctx.resultCountEl) {
		ctx.resultCountEl.setCssStyles({ display: state === "list" ? "" : "none" });
	}
}

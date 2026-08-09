import { Platform } from "obsidian";

/**
 * 平台能力安全访问（#5/#6：移动端分支判断）。
 *
 * Obsidian 在真机/桌面端常量导出 `Platform`（含 isMobile / isPhone 等），
 * 但单元测试（jsdom）下 `obsidian` 的 `Platform` 可能未定义，直接读
 * `Platform.isMobile` 会抛 TypeError。统一走此守卫，测试环境按「非移动端」处理。
 */
export function isMobileEnvironment(): boolean {
	try {
		return typeof Platform !== "undefined" && Platform.isMobile === true;
	} catch {
		return false;
	}
}

type IdleHandle = number;

/** 原生的 requestIdleCallback / cancelIdleCallback（可能缺失，如旧版移动端 WebView） */
type IdleWindow = Window & {
	requestIdleCallback?: (cb: (deadline?: { didTimeout: boolean }) => void, opts?: { timeout: number }) => number;
	cancelIdleCallback?: (handle: number) => void;
};

/**
 * 空闲期调度，带移动端兜底（#24）。
 *
 * 部分移动端 WebView（旧版 Android System WebView、个别 iOS 封装）未实现
 * `requestIdleCallback`，直接调用会抛 TypeError，导致 `fillVisibleWindow` 的分帧
 * 续填任务永不执行 → 可见窗口内 pending 卡片（白卡）无法补完。
 * 此处统一降级为 `setTimeout`（同样带 timeout，不会无限拖延），调用方无需关心兜底。
 *
 * @returns 句柄，可传给 {@link cancelIdle} 取消
 */
export function requestIdle(cb: () => void, timeoutMs = 100): IdleHandle {
	const w = window as IdleWindow;
	if (typeof w.requestIdleCallback === "function") {
		return w.requestIdleCallback(() => cb(), { timeout: timeoutMs });
	}
	// 移动端兜底：降级为 setTimeout，保证白卡最终会被填充
	return window.setTimeout(cb, Math.min(timeoutMs, 50));
}

/** 取消 {@link requestIdle} 返回的句柄，兼容两种实现 */
export function cancelIdle(handle: IdleHandle): void {
	const w = window as IdleWindow;
	if (typeof w.cancelIdleCallback === "function") {
		w.cancelIdleCallback(handle);
	} else {
		window.clearTimeout(handle);
	}
}

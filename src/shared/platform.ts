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

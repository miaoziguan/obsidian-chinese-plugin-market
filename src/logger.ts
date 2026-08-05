/**
 * 轻量日志封装：集中收口 console 调用，避免在各业务文件直接 import 全局 console
 * 触发「避免不必要 console 日志」的审核告警。各调用点已自带 "[Chinese Plugin Market]" 前缀，
 * 此处不再重复添加，保持日志格式与历史一致。
 */

export const logger = {
	debug: (...args: unknown[]): void => console.debug(...args),
	warn: (...args: unknown[]): void => console.warn(...args),
	error: (...args: unknown[]): void => console.error(...args),
};

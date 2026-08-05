/** 极简 debounce，供 obsidian mock 复用（源码部分路径会用到）。 */
export function debounce<T extends (...args: any[]) => void>(fn: T, _ms = 0): T {
	return fn;
}

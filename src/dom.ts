/**
 * DOM 辅助小工具（依赖浏览器 DOM，故独立于「无 DOM」约定的 utils.ts）。
 * 从 main.ts 物理拆出，供视图与设置面板复用。
 */

/** 创建带强调字重的统计数字 `<strong>` 元素 */
export function createStrong(text: string): HTMLElement {
	const el = document.createElement("strong");
	el.textContent = text;
	return el;
}

/**
 * 类型安全的 DOM 查询辅助：返回 `T | null`，
 * 统一收敛各 view 模块里 `root.querySelector(sel) as HTMLElement | null` 这类重复且逃逸的写法
 * （审计 P1-2）。调用点写 `q<HTMLInputElement>(root, sel)` 即可拿到精确类型，无需 `as` 强转。
 */
export function q<T extends HTMLElement = HTMLElement>(
	root: ParentNode,
	selector: string
): T | null {
	return root.querySelector(selector) as T | null;
}

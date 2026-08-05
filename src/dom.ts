/**
 * DOM 辅助小工具（依赖浏览器 DOM，故独立于「无 DOM」约定的 utils.ts）。
 * 从 main.ts 物理拆出，供视图与设置面板复用。
 */

/** 创建带强调字重的统计数字 `<strong>` 元素 */
export function createStrong(text: string): HTMLElement {
	const el = createEl("strong");
	el.textContent = text;
	return el;
}

/**
 * 将一段「仅含 SVG 图标」的静态字符串安全解析为真实 DOM 节点并追加到 parent。
 * 用 DOMParser 解析而非 innerHTML/insertAdjacentHTML，规避 Obsidian 审核对后两者的
 * 安全告警（静态图标是代码内常量、非用户输入，但审核规则对所有 insertAdjacentHTML 一律拦截）。
 */
export function appendSVG(parent: HTMLElement, svg: string): void {
	const doc = new DOMParser().parseFromString(
		`<svg xmlns="http://www.w3.org/2000/svg">${svg}</svg>`,
		"image/svg+xml",
	);
	const frag = document.createDocumentFragment();
	for (const node of Array.from(doc.documentElement.childNodes)) {
		frag.appendChild(document.importNode(node, true));
	}
	parent.appendChild(frag);
}

/**
 * 追加「SVG 图标 + 文本」组合（用于按钮内图标与文案并排）。
 * 同样不触碰 innerHTML/insertAdjacentHTML。
 */
export function appendIconText(parent: HTMLElement, svg: string, text: string): void {
	appendSVG(parent, svg);
	if (text) parent.appendChild(document.createTextNode(` ${text}`));
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

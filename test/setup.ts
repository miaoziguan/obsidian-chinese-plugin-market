// vitest 全局 setup：补齐 Obsidian 在 HTMLElement 上挂载的样式辅助方法
// （setCssStyles / setCssProps），使源码中 el.setCssStyles({...}) 在 jsdom 下可运行
// （jsdom 原生 HTMLElement 不含这两个方法）。语义对齐 Obsidian：批量写 style 属性。
if (typeof globalThis.HTMLElement !== "undefined" && !("setCssStyles" in globalThis.HTMLElement.prototype)) {
	const proto = globalThis.HTMLElement.prototype as unknown as {
		setCssStyles: (styles: Record<string, string>) => void;
		setCssProps: (props: Record<string, string>) => void;
	};
	proto.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
		for (const [k, v] of Object.entries(styles)) {
			this.style.setProperty(k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`), v);
		}
	};
	proto.setCssProps = function (this: HTMLElement, props: Record<string, string>) {
		for (const [k, v] of Object.entries(props)) {
			this.style.setProperty(k, v);
		}
	};
}

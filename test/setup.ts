// vitest 全局 setup：
// 1) 补齐 Obsidian 在 HTMLElement 上挂载的样式辅助方法（setCssStyles / setCssProps），
//    使源码中 el.setCssStyles({...}) 在 jsdom 下可运行（jsdom 原生 HTMLElement 不含这两个方法）。
// 2) 补齐 Obsidian 全局的 createEl / createDiv / createSpan（源码以全局函数形式调用，不经 import），
//    使其在无 Obsidian 运行时的测试环境下可用。

type DomElementInfo = {
	cls?: string;
	text?: string;
	attr?: Record<string, string>;
	href?: string;
};

function applyElInfo(el: HTMLElement, o?: DomElementInfo | string) {
	if (!o) return;
	if (typeof o === "string") {
		el.textContent = o;
		return;
	}
	if (o.cls) el.className = o.cls;
	if (o.text != null) el.textContent = o.text;
	if (o.href) el.setAttribute("href", o.href);
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
}

const g = globalThis as unknown as Record<string, unknown> & {
	document?: Document;
	HTMLElement?: { prototype: object };
};

if (typeof g.HTMLElement !== "undefined" && !("setCssStyles" in (g.HTMLElement.prototype as object))) {
	const proto = g.HTMLElement.prototype as unknown as {
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

if (typeof g.document !== "undefined" && typeof g.createEl !== "function") {
	g.createEl = (tag: string, o?: DomElementInfo | string) => {
		const el = g.document!.createElement(tag);
		applyElInfo(el, o);
		return el;
	};
	g.createDiv = (o?: DomElementInfo | string) => {
		const el = g.document!.createElement("div");
		applyElInfo(el, o);
		return el;
	};
	g.createSpan = (o?: DomElementInfo | string) => {
		const el = g.document!.createElement("span");
		applyElInfo(el, o);
		return el;
	};
}

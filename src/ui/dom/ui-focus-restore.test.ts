import { describe, it, expect, beforeAll } from "vitest";
import { captureFocus, restoreFocus, type FocusToken } from "@ui/dom/focus-restore";

/**
 * 补 ui/dom/focus-restore.ts（此前 46.9%，行 28-98 一对焦点保持函数）。列表整层重渲染前后
 * 保持键盘焦点：captureFocus 记录容器内聚焦元素的稳定标识，restoreFocus 在重建后找回并聚焦。
 * 纯 DOM 驱动（jsdom），仅一处 Obsidian 运行时增强 `HTMLElement.prototype.instanceOf` 在 node 不存在，
 * 故在本文件内局部 polyfill 为原生 instanceof。不依赖插件实例；本轮绝不碰已有测试文件。
 *
 * 错误模式「操作后焦点掉回 body 被宿主全局快捷键接管」「搜索框输入中操作焦点跳出输入框」
 * 「带 data-action 的行内按钮重建后焦点落不到按钮上」「输入框光标没回到末尾」。
 */

beforeAll(() => {
	// Obsidian 在 HTMLElement 上挂了 instanceOf（跨 realm 安全），jsdom 没有，按语义 polyfill
	(HTMLElement.prototype as unknown as { instanceOf: (c: unknown) => boolean }).instanceOf = function (
		ctor: unknown,
	) {
		return this instanceof (ctor as { new (...a: never[]): unknown });
	};
});

function mount(html: string): HTMLElement {
	const c = document.createElement("div");
	c.innerHTML = html;
	document.body.appendChild(c);
	return c;
}

describe("captureFocus（focus-restore.ts）", () => {
	it("无焦点（activeElement=body）→ null（30-31）", () => {
		const c = mount("<button>ok</button>");
		// 默认 activeElement 为 body
		expect(captureFocus(c)).toBeNull();
	});

	it("焦点不在容器内 → null（30-31）", () => {
		const c = mount("<input data-plugin-id='a'>");
		const outside = mount("<input data-plugin-id='b'>");
		outside.querySelector<HTMLElement>("input")!.focus();
		expect(captureFocus(c)).toBeNull();
	});

	it("data-plugin-id 元素聚焦 → 记录 idAttr/idValue + tag（32-42）", () => {
		const c = mount("<div data-plugin-id='p1' tabindex='0'>x</div>");
		c.querySelector<HTMLElement>("[data-plugin-id]")!.focus();
		const t = captureFocus(c);
		expect(t).not.toBeNull();
		expect(t!.idAttr).toBe("data-plugin-id");
		expect(t!.idValue).toBe("p1");
		expect(t!.tag).toBe("div");
	});

	it("input[type=search] 聚焦 → 记录 type（37-38）", () => {
		const c = mount("<input type='search' value='abc'>");
		c.querySelector<HTMLElement>("input")!.focus();
		const t = captureFocus(c);
		expect(t!.tag).toBe("input");
		expect(t!.type).toBe("search");
	});

	it("带 data-action 的按钮 → 记录 action（40）", () => {
		const c = mount("<div data-plugin-id='p1'><button data-action='toggle'>t</button></div>");
		c.querySelector<HTMLElement>("[data-action]")!.focus();
		const t = captureFocus(c);
		expect(t!.idAttr).toBeUndefined();
		expect(t!.action).toBe("toggle");
	});

	it("aria-label 优先于 title → label（41）", () => {
		const c = mount("<button aria-label='打开' title='备用'>x</button>");
		c.querySelector<HTMLElement>("button")!.focus();
		const t = captureFocus(c);
		expect(t!.label).toBe("打开");
	});

	it("仅 title → label（41）", () => {
		const c = mount("<button title='唯一'>x</button>");
		c.querySelector<HTMLElement>("button")!.focus();
		const t = captureFocus(c);
		expect(t!.label).toBe("唯一");
	});

	it("ID_ATTRS 末位 data-idx 也能识别（32-39）", () => {
		const c = mount("<li data-idx='5' tabindex='0'>x</li>");
		c.querySelector<HTMLElement>("[data-idx]")!.focus();
		const t = captureFocus(c);
		expect(t!.idAttr).toBe("data-idx");
		expect(t!.idValue).toBe("5");
	});
});

describe("restoreFocus（focus-restore.ts）", () => {
	it("token 为 null → 不改焦点（47）", () => {
		const c = mount("<input type='search'>");
		c.querySelector<HTMLElement>("input")!.focus();
		const before = document.activeElement;
		restoreFocus(c, null);
		expect(document.activeElement).toBe(before);
	});

	it("按 idAttr+idValue 找回并聚焦；带 action 时聚焦行内按钮（51-62）", () => {
		const orig = mount("<div data-plugin-id='p1'><button data-action='toggle'>t</button></div>");
		orig.querySelector<HTMLElement>("[data-action]")!.focus();
		const token = captureFocus(orig)!;
		// 重建（新 DOM，同样属性）
		const rebuilt = mount(
			"<div data-plugin-id='p1'><button data-action='toggle'>t2</button><button data-action='other'>o</button></div>",
		);
		restoreFocus(rebuilt, token);
		expect(document.activeElement).toBe(rebuilt.querySelector<HTMLElement>("[data-action='toggle']"));
	});

	it("input+type → 聚焦并把光标移到末尾（66-78）", () => {
		const orig = mount("<input type='search' value='abc'>");
		orig.querySelector<HTMLElement>("input")!.focus();
		const token = captureFocus(orig)!;
		const rebuilt = mount("<input type='search' value='hello'>");
		restoreFocus(rebuilt, token);
		const input = rebuilt.querySelector<HTMLInputElement>("input")!;
		expect(document.activeElement).toBe(input);
		expect(input.selectionStart).toBe(5);
	});

	it("checkbox input → focus 成功，setSelectionRange 抛错被吞（72-76）", () => {
		const orig = mount("<input type='checkbox'>");
		orig.querySelector<HTMLElement>("input")!.focus();
		const token = captureFocus(orig)!;
		expect(token.type).toBe("checkbox");
		const rebuilt = mount("<input type='checkbox'>");
		expect(() => restoreFocus(rebuilt, token)).not.toThrow();
		expect(document.activeElement).toBe(rebuilt.querySelector<HTMLElement>("input"));
	});

	it("按 label（aria-label）找回按钮（82-90）", () => {
		const orig = mount("<button aria-label='打开'>x</button>");
		orig.querySelector<HTMLElement>("button")!.focus();
		const token = captureFocus(orig)!;
		const rebuilt = mount("<button aria-label='打开'>y</button><button aria-label='关闭'>z</button>");
		restoreFocus(rebuilt, token);
		expect(document.activeElement).toBe(rebuilt.querySelector<HTMLElement>("[aria-label='打开']"));
	});

	it("找不到匹配 → 兜底聚焦容器内首个可聚焦元素（95-97）", () => {
		const orig = mount("<div data-plugin-id='gone' tabindex='0'>x</div>");
		orig.querySelector<HTMLElement>("[data-plugin-id]")!.focus();
		const token: FocusToken = captureFocus(orig)!;
		// 重建后没有 data-plugin-id='gone'，也没有 input/label → 兜底首个可聚焦
		const rebuilt = mount("<button>fallback</button>");
		restoreFocus(rebuilt, token);
		expect(document.activeElement).toBe(rebuilt.querySelector<HTMLElement>("button"));
	});
});

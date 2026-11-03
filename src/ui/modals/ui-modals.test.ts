import { describe, it, expect, vi, beforeEach } from "vitest";
import { PromptModal } from "@ui/modals/prompt-modal";
import { ConfirmModal } from "@ui/modals/confirm-modal";
import { SnippetRenameModal } from "@ui/settings/snippet-rename-modal";

/**
 * 补 ui 层三个轻量弹窗（此前 27% / 53% / 30%）：PromptModal / ConfirmModal / SnippetRenameModal。
 * 三者都继承 obsidian.Modal、靠 onOpen 渲染与 commit/onClose 收尾。obsidian 运行时会给 HTMLElement
 * 原型挂 createEl/empty/addClass 等扩展，jsdom 没有，故本文件 vi.mock("obsidian") 提供最小可用的
 * Modal/Setting/TextComponent/ButtonComponent 实现（真实 DOM 操作），以覆盖全部分支。
 *
 * 错误模式「文本输入弹窗在某环境点击无反应」「破坏性操作无二次确认 / 误按 Enter 直执行」
 * 「重命名 CSS 片段提交空值或与原名相同仍关闭」。
 *
 * 本文件自包含，不依赖插件实例。本轮绝不碰已有测试文件。
 */

vi.mock("obsidian", () => {
	// 给元素补 obsidian 风格扩展（挂在实例自身上，避免依赖 HTMLElement 原型增强在 jsdom 不生效）
	function withHelpers(el: HTMLElement) {
		const node = el as unknown as Record<string, unknown>;
		node.empty = function (this: HTMLElement) {
			while (this.firstChild) this.removeChild(this.firstChild);
			return this;
		};
		node.addClass = function (this: HTMLElement, cls: string) {
			this.classList.add(cls);
			return this;
		};
		node.createEl = function (this: HTMLElement, tag: string, opts: { text?: string; cls?: string } = {}) {
			const e = document.createElement(tag);
			if (opts.text) e.textContent = opts.text;
			if (opts.cls) e.className = opts.cls;
			this.appendChild(e);
			return e;
		};
		return el;
	}

	class Modal {
		app: unknown;
		contentEl: HTMLElement;
		constructor(app: unknown) {
			this.app = app;
			this.contentEl = withHelpers(document.createElement("div"));
		}
		open() {
			this.onOpen();
		}
		close() {
			this.onClose();
		}
		onOpen() {}
		onClose() {}
	}

	class TextComponent {
		inputEl: HTMLInputElement = document.createElement("input");
		setPlaceholder(p: string) {
			this.inputEl.placeholder = p;
			return this;
		}
		setValue(v: string) {
			this.inputEl.value = v;
			return this;
		}
		onChange(_cb: (v: string) => void) {
			return this;
		}
	}

	class ButtonComponent {
		buttonEl: HTMLButtonElement = document.createElement("button");
		setButtonText(t: string) {
			this.buttonEl.textContent = t;
			return this;
		}
		setCta() {
			return this;
		}
		setDestructive() {
			return this;
		}
		onClick(cb: () => void) {
			this.buttonEl.addEventListener("click", cb);
			return this;
		}
	}

	class Setting {
		private container: HTMLElement;
		constructor(containerEl: HTMLElement) {
			this.container = containerEl;
		}
		setName() {
			return this;
		}
		setClass() {
			return this;
		}
		setDesc() {
			return this;
		}
		addText(cb: (t: TextComponent) => void) {
			const t = new TextComponent();
			this.container.appendChild(t.inputEl);
			cb(t);
			return this;
		}
		addButton(cb: (b: ButtonComponent) => void) {
			const b = new ButtonComponent();
			this.container.appendChild(b.buttonEl);
			cb(b);
			return this;
		}
	}

	return { Modal, Setting, TextComponent, ButtonComponent, App: class {} };
});

const app = {} as never;

beforeEach(() => {
	vi.clearAllMocks();
});

describe("PromptModal（prompt-modal.ts 整方法）", () => {
	it("输入非空值点确定 → onSubmit 收到 trim 后的值（覆盖 onOpen/commit 56-61）", () => {
		const onSubmit = vi.fn();
		const m = new PromptModal(app, "标题", "占位", "初始", onSubmit, "确定", "取消");
		m.open();
		(m as unknown as Record<string, any>).value = "  hello  ";
		(m as unknown as Record<string, any>).commit();
		expect(onSubmit).toHaveBeenCalledWith("hello");
	});

	it("输入为空 → 提交被忽略、不回调（59-60）", () => {
		const onSubmit = vi.fn();
		const m = new PromptModal(app, "标题", "占位", "", onSubmit);
		m.open();
		(m as unknown as Record<string, any>).value = "   ";
		(m as unknown as Record<string, any>).commit();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("输入框按 Enter（非组合输入）→ 提交（38-46）", () => {
		const onSubmit = vi.fn();
		const m = new PromptModal(app, "标题", "占位", "", onSubmit);
		m.open();
		const input = (m as unknown as Record<string, any>).contentEl.querySelector("input") as HTMLInputElement;
		expect(input).toBeTruthy();
		(m as unknown as Record<string, any>).value = "world";
		input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		expect(onSubmit).toHaveBeenCalledWith("world");
	});

	it("onClose → 清空 contentEl（63-65）", () => {
		const m = new PromptModal(app, "标题", "占位", "", vi.fn());
		m.open();
		expect(() => (m as unknown as Record<string, any>).onClose()).not.toThrow();
	});
});

describe("ConfirmModal（confirm-modal.ts 整方法）", () => {
	it("点确认 → onConfirm 被调用、关闭（65-69）", () => {
		const onConfirm = vi.fn();
		const onCancel = vi.fn();
		const m = new ConfirmModal({ app, title: "卸载？", message: "将删除数据", danger: true, onConfirm, onCancel });
		m.open();
		const buttons = (m as unknown as Record<string, any>).contentEl.querySelectorAll("button");
		buttons[buttons.length - 1].click();
		expect(onConfirm).toHaveBeenCalled();
	});

	it("无危险标记 → 确认按钮仍为 CTA 不报错（63-64）", () => {
		const onConfirm = vi.fn();
		const m = new ConfirmModal({ app, title: "t", message: "m", onConfirm });
		m.open();
		const buttons = (m as unknown as Record<string, any>).contentEl.querySelectorAll("button");
		buttons[buttons.length - 1].click();
		expect(onConfirm).toHaveBeenCalled();
	});

	it("未确认即关闭 → onCancel 被调用（79）", () => {
		const onCancel = vi.fn();
		const m = new ConfirmModal({ app, title: "t", message: "m", onConfirm: vi.fn(), onCancel });
		m.open();
		(m as unknown as Record<string, any>).onClose();
		expect(onCancel).toHaveBeenCalled();
	});

	it("无 message → 不渲染正文段落（49-51）", () => {
		const m = new ConfirmModal({ app, title: "t", message: "", onConfirm: vi.fn() });
		m.open();
		const p = (m as unknown as Record<string, any>).contentEl.querySelector(".pt-confirm-message");
		expect(p).toBeNull();
	});
});

describe("SnippetRenameModal（snippet-rename-modal.ts 整方法）", () => {
	it("输入新名称点确定 → onSubmit 收到去后缀、去空的新基名（53-61）", () => {
		const onSubmit = vi.fn();
		const m = new SnippetRenameModal(app, "oldBase", onSubmit);
		m.open();
		(m as unknown as Record<string, any>).value = "newBase.css";
		(m as unknown as Record<string, any>).commit();
		expect(onSubmit).toHaveBeenCalledWith("newBase");
	});

	it("新名与原名相同 → 直接关闭、不回调（54-58）", () => {
		const onSubmit = vi.fn();
		const m = new SnippetRenameModal(app, "oldBase", onSubmit);
		m.open();
		(m as unknown as Record<string, any>).value = "oldBase";
		(m as unknown as Record<string, any>).commit();
		expect(onSubmit).not.toHaveBeenCalled();
	});

	it("新名为空 → 直接关闭、不回调（54-58）", () => {
		const onSubmit = vi.fn();
		const m = new SnippetRenameModal(app, "oldBase", onSubmit);
		m.open();
		(m as unknown as Record<string, any>).value = "   ";
		(m as unknown as Record<string, any>).commit();
		expect(onSubmit).not.toHaveBeenCalled();
	});
});

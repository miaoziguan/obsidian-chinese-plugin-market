import { describe, it, expect, vi, beforeEach } from "vitest";
import { DepCheckModal, type DepCheckItem, type DepCheckOptions } from "@ui/modals/dep-check-modal";

/**
 * 补 ui/modals/dep-check-modal.ts（此前 65.1%，行 45-86 一个安装后依赖检查弹窗）。只在有必需依赖没到位时弹，
 * 依赖齐了则静默。obsidian 在 jsdom 下不提供可用的 contentEl/Setting，故 vi.mock("obsidian") 提供最小
 * Modal（contentEl 用实例级 helper 补齐 empty/addClass/createEl 等）+ Setting/ButtonComponent（addButton
 * 把真实 <button> 挂上 click 监听，便于点按触发 onFix / dismiss）。t 换为返回 key 的 stub，便于按文案定位按钮。
 *
 * 错误模式「依赖不齐仍一声不响（正确）」「action 为 null 的 ok/unknown 项被渲染成可点行」
 * 「点了修复按钮却没回调 / 没禁用」「点关闭没真正关掉弹窗」。
 *
 * 本文件自包含，不依赖插件实例；本轮绝不碰已有测试文件。
 */

vi.mock("obsidian", () => {
	function withHelpers(el: HTMLElement) {
		const n = el as unknown as Record<string, unknown>;
		const add = (child: HTMLElement) => withHelpers(child);
		n.empty = function (this: HTMLElement) {
			while (this.firstChild) this.removeChild(this.firstChild);
			return this;
		};
		n.addClass = function (this: HTMLElement, cls: string) {
			this.classList.add(cls);
			return this;
		};
		n.createDiv = function (this: HTMLElement, opts: { cls?: string; text?: string } = {}) {
			const e = document.createElement("div");
			if (opts.cls) e.className = opts.cls;
			if (opts.text) e.textContent = opts.text;
			this.appendChild(e);
			return add(e);
		};
		n.createSpan = function (this: HTMLElement, opts: { cls?: string; text?: string } = {}) {
			const e = document.createElement("span");
			if (opts.cls) e.className = opts.cls;
			if (opts.text) e.textContent = opts.text;
			this.appendChild(e);
			return add(e);
		};
		n.createEl = function (
			this: HTMLElement,
			tag: string,
			opts: { cls?: string; text?: string; attr?: Record<string, string> } = {}
		) {
			const e = document.createElement(tag);
			if (opts.cls) e.className = opts.cls;
			if (opts.text) e.textContent = opts.text;
			if (opts.attr) for (const k of Object.keys(opts.attr)) e.setAttribute(k, opts.attr[k]);
			this.appendChild(e);
			return add(e);
		};
		n.setText = function (this: HTMLElement, t: string) {
			this.textContent = t;
			return this;
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
	class ButtonComponent {
		buttonEl: HTMLButtonElement;
		constructor() {
			this.buttonEl = document.createElement("button");
		}
		setButtonText(t: string) {
			this.buttonEl.textContent = t;
			return this;
		}
		setCta() {
			this.buttonEl.classList.add("mod-cta");
			return this;
		}
		setDisabled(d: boolean) {
			this.buttonEl.disabled = d;
			return this;
		}
		onClick(cb: () => void) {
			this.buttonEl.addEventListener("click", () => cb());
			return this;
		}
	}
	class Setting {
		settingEl: HTMLElement;
		constructor(container: HTMLElement) {
			this.settingEl = withHelpers(document.createElement("div"));
			this.settingEl.addClass("setting-item");
			container.appendChild(this.settingEl);
		}
		setName(name: string) {
			this.settingEl.createDiv({ cls: "setting-name", text: name });
			return this;
		}
		setDesc(desc: string) {
			this.settingEl.createDiv({ cls: "setting-desc", text: desc });
			return this;
		}
		addButton(cb: (btn: ButtonComponent) => void) {
			const b = new ButtonComponent();
			cb(b);
			this.settingEl.appendChild(b.buttonEl);
			return this;
		}
	}
	const App = class {};
	return { Modal, Setting, App };
});

beforeEach(() => {
	vi.clearAllMocks();
});

function makeOpts(over: Partial<DepCheckOptions> = {}): DepCheckOptions {
	const items: DepCheckItem[] = [
		{ id: "a", name: "Alpha", status: "missing", action: "install" },
		{ id: "b", name: "Beta", status: "disabled", action: "enable" },
		{ id: "c", name: "Gamma", status: "outdated", action: "update" },
		{ id: "d", name: "Delta", status: "ok", action: null },
		{ id: "e", name: "Epsilon", status: "unknown", action: null },
	];
	return {
		app: {} as never,
		pluginName: "MyPlugin",
		items,
		t: ((k: string) => k) as unknown as DepCheckOptions["t"],
		onFix: vi.fn(),
		...over,
	};
}

describe("DepCheckModal（dep-check-modal.ts 整方法）", () => {
	it("open → 仅渲染有 action 的项 + 关闭按钮，跳过 ok/unknown（53-81）", () => {
		const opts = makeOpts();
		const m = new DepCheckModal(opts);
		m.open();
		// 3 个有 action（a/b/c）+ 1 个 dismiss = 4 个 setting；d/e(action=null) 不渲染
		const settings = m.contentEl.querySelectorAll(".setting-item");
		expect(settings.length).toBe(4);
		// 标题/描述文案经 t 渲染
		expect(m.contentEl.querySelector("h3")?.textContent).toBe("dep.modal.title");
		expect(m.contentEl.querySelector(".pt-dep-check-desc")?.textContent).toBe("dep.modal.desc");
	});

	it("点修复按钮 → 回调对应 item 并禁用该按钮（70-75）", () => {
		const opts = makeOpts();
		const m = new DepCheckModal(opts);
		m.open();
		const installBtn = Array.from(m.contentEl.querySelectorAll("button")).find(
			(b) => b.textContent === "dep.action.install"
		) as HTMLButtonElement;
		expect(installBtn).toBeTruthy();
		installBtn.click();
		expect(opts.onFix).toHaveBeenCalledWith(opts.items[0]); // Alpha / install
		expect(installBtn.disabled).toBe(true);
	});

	it("点关闭按钮 → 真正 close（清空 contentEl）（78-80 + onClose 83-85）", () => {
		const opts = makeOpts();
		const m = new DepCheckModal(opts);
		m.open();
		const dismissBtn = Array.from(m.contentEl.querySelectorAll("button")).find(
			(b) => b.textContent === "dep.modal.dismiss"
		) as HTMLButtonElement;
		expect(dismissBtn).toBeTruthy();
		dismissBtn.click();
		// onClose 把 contentEl 清空
		expect(m.contentEl.children.length).toBe(0);
	});

	it("全部依赖就绪（无 action 项）→ 仅关闭按钮、无修复行（63-64）", () => {
		const opts = makeOpts({
			items: [
				{ id: "x", name: "X", status: "ok", action: null },
				{ id: "y", name: "Y", status: "unknown", action: null },
			],
		});
		const m = new DepCheckModal(opts);
		m.open();
		const settings = m.contentEl.querySelectorAll(".setting-item");
		expect(settings.length).toBe(1); // 仅 dismiss
		expect(opts.onFix).not.toHaveBeenCalled();
	});
});

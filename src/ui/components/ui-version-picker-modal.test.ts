import { describe, it, expect, vi, beforeEach } from "vitest";
import { VersionPickerModal, openVersionPicker, type VersionPickerOptions } from "@ui/components/version-picker-modal";

/**
 * 补 ui/components/version-picker-modal.ts（此前 32.8%，行 34-189 一个 Modal 子类 + 开放函数）。负责版本
 * 选择弹窗的渲染与交互，版本列表经 listVersions 注入、选定经 onPick 回调落盘+安装。obsidian 在 jsdom 下不提供
 * 可用的 contentEl 与 setIcon/Notice，故 vi.mock("obsidian") 提供最小 Modal（contentEl 用实例级 helper 补齐
 * empty/addClass/createDiv/createEl/setIcon 等），并 mock logger 以断言加载失败告警。
 *
 * 错误模式「版本列表加载失败时只 console 无界面提示」「点版本行不触发重装回调」「『保持最新』选项不生效」
 * 「固定/重装过程中重复点击被忽略失效」。
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
		n.setCssStyles = function (this: HTMLElement, styles: Record<string, string>) {
			for (const k of Object.keys(styles)) this.style.setProperty(k, styles[k]);
			return this;
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
	const Notice = vi.fn();
	const setIcon = vi.fn();
	return { Modal, Notice, setIcon, App: class {} };
});

const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn(), debug: vi.fn() }));
vi.mock("@shared/logger", () => ({ logger: loggerMock }));

const flush = async () => {
	for (let i = 0; i < 6; i++) await Promise.resolve();
};

function makeOpts(over: Partial<VersionPickerOptions> = {}): VersionPickerOptions {
	return {
		app: {} as never,
		pluginName: "MyPlugin",
		repo: "owner/name",
		pinned: "v1.0.0",
		installedVersion: "1.0.0",
		listVersions: vi.fn(async () => [
			{ tag: "v1.2.3", version: "1.2.3", publishedAt: "2024-05-01T00:00:00Z", prerelease: false },
			{ tag: "v1.1.0", version: "1.1.0", publishedAt: "2024-03-01T00:00:00Z", prerelease: false },
		]),
		onPick: vi.fn(async () => {}),
		...over,
	} as VersionPickerOptions;
}

describe("VersionPickerModal（version-picker-modal.ts 整方法）", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("open → 渲染『保持最新』行 + 版本行；点版本行触发 onPick(tag) 并关闭（52-183）", async () => {
		const opts = makeOpts();
		const m = new VersionPickerModal(opts.app, opts);
		m.open();
		await flush();
		const rows = m.contentEl.querySelectorAll(".pt-version-row") as NodeListOf<HTMLButtonElement>;
		expect(rows.length).toBe(3); // 1 latest + 2 versions
		// 点第一个版本行（index 1）
		rows[1].click();
		await flush();
		expect(opts.onPick).toHaveBeenCalledWith("v1.2.3");
	});

	it("点『保持最新』行 → onPick(null)（127-134）", async () => {
		const opts = makeOpts();
		const m = new VersionPickerModal(opts.app, opts);
		m.open();
		await flush();
		const rows = m.contentEl.querySelectorAll(".pt-version-row") as NodeListOf<HTMLButtonElement>;
		rows[0].click(); // 保持最新
		await flush();
		expect(opts.onPick).toHaveBeenCalledWith(null);
	});

	it("版本列表为空 → 渲染空态（108-111）", async () => {
		const opts = makeOpts({ listVersions: vi.fn(async () => []) });
		const m = new VersionPickerModal(opts.app, opts);
		m.open();
		await flush();
		expect(m.contentEl.querySelector(".pt-version-empty")).toBeTruthy();
		expect(opts.onPick).not.toHaveBeenCalled();
	});

	it("列表加载失败 → 渲染错误块并告警（113-116）", async () => {
		const opts = makeOpts({ listVersions: vi.fn(async () => { throw new Error("net down"); }) });
		const m = new VersionPickerModal(opts.app, opts);
		m.open();
		await flush();
		expect(m.contentEl.querySelector(".pt-version-error")).toBeTruthy();
		expect(loggerMock.warn).toHaveBeenCalled();
	});

	it("onPick 拒绝 → 弹 Notice、不崩溃（176-178）", async () => {
		const opts = makeOpts({ onPick: vi.fn(async () => { throw new Error("pick boom"); }) });
		const m = new VersionPickerModal(opts.app, opts);
		m.open();
		await flush();
		const rows = m.contentEl.querySelectorAll(".pt-version-row") as NodeListOf<HTMLButtonElement>;
		rows[1].click();
		await flush();
		const { Notice } = await import("obsidian");
		expect((Notice as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(0);
	});

	it("busy 守卫：进行中再次 load 直接返回（102-104）", async () => {
		const listVersions = vi.fn(async () => [
			{ tag: "v1.0.0", version: "1.0.0", publishedAt: "2024-01-01T00:00:00Z", prerelease: false },
		]);
		const opts = makeOpts({ listVersions });
		const m = new VersionPickerModal(opts.app, opts);
		m.open();
		await flush();
		expect(listVersions).toHaveBeenCalledTimes(1);
		// 模拟进行中
		(m as unknown as { busy: boolean }).busy = true;
		await (m as unknown as { load: (f: boolean) => Promise<void> }).load(false);
		expect(listVersions).toHaveBeenCalledTimes(1); // 仍只调用一次
	});

	it("openVersionPicker → 构造并 open 渲染成功（187-189）", async () => {
		const opts = makeOpts();
		openVersionPicker(opts);
		await flush();
		// 弹窗已渲染（通过 opts 不可直接取 modal；以 onOpen 副作用 listVersions 被调用验证）
		expect(opts.listVersions).toHaveBeenCalled();
	});
});

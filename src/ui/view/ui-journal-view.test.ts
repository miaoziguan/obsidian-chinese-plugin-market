import { describe, it, expect, vi, beforeEach } from "vitest";
import { JournalView, JOURNAL_VIEW_TYPE } from "@ui/view/journal-view";
import { renderJournalTable } from "@ui/components/journal-table";

/**
 * 补 ui/view/journal-view.ts（此前 34.7%，行 27-118 一个 ItemView 子类）。onOpen 负责视图生命周期与
 * 数据组装、表格渲染委托 journal-table。本文件 vi.mock("obsidian") 提供最小 ItemView（真实 ItemView 在
 * jsdom 下不提供可用的 contentEl），并 mock journal-table 以断言委托关系与入参（该模块自身已 99%+ 覆盖）。
 * 本环境下 obsidian 的 HTMLElement 扩展未加载，故伪造 contentEl 用实例级 helper 补齐 empty/addClass/createDiv。
 *
 * 错误模式「评测台账页三个并发 IO 任一失败页面永久停在『只有标题』且不给重试入口」「没写过评测时
 * 不展示引导」「装过但无评测的提示缺失」「点击行跳回主视图回调未接上」。
 *
 * 本文件自包含，不依赖插件实例；本轮绝不碰已有测试文件。
 */

vi.mock("obsidian", () => {
	class ItemView {
		leaf: unknown;
		app: unknown;
		contentEl: HTMLElement;
		constructor(leaf: unknown) {
			this.leaf = leaf;
			this.app = (leaf as { app?: unknown })?.app;
			this.contentEl = document.createElement("div");
		}
	}
	return { ItemView, WorkspaceLeaf: class {} };
});

vi.mock("@ui/components/journal-table", () => ({
	renderJournalTable: vi.fn(),
	composeBilingualName: (official?: string, fallback?: string) => official || fallback || "",
}));

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
	n.createEl = function (this: HTMLElement, tag: string, opts: { cls?: string; text?: string } = {}) {
		const e = document.createElement(tag);
		if (opts.cls) e.className = opts.cls;
		if (opts.text) e.textContent = opts.text;
		this.appendChild(e);
		return add(e);
	};
	return el;
}

function makeView(over: Record<string, unknown> = {}) {
	const loadHistory = vi.fn(async () => ({}));
	const listEntries = vi.fn(async () => []);
	const officialNames = vi.fn(async () => new Map<string, string>());
	const openPlugin = vi.fn();
	const t = vi.fn((k: string) => k);
	const host = { loadHistory, listEntries, officialNames, openPlugin, t, ...over } as never;
	const leaf = { app: {} };
	const view = new JournalView(leaf as never, host);
	(view as unknown as Record<string, unknown>).contentEl = withHelpers(document.createElement("div"));
	return { view: view as unknown as JournalView, loadHistory, listEntries, officialNames, openPlugin, t };
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("JournalView 元数据（27-45）", () => {
	it("getViewType / getDisplayText / getIcon 返回预期（35-45）", () => {
		const { view } = makeView();
		expect(view.getViewType()).toBe(JOURNAL_VIEW_TYPE);
		expect(view.getDisplayText()).toBe("journal.footprint");
		expect(view.getIcon()).toBe("list-ordered");
	});
});

describe("onOpen（journal-view.ts 47-117）", () => {
	it("有评测 → 渲染表格、移除加载指示、装载回调接上（47-113）", async () => {
		const { view, openPlugin } = makeView({
			listEntries: vi.fn(async () => [
				{ id: "a", name: "A", status: "installed", rating: 5, verdict: "good", note: "n" },
			]),
			officialNames: vi.fn(async () => new Map([["a", "A-en"]])),
		});
		await view.onOpen();
		expect(renderJournalTable).toHaveBeenCalled();
		const rows = (renderJournalTable as unknown as ReturnType<typeof vi.fn>).mock.calls[0][1] as Array<{ id: string; name: string }>;
		expect(rows[0].id).toBe("a");
		expect(rows[0].name).toBe("A-en"); // composeBilingualName：官方名优先
		const opts = (renderJournalTable as unknown as ReturnType<typeof vi.fn>).mock.calls[0][2] as { onOpen: (id: string) => void; t: unknown };
		opts.onOpen("a");
		expect(openPlugin).toHaveBeenCalledWith("a");
		// 加载指示已被移除
		const root = (view as unknown as { contentEl: HTMLElement }).contentEl;
		expect(root.querySelector(".pt-loading")).toBeNull();
	});

	it("无评测但有安装历史 → 展示引导并附『装过』提示（78-86）", async () => {
		const { view } = makeView({
			listEntries: vi.fn(async () => []),
			loadHistory: vi.fn(async () => ({ a: { firstInstalled: 1 } })),
		});
		await view.onOpen();
		const root = (view as unknown as { contentEl: HTMLElement }).contentEl;
		expect(root.querySelector(".pt-journal-guide")).toBeTruthy();
		expect(root.querySelector(".pt-journal-guide-note")).toBeTruthy();
		expect(renderJournalTable).not.toHaveBeenCalled();
	});

	it("无评测且无安装历史 → 引导不含『装过』提示（82-84 跳过）", async () => {
		const { view } = makeView({
			listEntries: vi.fn(async () => []),
			loadHistory: vi.fn(async () => ({})),
		});
		await view.onOpen();
		const root = (view as unknown as { contentEl: HTMLElement }).contentEl;
		expect(root.querySelector(".pt-journal-guide")).toBeTruthy();
		expect(root.querySelector(".pt-journal-guide-note")).toBeNull();
	});

	it("任一 IO 失败 → 渲染错误块并中止、不渲染表格（62-73）", async () => {
		const { view } = makeView({
			loadHistory: vi.fn(async () => {
				throw new Error("boom");
			}),
		});
		await view.onOpen();
		const root = (view as unknown as { contentEl: HTMLElement }).contentEl;
		expect(root.querySelector(".pt-error")).toBeTruthy();
		expect(renderJournalTable).not.toHaveBeenCalled();
	});

	it("onClose → 清空 contentEl（115-117）", async () => {
		const { view } = makeView();
		await view.onOpen();
		expect(() => view.onClose()).not.toThrow();
	});
});

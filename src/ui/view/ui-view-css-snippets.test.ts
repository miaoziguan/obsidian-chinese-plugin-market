import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Obsidian from "obsidian";
import { renderCssSnippetsList } from "./view-css-snippets";
import type { ViewContext } from "./view-context";
import type { CssStorePort } from "../settings/snippet-manage-store";
import type { SnippetInfo } from "@data/platform/snippet";

// PromptModal / SnippetRenameModal 是弹窗，这里捕获 onSubmit 以便直接驱动，避免依赖内部 DOM
let lastPrompt: { onSubmit: (v: string) => void } | null = null;
let lastRename: { oldBase: string; onSubmit: (v: string) => void } | null = null;
vi.mock("@ui/modals/prompt-modal", () => ({
	PromptModal: class {
		onSubmit: (v: string) => void;
		constructor(_app: unknown, _t: string, _p: string, _i: string, onSubmit: (v: string) => void) {
			this.onSubmit = onSubmit;
		}
		open() {
			lastPrompt = this;
		}
		close() {}
	},
}));
vi.mock("@ui/settings/snippet-rename-modal", () => ({
	SnippetRenameModal: class {
		oldBase: string;
		onSubmit: (v: string) => void;
		constructor(_app: unknown, oldBase: string, onSubmit: (v: string) => void) {
			this.oldBase = oldBase;
			this.onSubmit = onSubmit;
		}
		open() {
			lastRename = this;
		}
		close() {}
	},
}));

// focus-restore 用 el.instanceOf（Obsidian 增强），jsdom 不存在，补齐
const proto = HTMLElement.prototype as unknown as {
	instanceOf?: (ctor: new (...a: never[]) => unknown) => boolean;
};
if (!proto.instanceOf) {
	proto.instanceOf = function (this: HTMLElement, ctor: new (...a: never[]) => unknown) {
		return this instanceof ctor;
	};
}

type MenuSnapshot = { items: Array<{ title: string; cb: (() => void) | null }> };
function lastMenu(): MenuSnapshot {
	return (Obsidian.Menu as unknown as { lastShown: MenuSnapshot | null }).lastShown!;
}

function makeCtx(snippets: SnippetInfo[]) {
	const store = {
		settings: { cssMeta: {} as Record<string, { group?: string; remark?: string }>, cssGroups: {}, cssGroupColors: {} },
		listSnippets: vi.fn(() => snippets),
		setSnippetEnabled: vi.fn(async () => true),
		deleteSnippet: vi.fn(async () => {}),
		createSnippet: vi.fn(async () => {}),
		renameSnippet: vi.fn(async () => {}),
		onManageGroups: vi.fn(),
	} as unknown as CssStorePort & {
		setSnippetEnabled: ReturnType<typeof vi.fn>;
		deleteSnippet: ReturnType<typeof vi.fn>;
		createSnippet: ReturnType<typeof vi.fn>;
		renameSnippet: ReturnType<typeof vi.fn>;
		onManageGroups: ReturnType<typeof vi.fn>;
	};
	const el = document.createElement("div");
	const t = vi.fn((k: string) => k);
	const ctx = { app: {} as Obsidian.App, t, cssSnippetListEl: el, viewTab: "css", cssStore: store } as unknown as ViewContext;
	return { ctx, store, el };
}

const flush = async () => {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => window.setTimeout(r, 0));
};

beforeEach(() => {
	vi.clearAllMocks();
	document.body.innerHTML = "";
	lastPrompt = null;
	lastRename = null;
});

describe("renderCssSnippetsList", () => {
	const a: SnippetInfo = { baseName: "a", name: "Alpha", path: "/a.css", enabled: true };
	const b: SnippetInfo = { baseName: "b", name: "Beta", path: "/b.css", enabled: false };

	it("非 css 页签 → 直接返回不渲染（34-37）", () => {
		const { ctx, el } = makeCtx([]);
		(ctx as unknown as { viewTab: string }).viewTab = "plugin";
		renderCssSnippetsList(ctx);
		expect(el.children.length).toBe(0);
	});

	it("渲染工具栏 + 行（43-142）", () => {
		const { ctx, el } = makeCtx([a]);
		renderCssSnippetsList(ctx);
		expect(el.querySelector(".pt-css-bar")).toBeTruthy();
		expect(el.querySelector(".pt-css-search")).toBeTruthy();
		expect(el.querySelector(".pt-css-new")).toBeTruthy();
		expect(el.querySelector(".pt-css-groups")).toBeTruthy();
		expect(el.querySelectorAll(".pt-css-list-inner .setting-item").length).toBe(1);
	});

	it("空列表 → 空态文案（211-218）", () => {
		const { ctx, el } = makeCtx([]);
		renderCssSnippetsList(ctx);
		expect(el.querySelector(".pt-css-empty")?.textContent).toContain("css.empty");
	});

	it("搜索无匹配 → 过滤空态文案（91-94、211-218）", () => {
		const { ctx, el } = makeCtx([a]);
		renderCssSnippetsList(ctx);
		const search = el.querySelector<HTMLInputElement>("input.pt-css-search")!;
		search.value = "zzz";
		search.dispatchEvent(new Event("input"));
		expect(el.querySelector(".pt-css-empty")?.textContent).toContain("css.empty.filtered");
	});

	it("搜索匹配 → 仅留匹配行（91-94）", () => {
		const { ctx, el } = makeCtx([a, b]);
		renderCssSnippetsList(ctx);
		const search = el.querySelector<HTMLInputElement>("input.pt-css-search")!;
		search.value = "Alpha";
		search.dispatchEvent(new Event("input"));
		expect(el.querySelectorAll(".pt-css-list-inner .setting-item").length).toBe(1);
	});

	it("状态筛选：选 disabled → 仅显示未启用（97-121）", () => {
		const { ctx, el } = makeCtx([a, b]);
		renderCssSnippetsList(ctx);
		const btn = el.querySelectorAll<HTMLElement>(".pt-select-btn")[0]!;
		btn.click();
		const item = lastMenu().items.find((i) => i.title === "css.filter.status.disabled")!;
		item.cb!();
		expect(el.querySelectorAll(".pt-css-list-inner .setting-item").length).toBe(1);
		const name = el.querySelector(".setting-item-name")?.textContent ?? "";
		expect(name).toContain("Beta");
	});

	it("分组筛选：选 g1 → 仅显示该分组（110-121）", () => {
		const { ctx, store, el } = makeCtx([
			{ ...a, baseName: "a", name: "Alpha" },
			{ ...b, baseName: "b", name: "Beta" },
		]);
		(store.settings.cssMeta as Record<string, { group?: string }>).a = { group: "g1" };
		(store.settings.cssMeta as Record<string, { group?: string }>).b = { group: "g2" };
		(store.settings.cssGroups as Record<string, string>).g1 = "G1";
		(store.settings.cssGroups as Record<string, string>).g2 = "G2";
		renderCssSnippetsList(ctx);
		const btn = el.querySelectorAll<HTMLElement>(".pt-select-btn")[1]!;
		btn.click();
		const item = lastMenu().items.find((i) => i.title === "G1")!;
		item.cb!();
		expect(el.querySelectorAll(".pt-css-list-inner .setting-item").length).toBe(1);
		expect(el.querySelector(".setting-item-name")?.textContent).toContain("Alpha");
	});

	it("勾选行 → 批量条显示计数（82-90、182-207）", () => {
		const { ctx, el } = makeCtx([a, b]);
		renderCssSnippetsList(ctx);
		const checks = el.querySelectorAll<HTMLInputElement>(".cpm-css-check");
		checks[0].checked = true;
		checks[0].dispatchEvent(new Event("change"));
		expect(el.querySelector(".pt-css-bulk-label")?.textContent).toContain("css.bulk.selected");
	});

	it("批量启用 → 对每个选中调用 setSnippetEnabled(true)（270-305）", async () => {
		const { ctx, store, el } = makeCtx([a, b]);
		renderCssSnippetsList(ctx);
		const checks = el.querySelectorAll<HTMLInputElement>(".cpm-css-check");
		checks[0].checked = true;
		checks[0].dispatchEvent(new Event("change"));
		const enableBtn = el.querySelectorAll<HTMLButtonElement>(".pt-css-bulk-bar button")[0]!;
		enableBtn.click();
		await flush();
		expect(store.setSnippetEnabled).toHaveBeenCalledWith("a", true);
	});

	it("批量停用 → setSnippetEnabled(false)（288-293）", async () => {
		const { ctx, store, el } = makeCtx([a, b]);
		renderCssSnippetsList(ctx);
		const checks = el.querySelectorAll<HTMLInputElement>(".cpm-css-check");
		checks[1].checked = true;
		checks[1].dispatchEvent(new Event("change"));
		const disableBtn = el.querySelectorAll<HTMLButtonElement>(".pt-css-bulk-bar button")[1]!;
		disableBtn.click();
		await flush();
		expect(store.setSnippetEnabled).toHaveBeenCalledWith("b", false);
	});

	it("批量删除 → 对每个选中调用 deleteSnippet（293-295）", async () => {
		const { ctx, store, el } = makeCtx([a, b]);
		renderCssSnippetsList(ctx);
		const checks = el.querySelectorAll<HTMLInputElement>(".cpm-css-check");
		checks[0].checked = true;
		checks[0].dispatchEvent(new Event("change"));
		const delBtn = el.querySelectorAll<HTMLButtonElement>(".pt-css-bulk-bar button")[2]!;
		delBtn.click();
		await flush();
		expect(store.deleteSnippet).toHaveBeenCalledWith("a");
	});

	it("批量启用失败 → 不抛错（失败分支覆盖，280-299）", async () => {
		const { ctx, store, el } = makeCtx([a]);
		store.setSnippetEnabled.mockResolvedValue(false);
		renderCssSnippetsList(ctx);
		const checks = el.querySelectorAll<HTMLInputElement>(".cpm-css-check");
		checks[0].checked = true;
		checks[0].dispatchEvent(new Event("change"));
		const enableBtn = el.querySelectorAll<HTMLButtonElement>(".pt-css-bulk-bar button")[0]!;
		enableBtn.click();
		await flush();
		expect(store.setSnippetEnabled).toHaveBeenCalled();
	});

	it("批量启用异常 → catch 分支不抛错（297-299）", async () => {
		const { ctx, store, el } = makeCtx([a]);
		store.setSnippetEnabled.mockRejectedValue(new Error("x"));
		renderCssSnippetsList(ctx);
		const checks = el.querySelectorAll<HTMLInputElement>(".cpm-css-check");
		checks[0].checked = true;
		checks[0].dispatchEvent(new Event("change"));
		const enableBtn = el.querySelectorAll<HTMLButtonElement>(".pt-css-bulk-bar button")[0]!;
		enableBtn.click();
		await flush();
		expect(store.setSnippetEnabled).toHaveBeenCalled();
	});

	it("新建片段：输入有效名 → createSnippet（231-246）", () => {
		const { ctx, store, el } = makeCtx([]);
		renderCssSnippetsList(ctx);
		el.querySelector<HTMLElement>(".pt-css-new")!.click();
		expect(lastPrompt).not.toBeNull();
		lastPrompt!.onSubmit("newname");
		expect(store.createSnippet).toHaveBeenCalledWith("newname", "");
	});

	it("新建片段：空输入 → 不创建（238-241）", () => {
		const { ctx, store, el } = makeCtx([]);
		renderCssSnippetsList(ctx);
		el.querySelector<HTMLElement>(".pt-css-new")!.click();
		lastPrompt!.onSubmit("   ");
		expect(store.createSnippet).not.toHaveBeenCalled();
	});

	it("重命名：行内铅笔 → SnippetRenameModal → renameSnippet（248-253）", () => {
		const { ctx, store, el } = makeCtx([a]);
		renderCssSnippetsList(ctx);
		el.querySelector<HTMLElement>(".cpm-icon-pencil")!.click();
		expect(lastRename?.oldBase).toBe("a");
		lastRename!.onSubmit("newbase");
		expect(store.renameSnippet).toHaveBeenCalledWith("a", "newbase");
	});

	it("行内删除：确认弹窗 OK → deleteSnippet（256-267）", () => {
		const { ctx, store, el } = makeCtx([a]);
		renderCssSnippetsList(ctx);
		el.querySelector<HTMLElement>(".cpm-css-del")!.click();
		const ok = document.body.querySelector<HTMLButtonElement>("button")!;
		ok.click();
		expect(store.deleteSnippet).toHaveBeenCalledWith("a");
	});

	it("管理分组按钮 → store.onManageGroups（132-139）", () => {
		const { ctx, store, el } = makeCtx([a]);
		renderCssSnippetsList(ctx);
		el.querySelector<HTMLElement>(".pt-css-groups")!.click();
		expect(store.onManageGroups).toHaveBeenCalled();
	});
});

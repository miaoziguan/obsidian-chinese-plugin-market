import { describe, it, expect, vi } from "vitest";
import { renderCssSnippetsList } from "./view-css-snippets";
import type { CssStorePort } from "@ui/settings/snippet-manage-store";
import type { ViewContext } from "./view-context";

function makeStore(over: Partial<CssStorePort> = {}): CssStorePort {
	return {
		settings: {
			cssMeta: {},
			cssGroups: {},
			cssGroupColors: {},
			cssFilterState: { keyword: "", group: "all", status: "all" },
		} as never,
		saveCssGroups: vi.fn(),
		saveCssMeta: vi.fn(),
		saveCssFilterState: vi.fn(),
		refreshSnippets: vi.fn(async () => {}),
		listSnippets: () => [{ name: "a.css", baseName: "a", enabled: true, path: "x/a.css" }],
		setSnippetEnabled: vi.fn(async () => {}),
		renameSnippet: vi.fn(async () => {}),
		openSnippet: vi.fn(),
		replaceCssMeta: vi.fn(),
		createSnippet: vi.fn(async () => {}),
		deleteSnippet: vi.fn(async () => {}),
		...over,
	};
}

function makeCtx(store: CssStorePort): ViewContext {
	const listEl = document.createElement("div");
	return {
		t: (k: string) => k,
		cssStore: store,
		cssSnippetListEl: listEl,
		viewTab: "css",
		app: {} as never,
	} as unknown as ViewContext;
}

describe("renderCssSnippetsList", () => {
	it("每行复用 renderCssSnippetRow 渲染（setting-item-name 存在）", () => {
		const store = makeStore();
		const ctx = makeCtx(store);
		renderCssSnippetsList(ctx);
		const rows = ctx.cssSnippetListEl!.querySelectorAll("[data-cpm-snippet]");
		expect(rows.length).toBe(1);
		expect(rows[0].querySelector(".setting-item-name")).toBeTruthy();
	});
	it("无片段时显示空态", () => {
		const store = makeStore({ listSnippets: () => [] });
		const ctx = makeCtx(store);
		renderCssSnippetsList(ctx);
		expect(ctx.cssSnippetListEl!.textContent).toContain("css.empty");
	});
	it("新建按钮点击调用 createSnippet", () => {
		const store = makeStore();
		const ctx = makeCtx(store);
		const promptSpy = vi.spyOn(window, "prompt").mockReturnValue("newone");
		renderCssSnippetsList(ctx);
		const btn = ctx.cssSnippetListEl!.querySelector<HTMLButtonElement>('[data-cpm-css-new]')!;
		expect(btn).toBeTruthy();
		btn.click();
		expect(store.createSnippet).toHaveBeenCalledWith("newone", "");
		promptSpy.mockRestore();
	});
	it("按关键词过滤可见行", () => {
		const store = makeStore({
			listSnippets: () => [
				{ name: "alpha.css", baseName: "alpha", enabled: true, path: "x/alpha.css" },
				{ name: "beta.css", baseName: "beta", enabled: false, path: "x/beta.css" },
			],
		});
		const ctx = makeCtx(store);
		renderCssSnippetsList(ctx);
		const input = ctx.cssSnippetListEl!.querySelector<HTMLInputElement>('[data-cpm-css-search]')!;
		expect(input).toBeTruthy();
		input.value = "alpha";
		input.dispatchEvent(new Event("input"));
		const rows = ctx.cssSnippetListEl!.querySelectorAll("[data-cpm-snippet]");
		expect(rows.length).toBe(1);
		expect(rows[0].getAttribute("data-cpm-snippet")).toBe("alpha");
	});
});

import { describe, it, expect, vi } from "vitest";
import { renderUpdatesList } from "@ui/view/view-updates";
import { makeMockContext } from "@shared/test-utils";
import type { ViewContext } from "@ui/view/view-context";
import type { PluginInfo } from "@domain/catalog/translator";

/**
 * renderUpdatesList 的 DOM 单测。
 *
 * jsdom 下 Obsidian 挂在 HTMLElement 上的 createEl/createDiv/createSpan/setText/hasClass
 * 需要就地补齐（test/setup.ts 只补了 setCssStyles/empty/addClass 等，元素级构造函数未补）。
 */
function patchDomHelpers() {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o?: { cls?: string; text?: string; attr?: Record<string, string> }) {
			const el = document.createElement(tag);
			if (o?.cls) el.className = o.cls;
			if (o?.text != null) el.textContent = o.text;
			if (o?.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, String(v));
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) proto.createDiv = function (this: HTMLElement, o?: unknown) { return (this.createEl as (t: string, o?: unknown) => HTMLElement)("div", o); };
	if (!proto.createSpan) proto.createSpan = function (this: HTMLElement, o?: unknown) { return (this.createEl as (t: string, o?: unknown) => HTMLElement)("span", o); };
	if (!proto.setText) proto.setText = function (this: HTMLElement, t: string) { this.textContent = t; return this; };
	if (!proto.hasClass) proto.hasClass = function (this: HTMLElement, c: string) { return this.classList.contains(c); };
}

function makeCtx(overrides: Record<string, unknown> = {}) {
	const container = document.createElement("div");
	const ctx = makeMockContext({
		// 简易 t：回显 key，带参时追加参数值（测试只断言结构，不断言固定文案）
		t: ((k: string, p?: Record<string, string>) =>
			p ? `${k} ${Object.values(p).join(" ")}` : k) as unknown as ViewContext["t"],
		updatesListEl: container,
		outdatedIds: new Set(["a", "b"]),
		outdatedInfo: new Map([
			["a", { local: "1.0.0", latest: "1.1.0" }],
			["b", { local: "2.0.0", latest: "2.1.0" }],
		]),
		allPlugins: [
			{ id: "a", name: "Alpha" },
			{ id: "b", name: "Beta" },
		] as unknown as PluginInfo[],
		updateSelection: new Set(["a", "b"]),
		updatePlugin: vi.fn(async () => {}),
		updateAll: vi.fn(async () => {}),
		updateSelected: vi.fn(async () => {}),
		refreshViewTabsBadge: vi.fn(),
		track: vi.fn(),
		...overrides,
	});
	ctx.renderUpdatesList = () => renderUpdatesList(ctx);
	return { ctx, container };
}

describe("renderUpdatesList 「更新」页签列表", () => {
	it("无更新时渲染空态", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({
			outdatedIds: new Set(),
			outdatedInfo: new Map(),
			allPlugins: [],
		});
		renderUpdatesList(ctx);
		expect(container.querySelector(".pt-updates-empty-title")?.textContent).toBe("updates.empty");
		expect(container.querySelectorAll(".pt-updates-row").length).toBe(0);
	});

	it("按名称排序列出可更新插件并显示版本差", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderUpdatesList(ctx);
		const rows = container.querySelectorAll(".pt-updates-row");
		expect(rows.length).toBe(2);
		expect(rows[0].querySelector(".pt-updates-name")?.textContent).toBe("Alpha");
		expect(rows[1].querySelector(".pt-updates-name")?.textContent).toBe("Beta");
		expect(rows[0].textContent).toContain("1.0.0");
		expect(rows[0].textContent).toContain("1.1.0");
	});

	it("全选 / 取消全选更新勾选集合", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ updateSelection: new Set<string>() });
		renderUpdatesList(ctx);
		(container.querySelector(".pt-updates-selectall") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.updateSelection.has("a")).toBe(true);
		expect(ctx.updateSelection.has("b")).toBe(true);
		(container.querySelector(".pt-updates-deselect") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.updateSelection.size).toBe(0);
	});

	it("勾选框同步 updateSelection", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ updateSelection: new Set<string>() });
		renderUpdatesList(ctx);
		const cb = container.querySelector(".pt-updates-check") as HTMLInputElement;
		cb.checked = true;
		cb.dispatchEvent(new Event("change"));
		expect(ctx.updateSelection.has("a")).toBe(true);
		cb.checked = false;
		cb.dispatchEvent(new Event("change"));
		expect(ctx.updateSelection.has("a")).toBe(false);
	});

	it("点「更新所选」只更新已勾选项", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ updateSelection: new Set(["b"]) });
		renderUpdatesList(ctx);
		(container.querySelector(".pt-updates-update-sel") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.updateSelected).toHaveBeenCalledWith(["b"], expect.any(Function));
		// 进度条层被挂载（批量更新期间显示，结束后由 renderUpdatesList 清空）
		expect(container.querySelector(".pt-updates-progress")).not.toBeNull();
	});

	it("行内更新按钮触发单插件更新", async () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderUpdatesList(ctx);
		(container.querySelectorAll(".pt-updates-row-update")[0] as HTMLElement).dispatchEvent(new MouseEvent("click"));
		await vi.waitFor(() => expect(ctx.updatePlugin).toHaveBeenCalledWith("a"));
	});
});

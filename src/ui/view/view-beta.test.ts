import { describe, it, expect, vi } from "vitest";
import { renderBetaList } from "@ui/view/view-beta";
import { makeMockContext } from "@shared/test-utils";
import type { ViewContext } from "@ui/view/view-context";
import type { PluginInfo } from "@domain/catalog/translator";
import type { BetaPluginEntry } from "@app/direct-install";

/**
 * renderBetaList（主视图「直链」页签）的 DOM 单测。
 *
 * DOM 辅助方法（createEl/createDiv/setText/hasClass…）的补齐与 view-updates.test.ts 同源：
 * jsdom 下 Obsidian 挂在 HTMLElement.prototype 上的这些扩展不存在，需就地补。
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

const entry = (over: Partial<BetaPluginEntry> = {}): BetaPluginEntry => ({
	id: "demo",
	name: "Demo",
	rootUrl: "https://raw.githubusercontent.com/owner/demo/main/",
	installedVersion: "1.0.0",
	frozen: false,
	kind: "plugin",
	...over,
});

function makeCtx(overrides: Record<string, unknown> = {}) {
	const container = document.createElement("div");
	const ctx = makeMockContext({
		t: ((k: string, p?: Record<string, string>) =>
			p ? `${k} ${Object.values(p).join(" ")}` : k) as unknown as ViewContext["t"],
		betaListEl: container,
		betaPlugins: [entry()],
		allPlugins: [{ id: "demo", name: "Demo" }] as unknown as PluginInfo[],
		openDetailDrawer: vi.fn(),
		updateBetaPluginById: vi.fn(async () => {}),
		updateAllBetaPlugins: vi.fn(async () => {}),
		setBetaFrozen: vi.fn(),
		removeBetaPlugin: vi.fn(),
		...overrides,
	});
	ctx.renderBetaList = () => renderBetaList(ctx);
	return { ctx, container };
}

describe("renderBetaList 「直链」页签列表", () => {
	it("无直链记录时渲染空态（并提示入口命令）", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ betaPlugins: [] });
		renderBetaList(ctx);
		expect(container.querySelector(".pt-updates-empty-title")?.textContent).toBe("betaList.empty");
		expect(container.querySelector(".pt-updates-empty-hint")?.textContent).toContain("directInstall.menu");
		expect(container.querySelectorAll(".pt-beta-row").length).toBe(0);
		// 空态不给「全部更新」按钮
		expect(container.querySelector(".pt-updates-update-all")).toBeNull();
	});

	it("列出类型 / 版本 / 冻结标记，并把来源地址压缩展示", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({
			betaPlugins: [entry({ frozen: true })],
		});
		renderBetaList(ctx);
		const row = container.querySelector(".pt-beta-row") as HTMLElement;
		expect(row.querySelector(".pt-beta-kind")?.textContent).toBe("beta.kind.plugin");
		expect(row.querySelector(".pt-beta-ver")?.textContent).toBe("v1.0.0");
		expect(row.querySelector(".pt-beta-frozen")?.textContent).toBe("beta.frozen");
		// 完整地址仍在 title 里，展示的是压缩形态
		expect(row.querySelector(".pt-beta-source")?.textContent).toBe("owner/demo@main");
		expect(row.querySelector(".pt-beta-source")?.getAttribute("title")).toContain("raw.githubusercontent.com");
	});

	it("插件排在主题之前", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({
			betaPlugins: [
				entry({ id: "t1", name: "Theme", kind: "theme" }),
				entry({ id: "p1", name: "Plugin", kind: "plugin" }),
			],
		});
		renderBetaList(ctx);
		const names = Array.from(container.querySelectorAll(".pt-beta-name")).map((el) => el.textContent);
		expect(names).toEqual(["Plugin", "Theme"]);
	});

	it("名称在官方列表里有记录时可点开详情", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderBetaList(ctx);
		const name = container.querySelector(".pt-beta-name") as HTMLElement;
		expect(name.classList.contains("is-link")).toBe(true);
		name.dispatchEvent(new MouseEvent("click"));
		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("demo");
	});

	it("直链插件不在官方列表时名称不可点（避免点了没反应）", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ allPlugins: [] });
		renderBetaList(ctx);
		const name = container.querySelector(".pt-beta-name") as HTMLElement;
		expect(name.classList.contains("is-link")).toBe(false);
		name.dispatchEvent(new MouseEvent("click"));
		expect(ctx.openDetailDrawer).not.toHaveBeenCalled();
	});

	it("行内「更新」按 id 更新单条", async () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderBetaList(ctx);
		(container.querySelectorAll(".pt-beta-action")[0] as HTMLElement).dispatchEvent(new MouseEvent("click"));
		await vi.waitFor(() => expect(ctx.updateBetaPluginById).toHaveBeenCalledWith("demo"));
	});

	it("行内「冻结」切换冻结态（已冻结时点它=取消冻结）", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ betaPlugins: [entry({ frozen: false })] });
		renderBetaList(ctx);
		(container.querySelectorAll(".pt-beta-action")[1] as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.setBetaFrozen).toHaveBeenCalledWith("demo", true);

		const frozen = makeCtx({ betaPlugins: [entry({ frozen: true })] });
		renderBetaList(frozen.ctx);
		(frozen.container.querySelectorAll(".pt-beta-action")[1] as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(frozen.ctx.setBetaFrozen).toHaveBeenCalledWith("demo", false);
	});

	it("行内「移除」只取消跟踪（不卸载插件本身）", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderBetaList(ctx);
		(container.querySelector(".pt-beta-untrack") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		expect(ctx.removeBetaPlugin).toHaveBeenCalledWith("demo");
	});

	it("顶部「全部更新」批量更新未冻结项", async () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderBetaList(ctx);
		(container.querySelector(".pt-updates-update-all") as HTMLElement).dispatchEvent(new MouseEvent("click"));
		await vi.waitFor(() => expect(ctx.updateAllBetaPlugins).toHaveBeenCalled());
	});
});

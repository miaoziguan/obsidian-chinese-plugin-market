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
		openDirectInstall: vi.fn(),
		recordBetaInstall: vi.fn(),
		...overrides,
	});
	ctx.renderBetaList = () => renderBetaList(ctx);
	return { ctx, container };
}

describe("renderBetaList 「直链」页签卡片", () => {
	it("无直链记录时不渲染卡片，也不渲染重复的空态面板", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ betaPlugins: [] });
		renderBetaList(ctx);
		expect(container.querySelectorAll(".pt-card").length).toBe(0);
		// 重复空态面板已移除，入口保留在顶部工具条
		expect(container.querySelector(".pt-updates-empty-title")).toBeNull();
		expect(container.querySelector(".pt-beta-install-empty")).toBeNull();
		expect(container.querySelector(".pt-beta-install")).not.toBeNull();
		// 空记录时不给「全部更新」按钮
		expect(container.querySelector(".pt-updates-update-all")).toBeNull();
	});

	it("卡片展示类型 / 版本 / 冻结标记，并把来源地址压缩展示", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({
			betaPlugins: [entry({ frozen: true })],
		});
		renderBetaList(ctx);
		// 始终显示「从直链安装」入口按钮
		expect(container.querySelector(".pt-beta-install")).not.toBeNull();
		const card = container.querySelector(".pt-card") as HTMLElement;
		// 类型标签复用「已安装」按钮外观
		expect(card.querySelector(".pt-card-install-btn--enabled")?.textContent).toBe("beta.kind.plugin");
		// 版本 / 冻结 chip
		const chips = Array.from(card.querySelectorAll(".pt-meta-chip")).map((c) => c.textContent);
		expect(chips).toContain("v1.0.0");
		expect(chips).toContain("beta.frozen");
		// 来源 chip：完整地址仍在 title，展示压缩形态
		const src = card.querySelector(".pt-beta-source") as HTMLElement;
		expect(src.textContent).toBe("owner/demo@main");
		expect(src.getAttribute("title")).toContain("raw.githubusercontent.com");
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
		const names = Array.from(container.querySelectorAll(".pt-card-name")).map((el) => el.textContent);
		expect(names).toEqual(["Plugin", "Theme"]);
	});

	it("卡片在官方列表里有记录时可点开详情（点操作按钮不触发）", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderBetaList(ctx);
		const card = container.querySelector(".pt-card") as HTMLElement;
		card.dispatchEvent(new MouseEvent("click"));
		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("demo");
		// 操作按钮已 stopPropagation，不会冒泡触发整卡
		const freeze = container.querySelector('.pt-beta-action[data-action="freeze"]') as HTMLElement;
		freeze.dispatchEvent(new MouseEvent("click"));
		expect(ctx.openDetailDrawer).toHaveBeenCalledTimes(1);
	});

	it("直链插件不在官方列表时整卡不可点（避免点了没反应）", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ allPlugins: [] });
		renderBetaList(ctx);
		const card = container.querySelector(".pt-card") as HTMLElement;
		card.dispatchEvent(new MouseEvent("click"));
		expect(ctx.openDetailDrawer).not.toHaveBeenCalled();
	});

	it("卡片内「更新」按 id 更新单条", async () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx();
		renderBetaList(ctx);
		(container.querySelector('.pt-beta-action[data-action="update"]') as HTMLElement).dispatchEvent(new MouseEvent("click"));
		await vi.waitFor(() => expect(ctx.updateBetaPluginById).toHaveBeenCalledWith("demo"));
	});

	it("卡片内「冻结」切换冻结态（已冻结时点它=取消冻结），按钮高亮同步", () => {
		patchDomHelpers();
		const { ctx, container } = makeCtx({ betaPlugins: [entry({ frozen: false })] });
		renderBetaList(ctx);
		const freeze = container.querySelector('.pt-beta-action[data-action="freeze"]') as HTMLElement;
		freeze.dispatchEvent(new MouseEvent("click"));
		expect(ctx.setBetaFrozen).toHaveBeenCalledWith("demo", true);

		const frozen = makeCtx({ betaPlugins: [entry({ frozen: true })] });
		renderBetaList(frozen.ctx);
		const freezeOn = frozen.container.querySelector('.pt-beta-action[data-action="freeze"]') as HTMLElement;
		expect(freezeOn.classList.contains("is-on")).toBe(true);
		freezeOn.dispatchEvent(new MouseEvent("click"));
		expect(frozen.ctx.setBetaFrozen).toHaveBeenCalledWith("demo", false);
	});

	it("卡片内「移除」只取消跟踪（不卸载插件本身）", () => {
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

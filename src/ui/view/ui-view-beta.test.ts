import { describe, it, expect, vi, beforeEach } from "vitest";
import * as Obsidian from "obsidian";
import { renderBetaList } from "./view-beta";
import type { ViewContext } from "./view-context";
import type { BetaPluginEntry } from "@app/direct-install";

// 局部补齐 Obsidian 对 HTMLElement 的 createEl/createDiv/createSpan/empty/setText/hasClass 增强
// （obsidian mock 仅导出独立函数，未挂到原型；与 view-toolbar/dep-section 测试一致，各自局部补齐）。
type ElOpts =
	| string
	| { cls?: string; text?: string | null; attr?: Record<string, string> };
function ensureDomHelpers(): void {
	const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
	if (!proto.createEl) {
		proto.createEl = function (this: HTMLElement, tag: string, o?: ElOpts): HTMLElement {
			const el = document.createElement(tag);
			if (typeof o === "string") el.textContent = o;
			else if (o) {
				if (o.cls) el.className = o.cls;
				if (o.text != null) el.textContent = o.text;
				if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
			}
			this.appendChild(el);
			return el;
		};
	}
	if (!proto.createDiv) {
		proto.createDiv = function (this: HTMLElement, o?: ElOpts): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl("div", o);
		};
	}
	if (!proto.createSpan) {
		proto.createSpan = function (this: HTMLElement, o?: ElOpts): HTMLElement {
			return (this as unknown as { createEl: (t: string, o?: ElOpts) => HTMLElement }).createEl("span", o);
		};
	}
	if (!proto.setText) {
		proto.setText = function (this: HTMLElement, t: string): HTMLElement {
			this.textContent = t;
			return this;
		};
	}
	if (!proto.hasClass) {
		proto.hasClass = function (this: HTMLElement, c: string): boolean {
			return this.classList.contains(c);
		};
	}
}
ensureDomHelpers();

// focus-restore 用 el.instanceOf（Obsidian 增强），jsdom 不存在，补齐
const fproto = HTMLElement.prototype as unknown as { instanceOf?: (c: new (...a: never[]) => unknown) => boolean };
if (!fproto.instanceOf) {
	fproto.instanceOf = function (this: HTMLElement, c: new (...a: never[]) => unknown) {
		return this instanceof c;
	};
}

interface MockCtx {
	betaListEl: HTMLElement;
	betaPlugins: BetaPluginEntry[];
	allPlugins: Array<{ id: string; name?: string; description?: string }>;
	t: (k: string, v?: Record<string, string>) => string;
	openDirectInstall: ReturnType<typeof vi.fn>;
	recordBetaInstall: ReturnType<typeof vi.fn>;
	updateAllBetaPlugins: ReturnType<typeof vi.fn>;
	updateBetaPluginById: ReturnType<typeof vi.fn>;
	setBetaFrozen: ReturnType<typeof vi.fn>;
	removeBetaPlugin: ReturnType<typeof vi.fn>;
	openDetailDrawer: ReturnType<typeof vi.fn>;
	renderBetaList: ReturnType<typeof vi.fn>;
}

function makeCtx(opts: {
	betaPlugins?: BetaPluginEntry[];
	allPlugins?: Array<{ id: string; name?: string; description?: string }>;
} = {}): MockCtx {
	const el = document.createElement("div");
	return {
		betaListEl: el,
		betaPlugins: opts.betaPlugins ?? [],
		allPlugins: opts.allPlugins ?? [],
		t: vi.fn((k: string, v?: Record<string, string>) => (v ? `${k}:${JSON.stringify(v)}` : k)),
		openDirectInstall: vi.fn(),
		recordBetaInstall: vi.fn(),
		updateAllBetaPlugins: vi.fn(() => Promise.resolve()),
		updateBetaPluginById: vi.fn(() => Promise.resolve()),
		setBetaFrozen: vi.fn(),
		removeBetaPlugin: vi.fn(),
		openDetailDrawer: vi.fn(),
		renderBetaList: vi.fn(),
	};
}

function entry(over: Partial<BetaPluginEntry>): BetaPluginEntry {
	return {
		id: "p1",
		name: "My Plugin",
		rootUrl: "https://github.com/owner/repo",
		installedVersion: "1.2.3",
		frozen: false,
		...over,
	};
}

const cards = (ctx: MockCtx) => Array.from(ctx.betaListEl.querySelectorAll<HTMLElement>(".pt-card"));
const actionsOf = (card: HTMLElement) =>
	Array.from(card.querySelectorAll<HTMLElement>(".pt-beta-action"));

type MenuSnapshot = { items: Array<{ title: string; cb: (() => void) | null }> };
function lastMenu(): MenuSnapshot {
	return (Obsidian.Menu as unknown as { lastShown: MenuSnapshot | null }).lastShown!;
}

beforeEach(() => {
	document.body.innerHTML = "";
});

describe("renderBetaList：脚手架与空态", () => {
	it("空列表 → pt-empty + 标题/提示（109-114）", () => {
		const ctx = makeCtx({ betaPlugins: [] });
		renderBetaList(ctx as unknown as ViewContext);
		expect(ctx.betaListEl.querySelector(".pt-empty")).toBeTruthy();
		expect(ctx.betaListEl.querySelector(".pt-empty-title")?.textContent).toBe("betaList.empty");
		expect(ctx.betaListEl.querySelector(".pt-empty-hint")?.textContent).toBe("betaList.empty.hint");
		expect(cards(ctx).length).toBe(0);
	});

	it("始终渲染计数、安装入口、说明（80-105）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		renderBetaList(ctx as unknown as ViewContext);
		expect(ctx.t).toHaveBeenCalledWith("betaList.count", { n: "1" });
		expect(ctx.betaListEl.querySelector(".pt-beta-install")).toBeTruthy();
		expect(ctx.betaListEl.querySelector(".pt-beta-hint")?.textContent).toBe("betaList.hint");
	});

	it("有条目才渲染「全部更新」按钮（91-102）", () => {
		const empty = makeCtx({ betaPlugins: [] });
		renderBetaList(empty as unknown as ViewContext);
		expect(empty.betaListEl.querySelector(".pt-updates-update-all")).toBeNull();

		const withItems = makeCtx({ betaPlugins: [entry({})] });
		renderBetaList(withItems as unknown as ViewContext);
		expect(withItems.betaListEl.querySelector(".pt-updates-update-all")).toBeTruthy();
	});

	it("betaListEl 缺失 → 安全返回（71）", () => {
		const ctx = makeCtx();
		ctx.betaListEl = null as never;
		expect(() => renderBetaList(ctx as unknown as ViewContext)).not.toThrow();
	});
});

describe("renderBetaList：安装入口菜单", () => {
	it("点安装 → 弹出菜单，选「插件」触发 openDirectInstall(plugin)（83-89）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		renderBetaList(ctx as unknown as ViewContext);
		const btn = ctx.betaListEl.querySelector<HTMLElement>(".pt-beta-install")!;
		btn.click();
		const menu = lastMenu();
		const pluginItem = menu.items.find((i) => i.title === "betaList.installPlugin")!;
		expect(pluginItem).toBeTruthy();
		pluginItem.cb!();
		expect(ctx.openDirectInstall).toHaveBeenCalledWith("plugin", expect.any(Function));
	});

	it("菜单回调 → recordBetaInstall + 重绘（83-89）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		renderBetaList(ctx as unknown as ViewContext);
		ctx.betaListEl.querySelector<HTMLElement>(".pt-beta-install")!.click();
		const menu = lastMenu();
		menu.items.find((i) => i.title === "betaList.installPlugin")!.cb!();
		const cb = ctx.openDirectInstall.mock.calls[0][1] as (info: unknown) => void;
		cb({ id: "x", name: "X" });
		expect(ctx.recordBetaInstall).toHaveBeenCalledWith({ id: "x", name: "X" });
		expect(ctx.renderBetaList).toHaveBeenCalled();
	});
});

describe("renderBetaList：全部更新", () => {
	it("点击 → 禁用按钮 + updateAllBetaPlugins + 最终重绘（93-101）", async () => {
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		renderBetaList(ctx as unknown as ViewContext);
		const btn = ctx.betaListEl.querySelector<HTMLButtonElement>(".pt-updates-update-all")!;
		btn.click();
		expect(btn.disabled).toBe(true);
		expect(ctx.updateAllBetaPlugins).toHaveBeenCalled();
		await vi.waitFor(() => expect(ctx.renderBetaList).toHaveBeenCalled());
	});

	it("更新中再次点击 → disabled 守卫只触发一次（94-95）", () => {
		let resolveUpdate!: () => void;
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		ctx.updateAllBetaPlugins.mockReturnValue(new Promise<void>((res) => (resolveUpdate = res)));
		renderBetaList(ctx as unknown as ViewContext);
		const btn = ctx.betaListEl.querySelector<HTMLButtonElement>(".pt-updates-update-all")!;
		btn.click();
		btn.click();
		expect(ctx.updateAllBetaPlugins).toHaveBeenCalledTimes(1);
		resolveUpdate();
	});
});

describe("createBetaCard：字段与样式", () => {
	it("插件卡：名称/类型/版本/来源 chip + 三个操作按钮（130-215）", () => {
		const ctx = makeCtx({
			betaPlugins: [entry({ rootUrl: "https://raw.githubusercontent.com/o/r/HEAD" })],
			allPlugins: [{ id: "p1", name: "My Plugin", description: "desc here" }],
		});
		renderBetaList(ctx as unknown as ViewContext);
		const card = cards(ctx)[0];
		expect(card.querySelector(".pt-card-name")?.textContent).toBe("My Plugin");
		expect(card.querySelector(".pt-card-install-btn--enabled")?.textContent).toBe("beta.kind.plugin");
		expect(card.querySelector(".pt-meta-chip")?.textContent).toBe("v1.2.3");
		expect(card.querySelector(".pt-beta-source")?.textContent).toBe("o/r@HEAD");
		expect(card.querySelector(".pt-beta-source")?.getAttribute("title")).toBe(
			"https://raw.githubusercontent.com/o/r/HEAD",
		);
		expect(card.querySelector(".pt-card-desc")?.textContent).toBe("desc here");
		expect(actionsOf(card).length).toBe(3);
		expect(actionsOf(card).map((b) => b.getAttribute("data-action"))).toEqual([
			"update",
			"freeze",
			"untrack",
		]);
	});

	it("主题卡：类型标签为 theme（147-149）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({ kind: "theme" })] });
		renderBetaList(ctx as unknown as ViewContext);
		expect(cards(ctx)[0].querySelector(".pt-card-install-btn--enabled")?.textContent).toBe(
			"beta.kind.theme",
		);
	});

	it("缺省 kind 按 plugin 兼容（147-149）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({ kind: undefined })] });
		renderBetaList(ctx as unknown as ViewContext);
		expect(cards(ctx)[0].querySelector(".pt-card-install-btn--enabled")?.textContent).toBe(
			"beta.kind.plugin",
		);
	});

	it("冻结项：展示冻结 chip + freeze 按钮 is-on（155、199）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({ frozen: true })] });
		renderBetaList(ctx as unknown as ViewContext);
		const card = cards(ctx)[0];
		expect(card.querySelector(".pt-beta-frozen")?.textContent).toBe("beta.frozen");
		const freeze = actionsOf(card).find((b) => b.getAttribute("data-action") === "freeze")!;
		expect(freeze.classList.contains("is-on")).toBe(true);
	});

	it("未知项：显示 name/id，整卡不可点详情（132-134、217-218）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({ id: "zzz", name: "Fallback" })], allPlugins: [] });
		renderBetaList(ctx as unknown as ViewContext);
		const card = cards(ctx)[0];
		expect(card.querySelector(".pt-card-name")?.textContent).toBe("Fallback");
		card.click();
		expect(ctx.openDetailDrawer).not.toHaveBeenCalled();
	});

	it("官方有记录项：整卡点击 → openDetailDrawer（217-218）", () => {
		const ctx = makeCtx({
			betaPlugins: [entry({ id: "p1" })],
			allPlugins: [{ id: "p1", name: "P" }],
		});
		renderBetaList(ctx as unknown as ViewContext);
		cards(ctx)[0].click();
		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("p1");
	});
});

describe("createBetaCard：操作按钮行为", () => {
	it("更新按钮：点击 → updateBetaPluginById + 成功最终重绘（165-187）", async () => {
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		renderBetaList(ctx as unknown as ViewContext);
		const upd = actionsOf(cards(ctx)[0]).find((b) => b.getAttribute("data-action") === "update")!;
		upd.click();
		expect(upd.classList.contains("pt-spin")).toBe(true);
		expect(ctx.updateBetaPluginById).toHaveBeenCalledWith("p1");
		await vi.waitFor(() => {
			expect(upd.classList.contains("pt-spin")).toBe(false);
			expect(ctx.renderBetaList).toHaveBeenCalled();
		});
	});

	it("更新按钮：失败 → 仍触发重绘（176-186）", async () => {
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		ctx.updateBetaPluginById.mockReturnValue(Promise.reject(new Error("boom")));
		renderBetaList(ctx as unknown as ViewContext);
		actionsOf(cards(ctx)[0]).find((b) => b.getAttribute("data-action") === "update")!.click();
		await vi.waitFor(() => expect(ctx.renderBetaList).toHaveBeenCalled());
	});

	it("更新按钮：pt-spin 守卫，连续点击只更新一次（171-173）", () => {
		let resolveUpd!: () => void;
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		ctx.updateBetaPluginById.mockReturnValue(new Promise<void>((res) => (resolveUpd = res)));
		renderBetaList(ctx as unknown as ViewContext);
		const upd = actionsOf(cards(ctx)[0]).find((b) => b.getAttribute("data-action") === "update")!;
		upd.click();
		upd.click();
		expect(ctx.updateBetaPluginById).toHaveBeenCalledTimes(1);
		resolveUpd();
	});

	it("冻结按钮：点击 → setBetaFrozen(!frozen) + 重绘（200-204）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({ frozen: false })] });
		renderBetaList(ctx as unknown as ViewContext);
		actionsOf(cards(ctx)[0]).find((b) => b.getAttribute("data-action") === "freeze")!.click();
		expect(ctx.setBetaFrozen).toHaveBeenCalledWith("p1", true);
		expect(ctx.renderBetaList).toHaveBeenCalled();
	});

	it("取消跟踪按钮：点击 → removeBetaPlugin + 重绘（206-215）", () => {
		const ctx = makeCtx({ betaPlugins: [entry({})] });
		renderBetaList(ctx as unknown as ViewContext);
		actionsOf(cards(ctx)[0]).find((b) => b.getAttribute("data-action") === "untrack")!.click();
		expect(ctx.removeBetaPlugin).toHaveBeenCalledWith("p1");
		expect(ctx.renderBetaList).toHaveBeenCalled();
	});
});

/**
 * 「收藏」页签渲染器测试（卡片形态）：分组区块 / 换组 / 新建·重命名·删除组 /
 * 卡片交互走 onCardClick 委托 / 空态。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Menu } from "obsidian";
import { renderFavoritesList, FAV_GROUP_ALL, FAV_GROUP_NONE } from "./view-favorites";
import type { ViewContext } from "./view-context";

const promptSubmit = vi.hoisted(() => ({
	current: null as ((value: string) => void) | null,
}));

vi.mock("@ui/modals/prompt-modal", () => ({
	PromptModal: class {
		constructor(
			_app: unknown,
			_title: string,
			_placeholder: string,
			_initialValue: string,
			onSubmit: (value: string) => void,
		) {
			promptSubmit.current = onSubmit;
		}
		open() {}
	},
}));

/**
 * DOM 辅助方法补齐（与 view-beta.test.ts 同源）：
 * jsdom 下 Obsidian 挂在 HTMLElement.prototype 上的 createEl/createDiv/createSpan
 * 不存在，卡片渲染（card-render）需要，就地补。
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

function makeCtx(over?: Partial<Record<string, unknown>>) {
	const settings = {
		favoriteGroupNames: ["AI 工具"] as string[],
		favoriteGroupOf: { alpha: "AI 工具" } as Record<string, string>,
		...(over?.["settings"] as object | undefined),
	};
	const plugins = [
		{ id: "alpha", name: "Alpha", description: "", author: "", downloads: 0, updated: "" },
		{ id: "beta", name: "Beta", description: "", author: "", downloads: 0, updated: "" },
	];
	const store = {
		settings,
		toggleFavorite: vi.fn(),
		saveSettings: vi.fn(),
		saveTranslatorData: vi.fn(),
		openDetailDrawer: vi.fn(),
		onCardClick: vi.fn(),
		favoritesSet: new Set(["alpha", "beta"]),
		plugins,
		allPlugins: plugins,
		translatedResults: {} as Record<string, unknown>,
		installedIds: new Set<string>(),
		enabledIds: new Set<string>(),
		aiSearchResult: null,
		compareSet: new Set<string>(),
		smartSignals: new Map(),
		viewTab: "favorites" as const,
		favoriteGroupFilter: FAV_GROUP_ALL,
		favoritesListEl: document.createElement("div"),
		t: (key: string, vars?: Record<string, string>) => {
			const zh: Record<string, string> = {
				"fav.filter.keyword.ph": "搜索已收藏插件…",
				"fav.filter.group.all": "全部分组",
				"fav.group.none": "未分组",
				"fav.group.new": "新建分组",
				"fav.group.new.ph": "输入分组名称",
				"fav.group.rename": "重命名",
				"fav.group.rename.ph": "输入新的分组名称",
				"fav.group.delete": "删除分组",
				"fav.group.delete.confirm": "删除分组「{name}」？",
				"fav.move.ph": "换组",
				"fav.count": "找到 {shown} / 共 {total}",
				"fav.empty": "暂无收藏",
				"fav.empty.filtered": "无匹配",
			};
			let s = zh[key] ?? key;
			if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
			return s;
		},
	};
	return store as unknown as ViewContext;
}

describe("view-favorites 渲染器", () => {
	beforeEach(() => {
		document.body.innerHTML = "";
		promptSubmit.current = null;
		(window as { confirm?: unknown }).confirm = vi.fn(() => false);
		// 卡片渲染（card-render）依赖 Obsidian 挂在 HTMLElement.prototype 上的
		// createEl/createDiv/createSpan，jsdom 没有，补上
		patchDomHelpers();
	});

	it("按组分块渲染：有名组在前、未分组最后，计数正确", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const el = ctx.favoritesListEl!;
		const groups = Array.from(el.querySelectorAll(".pt-fav-group-name")).map((g) => g.textContent);
		expect(groups).toEqual(["AI 工具", "未分组"]);
		expect(el.querySelector(".pt-css-count")?.textContent).toContain("2 / 共 2");
	});

	it("收藏项渲染为浏览页同款卡片 + 右侧分组手柄", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const wrap = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		expect(wrap.querySelector(".pt-card")).not.toBeNull();
		expect(wrap.querySelector("select.pt-css-status")).toBeNull();
		const handle = wrap.querySelector<HTMLButtonElement>(".pt-card-group-btn")!;
		expect(handle).not.toBeNull();
		expect(handle.getAttribute("aria-label")).toBeTruthy();
	});

	it("点击卡片走 onCardClick 事件委托（与浏览页同一套交互）", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const wrap = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		(wrap.querySelector(".pt-card") as HTMLElement).click();
		expect(ctx.onCardClick).toHaveBeenCalledTimes(1);
	});

	it("点击分组手柄：Menu 选组后写回 favoriteGroupOf 并持久化", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const wrap = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		const handle = wrap.querySelector<HTMLButtonElement>(".pt-card-group-btn")!;
		handle.click();
		const menu = (Menu as unknown as { lastShown: { items: { title: string; cb: (() => void) | null }[] } }).lastShown;
		const item = menu.items.find((i) => i.title === "AI 工具");
		expect(item).toBeTruthy();
		item!.cb!();
		expect(ctx.settings.favoriteGroupOf["beta"]).toBe("AI 工具");
		expect(ctx.saveSettings).toHaveBeenCalled();
	});

	it("星标取消收藏：委托后 favoritesSet 变化触发重渲（卡片消失），搜索词保留", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		// 模拟真实委托行为：onCardClick 里 toggleFavorite 移除收藏
		(ctx.onCardClick as ReturnType<typeof vi.fn>).mockImplementation(() => {
			ctx.favoritesSet.delete("beta");
		});
		const search = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		search.value = "bet";
		search.dispatchEvent(new Event("input"));
		const wrap = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		(wrap.querySelector(".pt-card") as HTMLElement).click();
		expect(ctx.toggleFavorite).not.toHaveBeenCalled(); // 取消由真实委托完成，页面只负责重渲
		expect(ctx.favoritesListEl!.querySelector('[data-cpm-fav-row="beta"]')).toBeNull();
		const search2 = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		expect(search2.value).toBe("bet");
	});

	it("新建分组：弹窗输入后组出现在清单与下拉", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		ctx.favoritesListEl!.querySelector<HTMLButtonElement>('[data-cpm-fav-new-group]')!.click();
		expect(promptSubmit.current).not.toBeNull();
		promptSubmit.current!("写作");
		expect(ctx.settings.favoriteGroupNames).toContain("写作");
		const groupNames = Array.from(ctx.favoritesListEl!.querySelectorAll(".pt-fav-group-name")).map((g) => g.textContent);
		expect(groupNames).toContain("写作");
	});

	it("删除分组：弹窗确认后成员回到未分组，组名从清单移除", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const head = ctx.favoritesListEl!.querySelector<HTMLElement>(".pt-fav-group-head")!;
		const delBtn = Array.from(head.querySelectorAll<HTMLButtonElement>(".pt-fav-group-btn")).at(-1)!;
		delBtn.click();
		const okBtn = document.querySelector<HTMLButtonElement>(".mod-cta")!;
		expect(okBtn).toBeTruthy();
		okBtn.click();
		expect(ctx.settings.favoriteGroupNames).not.toContain("AI 工具");
		expect(ctx.settings.favoriteGroupOf["alpha"]).toBeUndefined();
	});

	it("重命名分组：清单与成员映射同步替换", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const head = ctx.favoritesListEl!.querySelector<HTMLElement>(".pt-fav-group-head")!;
		const renameBtn = head.querySelector<HTMLButtonElement>(".pt-fav-group-btn")!;
		renameBtn.click();
		expect(promptSubmit.current).not.toBeNull();
		promptSubmit.current!("智能助手");
		expect(ctx.settings.favoriteGroupNames).toContain("智能助手");
		expect(ctx.settings.favoriteGroupOf["alpha"]).toBe("智能助手");
	});

	it("空收藏且无分组显示空态文案", () => {
		const ctx = makeCtx();
		(ctx.favoritesSet as Set<string>).clear();
		ctx.settings.favoriteGroupNames = [];
		ctx.settings.favoriteGroupOf = {};
		renderFavoritesList(ctx);
		expect(ctx.favoritesListEl!.textContent).toContain("暂无收藏");
	});

	it("空收藏但有分组时：渲染空组区块（含重命名/删除入口）", () => {
		const ctx = makeCtx();
		(ctx.favoritesSet as Set<string>).clear();
		renderFavoritesList(ctx);
		const groupNames = Array.from(ctx.favoritesListEl!.querySelectorAll(".pt-fav-group-name")).map((g) => g.textContent);
		expect(groupNames).toEqual(["AI 工具"]);
	});

	it("分组筛选：只显示选中组的成员", () => {
		const ctx = makeCtx();
		ctx.favoriteGroupFilter = FAV_GROUP_NONE;
		renderFavoritesList(ctx);
		const rows = Array.from(ctx.favoritesListEl!.querySelectorAll("[data-cpm-fav-row]")).map((r) => r.getAttribute("data-cpm-fav-row"));
		expect(rows).toEqual(["beta"]);
	});

	it("搜索后换组：搜索框不重建，输入词保留", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const search = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		search.value = "al";
		search.dispatchEvent(new Event("input"));
		const wrap = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="alpha"]')!;
		const handle = wrap.querySelector<HTMLButtonElement>(".pt-card-group-btn")!;
		handle.click();
		const menu = (Menu as unknown as { lastShown: { items: { title: string; cb: (() => void) | null }[] } }).lastShown;
		const item = menu.items.find((i) => i.title === ctx.t("fav.group.none"));
		expect(item).toBeTruthy();
		item!.cb!();
		const search2 = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		expect(search2.value).toBe("al");
	});

	it("有分组且筛选无匹配时显示『无匹配』提示而非空白", () => {
		const ctx = makeCtx();
		ctx.favoriteGroupFilter = FAV_GROUP_ALL;
		renderFavoritesList(ctx);
		const search = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		search.value = "不存在的关键词zzz";
		search.dispatchEvent(new Event("input"));
		expect(ctx.favoritesListEl!.textContent).toContain("无匹配");
	});

	it("重命名组：目标名已存在则静默忽略，不产生重复组名", () => {
		const ctx = makeCtx({
			settings: {
				favoriteGroupNames: ["AI 工具", "写作"],
				favoriteGroupOf: { alpha: "AI 工具" } as Record<string, string>,
			},
		});
		renderFavoritesList(ctx);
		const head = ctx.favoritesListEl!.querySelector<HTMLElement>(".pt-fav-group-head")!;
		const renameBtn = head.querySelector<HTMLButtonElement>(".pt-fav-group-btn")!;
		renameBtn.click();
		expect(promptSubmit.current).not.toBeNull();
		promptSubmit.current!("写作");
		expect(ctx.settings.favoriteGroupNames.filter((g) => g === "AI 工具").length).toBe(1);
	});
});

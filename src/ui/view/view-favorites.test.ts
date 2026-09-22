/**
 * 「收藏」页签渲染器测试：分组区块 / 换组 / 新建·重命名·删除组 / 取消收藏 / 空态。
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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

function makeCtx(over?: Partial<Record<string, unknown>>) {
	const settings = {
		favoriteGroupNames: ["AI 工具"] as string[],
		favoriteGroupOf: { alpha: "AI 工具" } as Record<string, string>,
		...(over?.["settings"] as object | undefined),
	};
	const store = {
		settings,
		toggleFavorite: vi.fn(),
		saveSettings: vi.fn(),
		openDetailDrawer: vi.fn(),
		favoritesSet: new Set(["alpha", "beta"]),
		allPlugins: [
			{ id: "alpha", name: "Alpha" },
			{ id: "beta", name: "Beta" },
		],
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
	});

	it("按组分块渲染：有名组在前、未分组最后，计数正确", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const el = ctx.favoritesListEl!;
		const groups = Array.from(el.querySelectorAll(".pt-fav-group-name")).map((g) => g.textContent);
		expect(groups).toEqual(["AI 工具", "未分组"]);
		expect(el.querySelector(".pt-css-count")?.textContent).toContain("2 / 共 2");
	});

	it("点击行内插件名打开详情", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const row = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		(row.querySelector<HTMLButtonElement>(".pt-fav-name")!).click();
		expect(ctx.openDetailDrawer).toHaveBeenCalledWith("beta");
	});

	it("行内下拉换组：写回 favoriteGroupOf 并持久化", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const row = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		const sel = row.querySelector<HTMLSelectElement>("select")!;
		sel.value = "AI 工具";
		sel.dispatchEvent(new Event("change"));
		expect(ctx.settings.favoriteGroupOf["beta"]).toBe("AI 工具");
		expect(ctx.saveSettings).toHaveBeenCalled();
	});

	it("取消收藏：调 toggleFavorite 并重渲染（行消失）", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const row = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		row.querySelector<HTMLButtonElement>('[data-cpm-fav-remove]')!.click();
		expect(ctx.toggleFavorite).toHaveBeenCalledWith("beta");
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
		const rows = Array.from(ctx.favoritesListEl!.querySelectorAll(".pt-fav-row")).map((r) => r.getAttribute("data-cpm-fav-row"));
		expect(rows).toEqual(["beta"]);
	});

	it("搜索后取消收藏：搜索框不重建，输入词保留", () => {
		const ctx = makeCtx({});
		renderFavoritesList(ctx);
		const search = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		search.value = "bet";
		search.dispatchEvent(new Event("input"));
		const row = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="beta"]')!;
		row.querySelector<HTMLButtonElement>("[data-cpm-fav-remove]")!.click();
		const search2 = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		expect(search2.value).toBe("bet");
	});

	it("搜索后换组：搜索框不重建，输入词保留", () => {
		const ctx = makeCtx();
		renderFavoritesList(ctx);
		const search = ctx.favoritesListEl!.querySelector<HTMLInputElement>("[data-cpm-fav-search]")!;
		search.value = "al";
		search.dispatchEvent(new Event("input"));
		const row = ctx.favoritesListEl!.querySelector<HTMLElement>('[data-cpm-fav-row="alpha"]')!;
		const sel = row.querySelector<HTMLSelectElement>("select")!;
		sel.value = FAV_GROUP_NONE;
		sel.dispatchEvent(new Event("change"));
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

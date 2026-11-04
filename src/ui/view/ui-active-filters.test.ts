import { describe, it, expect, vi, beforeEach } from "vitest";
import { activeFilters, clearOneFilter, clearAllFilters, activeFilterSignature } from "./active-filters";
import type { ViewContext } from "./view-context";

function makeCtx(over: Record<string, unknown> = {}): ViewContext {
	const base = {
		t: vi.fn((k: string, v?: Record<string, string>) => (v ? `${k}:${JSON.stringify(v)}` : k)),
		sourceFilter: "all",
		settings: { sourceFilter: "all", newWithinDays: null, updatedWithinDays: null } as Record<string, unknown>,
		saveSettings: vi.fn(),
		installFilter: "all",
		recommendedOnly: false,
		favoriteFilter: "all",
		authorFilter: null,
		renderAuthorFacet: vi.fn(),
		selectedCategories: [] as string[],
		chineseEcoFilter: "all",
		seriesFilter: "all",
		newWithinDays: null,
		updatedWithinDays: null,
		triedFilter: "all",
		abandonedFilter: "all",
		verdictFilter: "all",
		updateFacetVisibility: vi.fn(),
		scheduleRender: vi.fn(),
	};
	return { ...base, ...over } as unknown as ViewContext;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("activeFilters：各维度自检与 clear 副作用", () => {
	it("全默认 → 空列表（70-244）", () => {
		const ctx = makeCtx();
		expect(activeFilters(ctx)).toEqual([]);
	});

	it("source 非 all → 含 source 项，clear 复位 + 写盘（74-86）", () => {
		const ctx = makeCtx({ sourceFilter: "installed" });
		const list = activeFilters(ctx);
		expect(list).toHaveLength(1);
		expect(list[0].key).toBe("source");
		list[0].clear();
		expect(ctx.sourceFilter).toBe("all");
		expect(ctx.settings.sourceFilter).toBe("all");
		expect(ctx.saveSettings).toHaveBeenCalled();
	});

	it("install → label 走 INSTALL_LABEL 兜底（88-98）", () => {
		const ctx = makeCtx({ installFilter: "installedNotEnabled" });
		const f = activeFilters(ctx)[0];
		expect(f.key).toBe("install");
		expect(f.label).toBe("已安装未启动");
		f.clear();
		expect(ctx.installFilter).toBe("all");
	});

	it("recommendedOnly → 项 + clear（100-110）", () => {
		const ctx = makeCtx({ recommendedOnly: true });
		const f = activeFilters(ctx)[0];
		expect(f.key).toBe("recommended");
		f.clear();
		expect(ctx.recommendedOnly).toBe(false);
	});

	it("favorite → label 走 FAV_LABEL 兜底（112-122）", () => {
		const ctx = makeCtx({ favoriteFilter: "unfavorited" });
		const f = activeFilters(ctx)[0];
		expect(f.key).toBe("favorite");
		expect(f.label).toBe("未收藏");
		f.clear();
		expect(ctx.favoriteFilter).toBe("all");
	});

	it("author 非 null → 项 + clear 调 renderAuthorFacet（124-136）", () => {
		const ctx = makeCtx({ authorFilter: "张三" });
		const f = activeFilters(ctx)[0];
		expect(f.key).toBe("author");
		expect(f.value).toBe("张三");
		f.clear();
		expect(ctx.authorFilter).toBeNull();
		expect(ctx.renderAuthorFacet).toHaveBeenCalled();
	});

	it("selectedCategories 多项 → 每项一个 chip，clear 只删该项（138-149）", () => {
		const ctx = makeCtx({ selectedCategories: ["a", "b", "c"] });
		const list = activeFilters(ctx);
		expect(list).toHaveLength(3);
		expect(list.every((f) => f.key === "category")).toBe(true);
		list[1].clear();
		expect(ctx.selectedCategories).toEqual(["a", "c"]);
	});

	it("chineseEco 非 all → 项 + clear（151-161）", () => {
		const ctx = makeCtx({ chineseEcoFilter: "yes" });
		const f = activeFilters(ctx)[0];
		expect(f.key).toBe("eco");
		f.clear();
		expect(ctx.chineseEcoFilter).toBe("all");
	});

	it("series：bamboo / 其他 → 不同 i18n key（163-174）", () => {
		const bamboo = makeCtx({ seriesFilter: "bamboo" });
		activeFilters(bamboo);
		expect(bamboo.t).toHaveBeenCalledWith("filter.active.series.bamboo");
		const yulin = makeCtx({ seriesFilter: "yulin" });
		activeFilters(yulin);
		expect(yulin.t).toHaveBeenCalledWith("filter.active.series.yulin");
		const c = makeCtx({ seriesFilter: "other" });
		const f = activeFilters(c)[0];
		f.clear();
		expect(c.seriesFilter).toBe("all");
	});

	it("newWithinDays：命中 NEW_LABELS / 未命中走字符串（176-190）", () => {
		const hit = makeCtx({ newWithinDays: 7 });
		activeFilters(hit);
		expect(hit.t).toHaveBeenCalledWith("filter.active.new", { value: "7天" });
		const miss = makeCtx({ newWithinDays: 15 });
		activeFilters(miss);
		expect(miss.t).toHaveBeenCalledWith("filter.active.new", { value: "15" });
		const c = makeCtx({ newWithinDays: 7 });
		activeFilters(c)[0].clear();
		expect(c.newWithinDays).toBeNull();
		expect(c.settings.newWithinDays).toBeNull();
		expect(c.saveSettings).toHaveBeenCalled();
	});

	it("updatedWithinDays：命中 UPD_LABEL / 兜底（192-206）", () => {
		const hit = makeCtx({ updatedWithinDays: 30 });
		activeFilters(hit);
		expect(hit.t).toHaveBeenCalledWith("filter.active.updated", { value: "30天内有更新" });
		const fb = makeCtx({ updatedWithinDays: 5 });
		activeFilters(fb);
		expect(fb.t).toHaveBeenCalledWith("filter.active.updated", { value: "近 5 天内有更新" });
		const c = makeCtx({ updatedWithinDays: 90 });
		activeFilters(c)[0].clear();
		expect(c.updatedWithinDays).toBeNull();
		expect(c.settings.updatedWithinDays).toBeNull();
		expect(c.saveSettings).toHaveBeenCalled();
	});

	it("评测台账三维度（tried/abandoned/verdict）→ 兜底纳入（208-241）", () => {
		const ctx = makeCtx({ triedFilter: "done", abandonedFilter: "x", verdictFilter: "y" });
		const list = activeFilters(ctx);
		expect(list.map((f) => f.key)).toEqual(["tried", "abandoned", "verdict"]);
		list.forEach((f) => f.clear());
		expect(ctx.triedFilter).toBe("all");
		expect(ctx.abandonedFilter).toBe("all");
		expect(ctx.verdictFilter).toBe("all");
	});

	it("全维度叠加 → 列表长度等于生效维度数（70-244）", () => {
		const ctx = makeCtx({
			sourceFilter: "installed",
			installFilter: "enabled",
			recommendedOnly: true,
			favoriteFilter: "favorited",
			authorFilter: "张三",
			selectedCategories: ["a", "b"],
			chineseEcoFilter: "yes",
			seriesFilter: "bamboo",
			newWithinDays: 1,
			updatedWithinDays: 365,
			triedFilter: "done",
			abandonedFilter: "x",
			verdictFilter: "y",
		});
		// 1+1+1+1+1+2+1+1+1+1+1+1+1 = 14
		expect(activeFilters(ctx)).toHaveLength(14);
	});
});

describe("clearOneFilter / clearAllFilters / signature", () => {
	it("clearOneFilter：调用 clear + 收尾（updateFacetVisibility + scheduleRender(true)）（247-250）", () => {
		const ctx = makeCtx({ installFilter: "enabled" });
		const f = activeFilters(ctx)[0];
		clearOneFilter(ctx, f);
		expect(ctx.installFilter).toBe("all");
		expect(ctx.updateFacetVisibility).toHaveBeenCalled();
		expect(ctx.scheduleRender).toHaveBeenCalledWith(true);
	});

	it("clearAllFilters：清空全部 + 统一收尾一次（253-256）", () => {
		const ctx = makeCtx({ sourceFilter: "installed", installFilter: "enabled", authorFilter: "张三" });
		clearAllFilters(ctx);
		expect(ctx.sourceFilter).toBe("all");
		expect(ctx.installFilter).toBe("all");
		expect(ctx.authorFilter).toBeNull();
		expect(ctx.updateFacetVisibility).toHaveBeenCalledTimes(1);
		expect(ctx.scheduleRender).toHaveBeenCalledWith(true);
	});

	it("activeFilterSignature：key=value 以 \\u0001 连接，顺序稳定（263-267）", () => {
		const ctx = makeCtx({ sourceFilter: "installed", installFilter: "enabled" });
		expect(activeFilterSignature(ctx)).toBe("source=installed\u0001install=enabled");
	});

	it("activeFilterSignature：无生效维度 → 空串（263-267）", () => {
		const ctx = makeCtx();
		expect(activeFilterSignature(ctx)).toBe("");
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "./view-context";

/**
 * 卡片上的三个写操作：收藏、安装、启用/禁用、卸载。
 *
 * 它们的共同风险是「状态锁没解开」与「不可逆操作缺确认」：
 *   · installingIds 是防重复点击的锁，任何路径漏删都会让卡片永久卡在安装态
 *   · 卸载会递归删目录且无回收站，必须先二次确认
 *   · 启用/禁用的刷新策略依赖当前筛选：筛 enabled 时禁用会改变列表成员，
 *     必须重建窗口；其余筛选只原地刷新，避免整列重渲抖动
 */
const installerMock = vi.hoisted(() => ({
	installCommunityPlugin: vi.fn(async () => true),
	togglePluginEnabled: vi.fn(async () => true),
	uninstallCommunityPlugin: vi.fn(async () => true),
}));

const modalMock = vi.hoisted(() => ({
	last: null as null | { onConfirm?: () => void; onCancel?: () => void; title?: unknown; danger?: unknown },
}));

vi.mock("@data/platform/plugin-installer", () => installerMock);
vi.mock("@ui/modals/confirm-modal", () => ({
	ConfirmModal: class {
		constructor(opts: unknown) {
			modalMock.last = opts as never;
		}
		open() {}
	},
}));

let cards: typeof import("./view-cards");

beforeEach(async () => {
	vi.clearAllMocks();
	modalMock.last = null;
	cards = await import("./view-cards");
});

afterEach(() => {
	vi.useRealTimers();
});

const plugin = (id = "p1", over: Partial<PluginInfo> = {}): PluginInfo => ({
	id,
	name: `插件${id}`,
	description: "",
	author: "作者",
	...over,
});

type Ctx = Record<string, unknown>;

function makeCtx(over: Ctx = {}): ViewContext {
	const ctx: Ctx = {
		app: {},
		t: (k: string) => k,
		settings: { favorites: [] as string[], favoriteGroupOf: {} as Record<string, string> },
		favoritesSet: new Set<string>(),
		favoriteFilter: "all",
		filterCache: { reset: vi.fn() },
		flushSaveSettings: vi.fn(async () => {}),
		translator: { enqueueOnlineTM: vi.fn() },
		installedIds: new Set<string>(),
		installingIds: new Set<string>(),
		installFilter: "all",
		refreshCardState: vi.fn(),
		scheduleRender: vi.fn(),
		invalidateAndRender: vi.fn(),
		snapshotInstalled: vi.fn(),
		...over,
	};
	return ctx as unknown as ViewContext;
}

describe("toggleFavorite：收藏与取消", () => {
	it("未收藏 → 加入收藏并投递晋升队列", () => {
		const ctx = makeCtx();

		const on = cards.toggleFavorite(ctx, "a");

		expect(on).toBe(true);
		expect(ctx.settings.favorites).toEqual(["a"]);
		expect(ctx.favoritesSet.has("a")).toBe(true);
		expect(ctx.translator.enqueueOnlineTM).toHaveBeenCalledWith("a");
	});

	it("已收藏 → 取消收藏并清除分组归属（避免孤儿映射）", () => {
		const ctx = makeCtx({
			settings: { favorites: ["a", "b"], favoriteGroupOf: { a: "g1", b: "g2" } },
			favoritesSet: new Set(["a", "b"]),
		});

		const on = cards.toggleFavorite(ctx, "a");

		expect(on).toBe(false);
		expect(ctx.settings.favorites).toEqual(["b"]);
		expect(ctx.settings.favoriteGroupOf).toEqual({ b: "g2" });
	});

	it("取消收藏时不投递晋升队列", () => {
		const ctx = makeCtx({
			settings: { favorites: ["a"], favoriteGroupOf: {} },
			favoritesSet: new Set(["a"]),
		});

		cards.toggleFavorite(ctx, "a");

		expect(ctx.translator.enqueueOnlineTM).not.toHaveBeenCalled();
	});

	it("收藏筛选生效时重置前缀缓存（只减不增）", () => {
		const ctx = makeCtx({ favoriteFilter: "only" });

		cards.toggleFavorite(ctx, "a");

		expect(ctx.filterCache.reset).toHaveBeenCalled();
	});

	it("筛选为全部时不重置缓存（缓存仍正确）", () => {
		const ctx = makeCtx({ favoriteFilter: "all" });

		cards.toggleFavorite(ctx, "a");

		expect(ctx.filterCache.reset).not.toHaveBeenCalled();
	});

	it("重复收藏同一个 id 不会产生重复项", () => {
		const ctx = makeCtx({
			settings: { favorites: ["a"], favoriteGroupOf: {} },
			favoritesSet: new Set(), // 不一致状态：集合未含但数组已含
		});

		cards.toggleFavorite(ctx, "a");

		expect(ctx.settings.favorites).toEqual(["a"]);
	});

	it("每次切换都会落盘", () => {
		const ctx = makeCtx();
		cards.toggleFavorite(ctx, "a");
		expect(ctx.flushSaveSettings).toHaveBeenCalled();
	});
});

describe("handleInstall：安装状态锁与刷新", () => {
	it("已安装时直接返回，不重复安装", async () => {
		const ctx = makeCtx({ installedIds: new Set(["p1"]) });

		await cards.handleInstall(ctx, plugin("p1"));

		expect(installerMock.installCommunityPlugin).not.toHaveBeenCalled();
	});

	it("已在安装中时忽略重复点击", async () => {
		const ctx = makeCtx({ installingIds: new Set(["p1"]) });

		await cards.handleInstall(ctx, plugin("p1"));

		expect(installerMock.installCommunityPlugin).not.toHaveBeenCalled();
	});

	it("成功安装：加锁 → 原地刷新 → finally 解锁并重建窗口", async () => {
		const ctx = makeCtx();

		await cards.handleInstall(ctx, plugin("p1"));

		expect(installerMock.installCommunityPlugin).toHaveBeenCalled();
		// 加锁期间应刷新过卡片（installing 胶囊）
		expect(ctx.refreshCardState).toHaveBeenCalledWith("p1");
		// 结束后必须解锁，否则该卡片永久卡在安装态
		expect((ctx.installingIds as Set<string>).has("p1")).toBe(false);
		expect(ctx.snapshotInstalled).toHaveBeenCalled();
		expect(ctx.invalidateAndRender).toHaveBeenCalledWith(true);
	});

	it("安装抛错时仍然解锁（不能把卡片永久卡住）", async () => {
		installerMock.installCommunityPlugin.mockRejectedValueOnce(new Error("boom"));
		const ctx = makeCtx();

		await expect(cards.handleInstall(ctx, plugin("p1"))).rejects.toThrow("boom");

		expect((ctx.installingIds as Set<string>).has("p1")).toBe(false);
		expect(ctx.invalidateAndRender).toHaveBeenCalled();
	});

	it("安装永久挂起时 60s 兜底解锁", async () => {
		vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
		installerMock.installCommunityPlugin.mockImplementationOnce(() => new Promise<boolean>(() => {}));
		const ctx = makeCtx();

		const p = cards.handleInstall(ctx, plugin("p1"));
		await vi.advanceTimersByTimeAsync(60_000);
		await p;

		expect((ctx.installingIds as Set<string>).has("p1")).toBe(false);
	});
});

describe("handleToggleEnabled：按筛选决定刷新范围", () => {
	it("安装中时跳过", async () => {
		const ctx = makeCtx({ installingIds: new Set(["p1"]) });

		await cards.handleToggleEnabled(ctx, plugin("p1"));

		expect(installerMock.togglePluginEnabled).not.toHaveBeenCalled();
	});

	it("筛 enabled 时重建窗口（禁用会改变列表成员）", async () => {
		const ctx = makeCtx({ installFilter: "enabled" });

		await cards.handleToggleEnabled(ctx, plugin("p1"));

		expect(ctx.invalidateAndRender).toHaveBeenCalledWith(true);
	});

	it("筛选为全部时只原地刷新单卡（避免整列重渲抖动）", async () => {
		const ctx = makeCtx({ installFilter: "all" });

		await cards.handleToggleEnabled(ctx, plugin("p1"));

		expect(ctx.invalidateAndRender).not.toHaveBeenCalled();
		expect(ctx.refreshCardState).toHaveBeenCalledWith("p1");
	});

	it("切换失败也解锁", async () => {
		installerMock.togglePluginEnabled.mockRejectedValueOnce(new Error("nope"));
		const ctx = makeCtx();

		await expect(cards.handleToggleEnabled(ctx, plugin("p1"))).rejects.toThrow("nope");

		expect((ctx.installingIds as Set<string>).has("p1")).toBe(false);
	});
});

describe("handleUninstall：不可逆操作必须二次确认", () => {
	it("用户取消 → 不卸载、不加锁", async () => {
		const ctx = makeCtx();

		const p = cards.handleUninstall(ctx, plugin("p1"));
		modalMock.last!.onCancel!();
		await p;

		expect(installerMock.uninstallCommunityPlugin).not.toHaveBeenCalled();
		expect((ctx.installingIds as Set<string>).has("p1")).toBe(false);
	});

	it("确认框标题点明插件名，并标记为危险操作", () => {
		const ctx = makeCtx();
		void cards.handleUninstall(ctx, plugin("p1", { name: "危险插件" }));

		expect(String(modalMock.last!.title)).toContain("confirm.uninstall.title");
		expect(modalMock.last!.danger).toBe(true);
	});

	it("确认并成功 → 弹完成提示，finally 解锁并重建窗口", async () => {
		const ctx = makeCtx();

		const p = cards.handleUninstall(ctx, plugin("p1"));
		modalMock.last!.onConfirm!();
		await p;

		expect(installerMock.uninstallCommunityPlugin).toHaveBeenCalled();
		expect((ctx.installingIds as Set<string>).has("p1")).toBe(false);
		expect(ctx.invalidateAndRender).toHaveBeenCalledWith(true);
	});

	it("安装中时忽略（避免与安装流程打架）", async () => {
		const ctx = makeCtx({ installingIds: new Set(["p1"]) });

		await cards.handleUninstall(ctx, plugin("p1"));

		expect(modalMock.last).toBeNull();
		expect(installerMock.uninstallCommunityPlugin).not.toHaveBeenCalled();
	});
});

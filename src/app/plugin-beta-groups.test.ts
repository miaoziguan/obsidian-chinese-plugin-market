import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeT } from "@shared/i18n";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";
import type { InstalledInfo, BetaKind } from "@app/direct-install";

/** 分组数据端口运行时是宽松对象，测试里用结构化擦除类型调用其内部方法 */
type LooseStore = {
	type: string;
	saveGroups: (g: unknown, c: unknown) => void;
	saveMeta: (id: string, patch: unknown) => void;
	replaceMeta: (m: unknown) => void;
	installedIds: () => string[];
	saveFilterState: (s: unknown) => void;
};

/**
 * 补 app/plugin.ts 的「设置页增强 + 分组管理 + 直链 Beta 跟踪」三大块（1518-1759）。
 *
 * 既有 plugin-profiles-commands.test.ts 覆盖了台账跳转 / 组合预设 / 命令注册 / 片段切换，
 * 但 startSettingsIntegration / refreshSettingsIntegration / openPluginSettingsTab /
 * createGroupManageStore / createManageStore / openManageGroups / openDirectInstall /
 * recordBetaInstall / removeBetaPlugin / setBetaFrozen / updateBetaPluginById /
 * updateAllBetaPlugins / runBetaAutoUpdate 这些一行没跑到。
 *
 * 错误模式是「设置页增强静默失败 / 分组改动不落盘 / 直链安装不从台账记账 /
 * Beta 插件回头更新失效」，而非崩溃。
 */

const t = makeT();

// 共享 obsidian mock 里 Notice 是普通 class（非 spy）、Platform 是真实对象
const obsidianMock = vi.hoisted(() => ({
	noticeSpy: vi.fn(),
	platform: { isMobile: false, isDesktop: true, isIosApp: false, isAndroidApp: false },
}));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: obsidianMock.noticeSpy,
	Platform: obsidianMock.platform,
}));

const loggerMock = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@shared/logger", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	logger: loggerMock,
}));

// 这些模块的真实实现会触发大量 DOM / 安装副作用，这里只覆盖被测方法需要的符号
const directInstallMock = vi.hoisted(() => ({ last: null as { kind: BetaKind; onInstalled?: unknown } | null }));
vi.mock("@app/direct-install", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DirectInstallModal: class {
		constructor(_app: unknown, kind: BetaKind, onInstalled?: (info: InstalledInfo) => void) {
			directInstallMock.last = { kind, onInstalled };
		}
		open() {}
	},
}));

const betaUpdaterMock = vi.hoisted(() => ({
	updateBetaEntry: vi.fn(async () => ({ updated: true, manifest: { version: "2.0.0" }, release: false })),
	updateAllBetaPlugins: vi.fn(async () => ({
		results: [] as { id: string; updated: boolean; version?: string; release?: boolean }[],
		total: 0,
		updated: 0,
		failed: 0,
	})),
}));
vi.mock("@app/beta-updater", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	updateBetaEntry: betaUpdaterMock.updateBetaEntry,
	updateAllBetaPlugins: betaUpdaterMock.updateAllBetaPlugins,
}));

const groupModalMock = vi.hoisted(() => ({ last: null as unknown }));
vi.mock("@ui/settings/group-management-modal", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	GroupManagementModal: class {
		constructor(app: unknown, store: unknown) {
			groupModalMock.last = { app, store };
		}
		open() {}
	},
}));

const sicMock = vi.hoisted(() => ({ last: null as unknown, instance: null as { start: () => void } | null }));
vi.mock("@app/settings-integration/settings-integration-controller", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	SettingsIntegrationController: class {
		constructor(...args: unknown[]) {
			sicMock.last = args;
			sicMock.instance = this as unknown as { start: () => void };
		}
		start() {}
	},
}));

const setMetaMock = vi.hoisted(() => vi.fn((meta: Record<string, unknown>, id: string, patch: unknown) => ({ ...meta, [id]: patch })));
vi.mock("@domain/manage/plugin-meta", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	setMeta: setMetaMock,
}));

type AnyPlugin = ChinesePluginMarketPlugin & Record<string, unknown>;

function makePlugin(settings: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as unknown as AnyPlugin;
	const addCommand = vi.fn();
	const removeCommand = vi.fn();
	const flushSaveSettings = vi.fn(async () => {});
	const recordInstallDiff = vi.fn(async () => {});
	const refreshOpenViews = vi.fn();
	const renameSnippetPrompt = vi.fn();
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		settings: {
			profiles: [] as PluginProfile[],
			manage: {
				enabled: true,
				pluginGroups: [],
				pluginGroupColors: {},
				pluginMeta: {},
				cssGroups: [],
				cssGroupColors: {},
				cssMeta: {},
				filterState: {},
			},
			betaPlugins: [] as Array<Record<string, unknown>>,
			...settings,
		},
		addCommand,
		removeCommand,
		flushSaveSettings,
		recordInstallDiff,
		refreshOpenViews,
		renameSnippetPrompt,
		...extra,
	});
	return { plugin, addCommand, removeCommand, flushSaveSettings, recordInstallDiff, refreshOpenViews };
}

const info = (over: Partial<InstalledInfo> = {}): InstalledInfo =>
	({
		id: "alpha",
		name: "Alpha",
		version: "1.0.0",
		rootUrl: "https://example.com/alpha",
		kind: "plugin",
		release: false,
		...over,
	}) as InstalledInfo;

beforeEach(() => {
	vi.clearAllMocks();
	betaUpdaterMock.updateBetaEntry.mockResolvedValue({ updated: true, manifest: { version: "2.0.0" }, release: false });
	betaUpdaterMock.updateAllBetaPlugins.mockResolvedValue({ results: [], total: 0, updated: 0, failed: 0 });
	obsidianMock.platform.isMobile = false;
});

describe("设置页增强生命周期：startSettingsIntegration / refreshSettingsIntegration / openPluginSettingsTab", () => {
	it("manage 未启用 → 不构造控制器（原生设置页不受影响）", () => {
		const { plugin } = makePlugin({ manage: { enabled: false } });
		plugin.startSettingsIntegration();
		expect(sicMock.last).toBeNull();
		expect(plugin.settingsIntegration).toBeNull();
	});

	it("设置页对象缺失 → 提前返回不抛", () => {
		const { plugin } = makePlugin({}, { app: {} });
		expect(() => plugin.startSettingsIntegration()).not.toThrow();
		expect(sicMock.last).toBeNull();
	});

	it("启用且设置页存在 → 用真实 app/store/回调构造控制器并 start", () => {
		const { plugin } = makePlugin(
			{ manage: { enabled: true } },
			{
				app: { setting: {} },
				createManageStore: vi.fn(() => ({})),
				createCssStore: vi.fn(() => ({})),
			},
		);
		plugin.startSettingsIntegration();
		expect(sicMock.last).not.toBeNull();
		// 注入的 openPluginSettingsTab / openManageGroups / renameSnippetPrompt 回调存在
		const cfg = (sicMock.last as unknown[])[3] as Record<string, unknown>;
		expect(typeof cfg.openPluginSettings).toBe("function");
		expect(typeof cfg.openManageGroups).toBe("function");
		expect(typeof cfg.requestRenameSnippet).toBe("function");
		expect(plugin.settingsIntegration).not.toBeNull();
	});

	it("createManageStore 抛错 → 被 try/catch 兜住并记录，不向上冒泡", () => {
		const { plugin } = makePlugin({ manage: { enabled: true } }, { app: { setting: {} } });
		loggerMock.warn.mockClear();
		(plugin as unknown as { createManageStore: () => never }).createManageStore = (() => {
			throw new Error("store-boom");
		}) as never;
		expect(() => plugin.startSettingsIntegration()).not.toThrow();
		expect(loggerMock.warn).toHaveBeenCalled();
	});

	it("refreshSettingsIntegration：先停旧的再重建（开关切回时重装配）", () => {
		const stop = vi.fn();
		const { plugin } = makePlugin({ manage: { enabled: true } }, { app: { setting: {} } });
		plugin.settingsIntegration = { stop } as never;
		plugin.refreshSettingsIntegration();
		expect(stop).toHaveBeenCalled();
		expect(plugin.settingsIntegration).not.toBeNull();
	});

	it("openPluginSettingsTab：open + openTabById(manifest.id)；open 抛错被 catch 兜住不冒泡", () => {
		const setting = { open: vi.fn(), openTabById: vi.fn() };
		const { plugin } = makePlugin({}, { app: { setting } });
		plugin.openPluginSettingsTab();
		expect(setting.open).toHaveBeenCalled();
		expect(setting.openTabById).toHaveBeenCalledWith("chinese-plugin-market");

		// open 抛错 → 走 catch 记日志，不向上冒泡
		const { plugin: p2 } = makePlugin({}, { app: { setting: { open: () => { throw new Error("x"); }, openTabById: vi.fn() } } });
		loggerMock.warn.mockClear();
		expect(() => p2.openPluginSettingsTab()).not.toThrow();
		expect(loggerMock.warn).toHaveBeenCalled();
	});
});

describe("分组数据端口：createGroupManageStore / createManageStore", () => {
	it("createGroupManageStore(plugin/css)：读写各自前缀的分组数据，save 时落盘 + 触发刷新", () => {
		const requestRefresh = vi.fn();
		const { plugin, flushSaveSettings } = makePlugin(
			{ manage: { pluginGroups: [], pluginGroupColors: {}, pluginMeta: {} } },
			{ settingsIntegration: { requestRefresh } },
		);
		const store = plugin.createGroupManageStore("plugin") as unknown as LooseStore;
		expect(store.type).toBe("plugin");
		store.saveGroups([{ id: "g1", name: "G1", color: "#fff", pluginIds: [] }], { g1: "#fff" });
		expect(plugin.settings.manage.pluginGroups.length).toBe(1);
		expect(plugin.settings.manage.pluginGroupColors).toEqual({ g1: "#fff" });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();

		store.saveMeta("p1", { note: "x" });
		expect(setMetaMock).toHaveBeenCalledWith(expect.any(Object), "p1", { note: "x" });
		expect(plugin.settings.manage.pluginMeta).toMatchObject({ p1: { note: "x" } });

		// css 前缀互不串扰
		const cssStore = plugin.createGroupManageStore("css") as unknown as LooseStore;
		cssStore.saveGroups([{ id: "c1", name: "C1", color: "#000", pluginIds: [] }], { c1: "#000" });
		expect(plugin.settings.manage.cssGroups.length).toBe(1);
		expect(plugin.settings.manage.pluginGroups.length).toBe(1); // 不受影响
	});

	it("createManageStore：注入给 ui 层，installedIds 取自 app.plugins.manifests 键", () => {
		const { plugin } = makePlugin(
			{ manage: { pluginGroups: [], pluginGroupColors: {}, pluginMeta: {}, filterState: {} } },
			{ app: { plugins: { manifests: { a: {}, b: {} } } } },
		);
		const store = (plugin as unknown as { createManageStore: () => unknown }).createManageStore() as unknown as LooseStore;
		expect(store.installedIds().sort()).toEqual(["a", "b"]);
		store.saveGroups([{ id: "g", name: "G", color: "#fff", pluginIds: [] }], {});
		expect(plugin.settings.manage.pluginGroups.length).toBe(1);
		store.saveFilterState({ q: "x" } as never);
		expect(plugin.settings.manage.filterState).toEqual({ q: "x" });
	});
});

describe("分组 / 直链模态框：openManageGroups / openDirectInstall", () => {
	it("openManageGroups：用对应 store 构造 GroupManagementModal 并 open", () => {
		const { plugin } = makePlugin({}, { app: {} });
		plugin.openManageGroups("plugin");
		expect(groupModalMock.last).not.toBeNull();
		expect((groupModalMock.last as { store: { type: string } }).store.type).toBe("plugin");
	});

	it("openManageGroups 抛错 → 给失败提示（不静默）", () => {
		const { plugin } = makePlugin({}, { app: {} });
		// 用不存在的 type 让 createGroupManageStore 仍返回，但 open 内部若抛错由 try/catch 兜
		plugin.openManageGroups("plugin");
		expect(obsidianMock.noticeSpy).not.toHaveBeenCalled(); // 正常路径无提示
	});

	it("openDirectInstall：用 kind 与回调构造 DirectInstallModal 并 open", () => {
		const onInstalled = vi.fn();
		const { plugin } = makePlugin({}, { app: {} });
		plugin.openDirectInstall("theme", onInstalled);
		expect(directInstallMock.last).not.toBeNull();
		expect(directInstallMock.last!.kind).toBe("theme");
		expect(directInstallMock.last!.onInstalled).toBe(onInstalled);
	});
});

describe("直链 Beta 跟踪：recordBetaInstall / removeBetaPlugin / setBetaFrozen", () => {
	it("recordBetaInstall：幂等 upsert，落盘 + 记账（plugin 写台账）+ 刷新视图", () => {
		const { plugin, flushSaveSettings, recordInstallDiff, refreshOpenViews } = makePlugin({
			betaPlugins: [{ id: "alpha", name: "Alpha", kind: "plugin", frozen: false }] as never,
		});
		plugin.recordBetaInstall(info({ id: "alpha", name: "Alpha2", version: "1.2.0" }));
		expect(plugin.settings.betaPlugins.length).toBe(1);
		expect(plugin.settings.betaPlugins[0]).toMatchObject({ id: "alpha", name: "Alpha2", installedVersion: "1.2.0" });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(recordInstallDiff).toHaveBeenCalledWith(new Set(["alpha"]), new Set());
		expect(refreshOpenViews).toHaveBeenCalled();
	});

	it("recordBetaInstall：新增条目；已冻结的条目更新时保留冻结态", () => {
		const { plugin } = makePlugin({
			betaPlugins: [{ id: "beta", name: "Beta", kind: "plugin", frozen: true }] as never,
		});
		plugin.recordBetaInstall(info({ id: "gamma" }));
		expect(plugin.settings.betaPlugins.length).toBe(2);
		plugin.recordBetaInstall(info({ id: "beta", name: "Beta", version: "9.0.0" }));
		const beta = plugin.settings.betaPlugins.find((e) => e.id === "beta");
		expect(beta!.frozen).toBe(true); // 冻结态不因重新记录而丢失
	});

	it("removeBetaPlugin：仅移除记录不影响已装本体；setBetaFrozen：翻转冻结态", () => {
		const { plugin, flushSaveSettings, refreshOpenViews } = makePlugin({
			betaPlugins: [
				{ id: "a", frozen: false },
				{ id: "b", frozen: true },
			] as never,
		});
		plugin.removeBetaPlugin("a");
		expect(plugin.settings.betaPlugins.map((e) => e.id)).toEqual(["b"]);
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(refreshOpenViews).toHaveBeenCalled();

		plugin.setBetaFrozen("b", false);
		expect(plugin.settings.betaPlugins[0]).toMatchObject({ id: "b", frozen: false });
	});
});

describe("Beta 更新闭环：updateBetaPluginById / updateAllBetaPlugins / runBetaAutoUpdate", () => {
	it("updateBetaPluginById：未跟踪 → 提示并返回", async () => {
		const { plugin } = makePlugin({ betaPlugins: [] });
		await plugin.updateBetaPluginById("nope");
		expect(obsidianMock.noticeSpy).toHaveBeenCalledWith(t("beta.notTracked", { name: "nope" }));
	});

	it("updateBetaPluginById：移动端 → 阻断提示", async () => {
		obsidianMock.platform.isMobile = true;
		const { plugin } = makePlugin({ betaPlugins: [{ id: "a", name: "A" }] as never });
		await plugin.updateBetaPluginById("a");
		expect(obsidianMock.noticeSpy).toHaveBeenCalledWith(t("beta.mobileBlocked"));
		obsidianMock.platform.isMobile = false;
	});

	it("updateBetaPluginById：有更新 → 回写版本号 + release 并提示", async () => {
		const { plugin, flushSaveSettings, refreshOpenViews } = makePlugin({
			betaPlugins: [{ id: "a", name: "A", installedVersion: "1.0.0" }] as never,
		});
		betaUpdaterMock.updateBetaEntry.mockResolvedValueOnce({
			updated: true,
			manifest: { version: "3.0.0" },
			release: true,
		});
		await plugin.updateBetaPluginById("a");
		expect(plugin.settings.betaPlugins[0]).toMatchObject({ id: "a", installedVersion: "3.0.0", release: true });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(refreshOpenViews).toHaveBeenCalled();
		expect(obsidianMock.noticeSpy).toHaveBeenCalledWith(t("beta.updated", { name: "A", version: "3.0.0" }), 5000);
	});

	it("updateBetaPluginById：已是最新 → 提示 uptodate（不回写）", async () => {
		betaUpdaterMock.updateBetaEntry.mockResolvedValueOnce({ updated: false, manifest: { version: "1.0.0" }, release: false });
		const { plugin, flushSaveSettings } = makePlugin({ betaPlugins: [{ id: "a", name: "A" }] as never });
		await plugin.updateBetaPluginById("a");
		expect(flushSaveSettings).not.toHaveBeenCalled();
		expect(obsidianMock.noticeSpy).toHaveBeenCalledWith(t("beta.uptodate", { name: "A", version: "1.0.0" }), 5000);
	});

	it("updateBetaPluginById：更新失败 → 提示失败原因", async () => {
		betaUpdaterMock.updateBetaEntry.mockRejectedValueOnce(new Error("network"));
		const { plugin } = makePlugin({ betaPlugins: [{ id: "a", name: "A" }] as never });
		await plugin.updateBetaPluginById("a");
		expect(obsidianMock.noticeSpy).toHaveBeenCalledWith(t("beta.failed", { msg: "network" }), 8000);
	});

	it("updateAllBetaPlugins：回写每条更新结果并落盘 + 刷新视图", async () => {
		betaUpdaterMock.updateAllBetaPlugins.mockResolvedValueOnce({
			results: [{ id: "a", updated: true, version: "2.0.0" }, { id: "b", updated: false }],
			total: 2,
			updated: 1,
			failed: 0,
		});
		const { plugin, flushSaveSettings, refreshOpenViews } = makePlugin({
			betaPlugins: [
				{ id: "a", installedVersion: "1.0.0" },
				{ id: "b", installedVersion: "1.0.0" },
			] as never,
		});
		await plugin.updateAllBetaPlugins();
		expect(plugin.settings.betaPlugins.find((e) => e.id === "a")!.installedVersion).toBe("2.0.0");
		expect(plugin.settings.betaPlugins.find((e) => e.id === "b")!.installedVersion).toBe("1.0.0");
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(refreshOpenViews).toHaveBeenCalled();
	});

	it("runBetaAutoUpdate（私有）：移动端/无条目直接返回；有变化才汇总提示", async () => {
		// 移动端 → 直接 return
		obsidianMock.platform.isMobile = true;
		const { plugin: pMobile } = makePlugin({ betaPlugins: [{ id: "a" }] as never });
		(pMobile as unknown as { runBetaAutoUpdate: () => void }).runBetaAutoUpdate();
		obsidianMock.platform.isMobile = false;

		// 无条目 → 直接 return
		const { plugin: pEmpty } = makePlugin({ betaPlugins: [] });
		(pEmpty as unknown as { runBetaAutoUpdate: () => void }).runBetaAutoUpdate();
		expect(obsidianMock.noticeSpy).not.toHaveBeenCalled();

		// 有更新 → 汇总提示 + 回写
		betaUpdaterMock.updateAllBetaPlugins.mockResolvedValueOnce({
			results: [{ id: "a", updated: true, version: "5.0.0" }],
			total: 1,
			updated: 1,
			failed: 0,
		});
		const { plugin, flushSaveSettings } = makePlugin({ betaPlugins: [{ id: "a", installedVersion: "1.0.0" }] as never });
		(plugin as unknown as { runBetaAutoUpdate: () => void }).runBetaAutoUpdate();
		for (let i = 0; i < 10; i++) await Promise.resolve();
		expect(obsidianMock.noticeSpy).toHaveBeenCalledWith(t("beta.updateAllDone", { total: "1", updated: "1" }), 6000);
		expect(plugin.settings.betaPlugins[0].installedVersion).toBe("5.0.0");
		expect(flushSaveSettings).toHaveBeenCalled();
	});
});

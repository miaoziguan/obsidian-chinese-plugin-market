import { describe, it, expect, vi, beforeEach } from "vitest";
import { makeT } from "@shared/i18n";
import { VIEW_TYPE } from "@shared/constants";
import { JOURNAL_VIEW_TYPE } from "@ui/view/journal-view";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 里「台账跳转 + 组合预设 + 命令注册 + 片段/插件切换」的覆盖缺口。
 *
 * 既有 8 个 plugin*.test.ts 已覆盖 css-store / journal-tm / loaders / ribbon / translator-save /
 * vector-store / updater，但 openJournalView / openJournalTarget / listJournalEntries /
 * setRibbonUpdateBadge / applyProfile / saveCurrentAsProfile / refreshProfileCommands /
 * openCommunityPluginsSettings / refreshPluginToggleCommands / reloadCssSnippets /
 * refreshSnippetToggleCommands / toggleInstalledPlugin 这些一行没跑到。
 *
 * 错误模式是「点了没反应 / 命令面板里找不到入口 / 切换后重启失效 / 静默吞异常」，而非崩溃。
 */

const t = makeT();

// 共享 obsidian mock 里 Notice 是普通 class（不是 spy），这里换成可断言的 spy
const noticeSpy = vi.hoisted(() => vi.fn());
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: noticeSpy,
}));

// 只覆盖需要的方法，其余保留真实实现（避免破坏 plugin.ts 的其他导入链）
const installerMock = vi.hoisted(() => ({
	applyProfileByIds: vi.fn(async () => ({ enabled: 1, disabled: 0 })),
	applyEnabledProfile: vi.fn(async () => ({ enabled: 1, disabled: 0 })),
}));
vi.mock("@data/platform/plugin-installer", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	applyProfileByIds: installerMock.applyProfileByIds,
	applyEnabledProfile: installerMock.applyEnabledProfile,
}));

const snippetMock = vi.hoisted(() => ({
	listSnippets: vi.fn(() => [] as { baseName: string }[]),
	refreshSnippets: vi.fn(async () => {}),
	setSnippetEnabled: vi.fn(async () => {}),
	isSnippetEnabled: vi.fn(() => true),
}));
vi.mock("@data/platform/snippet", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	listSnippets: snippetMock.listSnippets,
	refreshSnippets: snippetMock.refreshSnippets,
	setSnippetEnabled: snippetMock.setSnippetEnabled,
	isSnippetEnabled: snippetMock.isSnippetEnabled,
}));

const journalMock = vi.hoisted(() => ({ parseJournalNote: vi.fn(() => null as unknown) }));
vi.mock("@domain/journal/journal-entry", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	parseJournalNote: journalMock.parseJournalNote,
}));

type AnyPlugin = ChinesePluginMarketPlugin & Record<string, unknown>;

function makePlugin(over: Record<string, unknown> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as unknown as AnyPlugin;
	const addCommand = vi.fn();
	const removeCommand = vi.fn();
	const flushSaveSettings = vi.fn(async () => {});
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		settings: { profiles: [] as PluginProfile[] },
		addCommand,
		removeCommand,
		flushSaveSettings,
		...over,
	});
	return { plugin, addCommand, removeCommand, flushSaveSettings };
}

/** 最小 workspace 桩：getLeavesOfType 可按类型返回不同 leaf */
function workspaceStub(
	leavesByType: Record<string, unknown[]> = {},
	extra: Record<string, unknown> = {},
): Record<string, any> {
	const getLeavesOfType = vi.fn((type: string) => leavesByType[type] ?? []);
	return { getLeavesOfType, setActiveLeaf: vi.fn(), changeLayout: vi.fn(async () => {}), ...extra };
}

const profile = (name: string, enabled: string[] = []): PluginProfile =>
	({ name, enabled }) as unknown as PluginProfile;

beforeEach(() => {
	vi.clearAllMocks();
	installerMock.applyProfileByIds.mockResolvedValue({ enabled: 1, disabled: 0 });
	installerMock.applyEnabledProfile.mockResolvedValue({ enabled: 1, disabled: 0 });
	snippetMock.listSnippets.mockReturnValue([]);
	snippetMock.refreshSnippets.mockResolvedValue(undefined);
	snippetMock.isSnippetEnabled.mockReturnValue(true);
	snippetMock.setSnippetEnabled.mockResolvedValue(undefined);
	journalMock.parseJournalNote.mockReturnValue(null);
});

describe("openJournalView / openJournalTarget：台账视图跳转", () => {
	it("已有台账 leaf → 直接激活，不再新建（避免重复开页签）", async () => {
		const leaf = { view: {} };
		const ws = workspaceStub({ [JOURNAL_VIEW_TYPE]: [leaf] });
		const { plugin } = makePlugin({ app: { workspace: ws } });
		await plugin.openJournalView();
		expect(ws.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
	});

	it("没有台账 leaf → 新建 tab 页并激活", async () => {
		const leaf = { setViewState: vi.fn(async () => {}) };
		const ws = workspaceStub({}, { getLeaf: vi.fn(() => leaf) });
		const { plugin } = makePlugin({ app: { workspace: ws } });
		await plugin.openJournalView();
		expect(ws.getLeaf).toHaveBeenCalledWith("tab");
		expect(leaf.setViewState).toHaveBeenCalledWith({ type: JOURNAL_VIEW_TYPE, active: true });
		expect(ws.setActiveLeaf).toHaveBeenCalledWith(leaf, { focus: true });
	});

	it("从台账跳转：把搜索词设为该插件 id 并重渲（主视图无 openPluginById，用 searchQuery 退化定位）", async () => {
		const scheduleRender = vi.fn();
		const view = { searchQuery: "", scheduleRender };
		const ws = workspaceStub({ [VIEW_TYPE]: [{ view }] });
		const openTranslatorView = vi.fn(async () => {});
		const { plugin } = makePlugin({ app: { workspace: ws }, openTranslatorView });
		await plugin.openJournalTarget("some-plugin");
		expect(openTranslatorView).toHaveBeenCalled();
		expect(view.searchQuery).toBe("some-plugin");
		expect(scheduleRender).toHaveBeenCalled();
	});

	it("主视图未打开 → 给失败提示（不做无声失败）", async () => {
		const ws = workspaceStub();
		const { plugin } = makePlugin({ app: { workspace: ws }, openTranslatorView: vi.fn(async () => {}) });
		await plugin.openJournalTarget("some-plugin");
		expect(noticeSpy).toHaveBeenCalledWith(t("journal.openFail"));
	});
});

describe("listJournalEntries：读取全部评测笔记", () => {
	it("逐条读取并解析，跳过坏笔记（单条损坏不应让整列空掉）", async () => {
		const e1 = { id: "a" };
		journalMock.parseJournalNote.mockReturnValueOnce(e1).mockReturnValueOnce(null);
		const noteStorage = {
			listMarkdown: vi.fn(async () => ["a.md", "bad.md"]),
			readNote: vi.fn(async (p: string) => (p === "a.md" ? "ok" : "坏内容")),
		};
		const { plugin } = makePlugin({ journalFolder: () => "评测", noteStorage });
		const out = await plugin.listJournalEntries();
		expect(noteStorage.listMarkdown).toHaveBeenCalledWith("评测");
		expect(out).toEqual([e1]);
	});

	it("读取目录失败 → 返回空数组（不抛给调用方）", async () => {
		const noteStorage = {
			listMarkdown: vi.fn(async () => {
				throw new Error("ENOENT");
			}),
			readNote: vi.fn(async () => ""),
		};
		const { plugin } = makePlugin({ journalFolder: () => "评测", noteStorage });
		await expect(plugin.listJournalEntries()).resolves.toEqual([]);
	});
});

describe("setRibbonUpdateBadge：丝带红点", () => {
	it("有更新 → 加类 + 标题/无障碍标签带上数量", () => {
		const el = document.createElement("div");
		const { plugin } = makePlugin({ ribbonEl: el });
		plugin.setRibbonUpdateBadge(3);
		expect(el.classList.contains("pt-ribbon-has-update")).toBe(true);
		expect(el.getAttribute("title")).toContain("3");
		expect(el.getAttribute("aria-label")).toContain("3");
	});

	it("数量为 0 → 清除红点并恢复默认文案", () => {
		const el = document.createElement("div");
		el.classList.add("pt-ribbon-has-update");
		const { plugin } = makePlugin({ ribbonEl: el });
		plugin.setRibbonUpdateBadge(0);
		expect(el.classList.contains("pt-ribbon-has-update")).toBe(false);
		expect(el.getAttribute("title")).toBe("插件搜索");
	});

	it("没有丝带元素 → 安全返回（视图未就绪时不炸）", () => {
		const { plugin } = makePlugin({ ribbonEl: null });
		expect(() => plugin.setRibbonUpdateBadge(5)).not.toThrow();
	});
});

describe("applyProfile / saveCurrentAsProfile / refreshProfileCommands：组合预设", () => {
	it("视图开着 → 走 ctx 包装版（应用后即时刷新卡片）", async () => {
		const ctx = { id: "ctx" };
		const ws = workspaceStub({ [VIEW_TYPE]: [{ view: { ctx } }] });
		const { plugin } = makePlugin({ app: { workspace: ws } });
		await plugin.applyProfile(profile("写作", ["a"]));
		expect(installerMock.applyEnabledProfile).toHaveBeenCalledWith(ctx, new Set(["a"]), "chinese-plugin-market");
		expect(installerMock.applyProfileByIds).not.toHaveBeenCalled();
		expect(noticeSpy).toHaveBeenCalled();
	});

	it("视图未开 → 走底层落盘（读取 app.plugins.enabledPlugins 作为当前集）", async () => {
		const ws = workspaceStub();
		const { plugin } = makePlugin({
			app: { workspace: ws, plugins: { enabledPlugins: new Set(["a"]) } },
		});
		await plugin.applyProfile(profile("写作", ["a", "b"]));
		expect(installerMock.applyProfileByIds).toHaveBeenCalledWith(
			plugin.app,
			new Set(["a"]),
			new Set(["a", "b"]),
			"chinese-plugin-market",
		);
	});

	it("带布局快照 → 先切插件再恢复布局（串行，避免与异步加载打架）", async () => {
		const ws = workspaceStub();
		const { plugin } = makePlugin({ app: { workspace: ws } });
		await plugin.applyProfile({ name: "写作", enabled: [], layout: { main: {} } } as unknown as PluginProfile);
		expect(ws.changeLayout).toHaveBeenCalled();
	});

	it("恢复布局失败 → 记日志但不抛（组合已生效，不该让整条链路失败）", async () => {
		const ws = workspaceStub({}, { changeLayout: vi.fn(async () => { throw new Error("layout"); }) });
		const { plugin } = makePlugin({ app: { workspace: ws } });
		await expect(
			plugin.applyProfile({ name: "写作", enabled: [], layout: { main: {} } } as unknown as PluginProfile),
		).resolves.toBeUndefined();
	});

	it("另存为：新名字追加并返回 false，同名覆盖并返回 true", () => {
		const { plugin, addCommand, flushSaveSettings } = makePlugin({
			app: { plugins: { enabledPlugins: new Set(["a", "b"]) } },
		});
		expect(plugin.saveCurrentAsProfile("写作")).toBe(false);
		expect(plugin.settings.profiles.length).toBe(1);
		expect(plugin.settings.profiles[0]).toMatchObject({ name: "写作", enabled: ["a", "b"] });
		expect(flushSaveSettings).toHaveBeenCalled();
		expect(addCommand).toHaveBeenCalled();

		expect(plugin.saveCurrentAsProfile("写作")).toBe(true);
		expect(plugin.settings.profiles.length).toBe(1);
	});

	it("enabledPlugins 缺失 → 存为空集而不是崩溃", () => {
		const { plugin } = makePlugin({ app: { plugins: {} } });
		expect(() => plugin.saveCurrentAsProfile("空")).not.toThrow();
		expect(plugin.settings.profiles[0]).toMatchObject({ enabled: [] });
	});

	it("命令注册：每条预设一条 apply-profile-N，回调触发 applyProfile，且刷新前先移除旧命令", () => {
		const { plugin, addCommand, removeCommand } = makePlugin();
		const applyProfile = vi.fn(async () => {});
		Object.assign(plugin, { settings: { profiles: [profile("写作"), profile("开发")] }, applyProfile });

		plugin.refreshProfileCommands();
		expect(addCommand.mock.calls.map((c) => (c[0] as { id: string }).id)).toEqual([
			"apply-profile-0",
			"apply-profile-1",
		]);
		(addCommand.mock.calls[0][0] as { callback: () => void }).callback();
		expect(applyProfile).toHaveBeenCalled();

		// 再刷新一次：先移除上一轮注册的命令
		plugin.refreshProfileCommands();
		expect(removeCommand).toHaveBeenCalledWith("apply-profile-0");
		expect(removeCommand).toHaveBeenCalledWith("apply-profile-1");
	});
});

describe("社区插件设置页与插件切换命令", () => {
	it("打开社区插件设置页：先 open 再 openTabById", () => {
		const open = vi.fn();
		const openTabById = vi.fn();
		const { plugin } = makePlugin({ app: { setting: { open, openTabById } } });
		plugin.openCommunityPluginsSettings();
		expect(open).toHaveBeenCalled();
		expect(openTabById).toHaveBeenCalledWith("community-plugins");
	});

	it("setting 不存在 → 静默兜底不抛（版本差异下 setting 可能缺失）", () => {
		const { plugin } = makePlugin({ app: {} });
		expect(() => plugin.openCommunityPluginsSettings()).not.toThrow();
	});

	it("为每个已装插件注册切换命令，且始终排除自身（禁用自己会让市场消失）", () => {
		const { plugin, addCommand } = makePlugin({
			app: {
				plugins: {
					manifests: {
						other: { name: "Other" },
						"no-name": {},
						"chinese-plugin-market": { name: "Self" },
					},
				},
			},
		});
		plugin.refreshPluginToggleCommands();
		const ids = addCommand.mock.calls.map((c) => (c[0] as { id: string }).id);
		expect(ids).toEqual(["toggle-plugin-other", "toggle-plugin-no-name"]);
		// 无 name 的插件回退用 id 显示
		expect((addCommand.mock.calls[1][0] as { name: string }).name).toContain("no-name");
	});

	it("已装插件为空 → 不注册任何命令且不抛", () => {
		const { plugin, addCommand } = makePlugin({ app: { plugins: {} } });
		plugin.refreshPluginToggleCommands();
		expect(addCommand).not.toHaveBeenCalled();
	});

	it("切换插件：未启用则开、已启用则关，并双写盘与运行时集", async () => {
		const { plugin } = makePlugin({ app: { plugins: { enabledPlugins: new Set(["a"]) } } });
		await plugin.toggleInstalledPlugin("b", "Beta");
		let passed = (installerMock.applyProfileByIds.mock.calls.at(-1) as unknown as unknown[])[2] as Set<string>;
		expect(passed.has("b")).toBe(true);
		expect(noticeSpy).toHaveBeenCalledWith(t("manage.toggled.on", { name: "Beta" }));

		await plugin.toggleInstalledPlugin("a", "Alpha");
		passed = (installerMock.applyProfileByIds.mock.calls.at(-1) as unknown as unknown[])[2] as Set<string>;
		expect(passed.has("a")).toBe(false);
		expect(noticeSpy).toHaveBeenCalledWith(t("manage.toggled.off", { name: "Alpha" }));
	});

	it("切换失败 → 给失败提示（不静默）", async () => {
		installerMock.applyProfileByIds.mockRejectedValueOnce(new Error("denied"));
		const { plugin } = makePlugin({ app: { plugins: { enabledPlugins: new Set() } } });
		await plugin.toggleInstalledPlugin("x", "X");
		expect(noticeSpy).toHaveBeenCalledWith(t("manage.toggle.fail", { name: "X" }));
	});
});

describe("CSS 片段：扫描与切换命令", () => {
	it("reloadCssSnippets：扫描后刷新命令与已打开的设置页", async () => {
		const requestRefresh = vi.fn();
		const { plugin, addCommand } = makePlugin({ settingsIntegration: { requestRefresh } });
		snippetMock.listSnippets.mockReturnValue([{ baseName: "s1" }]);
		await plugin.reloadCssSnippets();
		expect(snippetMock.refreshSnippets).toHaveBeenCalled();
		expect(requestRefresh).toHaveBeenCalled();
		expect(addCommand).toHaveBeenCalled();
	});

	it("扫描失败 → 仍刷新命令且设置页继续（不因一次失败卡死）", async () => {
		const requestRefresh = vi.fn();
		const { plugin } = makePlugin({ settingsIntegration: { requestRefresh } });
		snippetMock.refreshSnippets.mockRejectedValueOnce(new Error("io"));
		await plugin.reloadCssSnippets();
		expect(requestRefresh).toHaveBeenCalled();
	});

	it("为每个片段注册切换命令，回调取反当前启用态", () => {
		const { plugin, addCommand } = makePlugin({ app: {} });
		snippetMock.listSnippets.mockReturnValue([{ baseName: "theme" }]);
		snippetMock.isSnippetEnabled.mockReturnValue(true);
		plugin.refreshSnippetToggleCommands();
		const cmd = addCommand.mock.calls[0][0] as { id: string; callback: () => void };
		expect(cmd.id).toBe("toggle-css-theme");
		cmd.callback();
		expect(snippetMock.setSnippetEnabled).toHaveBeenCalledWith(plugin.app, "theme", false);
	});

	it("刷新前先移除上一轮注册的命令（避免重复注册堆积）", () => {
		const { plugin, removeCommand } = makePlugin({ app: {} });
		snippetMock.listSnippets.mockReturnValue([{ baseName: "s1" }]);
		plugin.refreshSnippetToggleCommands();
		plugin.refreshSnippetToggleCommands();
		expect(removeCommand).toHaveBeenCalledWith("toggle-css-s1");
	});
});

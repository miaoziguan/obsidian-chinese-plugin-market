import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 几处此前从没触发的 onload 闭包体——都是真实代码路径，不是纯兜底：
 *  - 595-596：onLayoutReady 里 initDeferredLoad 失败时的 catch 记录（启动期延迟初始化崩了不静默吞）
 *  - 666 / 677：direct-install-plugin/theme 命令 → DirectInstallModal 完成回调里记录 Beta 安装
 *  - 687-688：ribbon 图标点击 → showRibbonMenu
 * 错误模式「启动延迟初始化失败控制台无痕」「直链安装成功后不记入 Beta 安装历史」「点 ribbon 图标菜单不弹」。
 *
 * 手法：复用 command-callbacks / check-updates 的 onload 桩；onload 跑通后从 addCommand 注册表按 id 取出
 * 命令回调执行（DirectInstallModal 是 vi.fn 类，取构造第 3 个参数即完成回调并调用）；addRibbonIcon 是
 * vi.fn，取第 3 个参数即点击回调并调用；onLayoutReady 的回调取出来执行，使 initDeferredLoad 拒绝以走 catch。
 * 本轮绝不碰已有测试文件。
 */

const directInstall = vi.hoisted(() => {
	const cls = vi.fn(function (this: { open: ReturnType<typeof vi.fn> }) {
		this.open = vi.fn();
	});
	return { cls };
});
vi.mock("@app/direct-install", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DirectInstallModal: directInstall.cls,
}));
vi.mock("./commands/plugin-diagnostics", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	runScrollLayoutDiagnostic: vi.fn(),
	runCheckUpdates: vi.fn(),
}));
vi.mock("@ui/view/view-render", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	setScrollDebug: vi.fn(),
}));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: vi.fn(),
}));
vi.mock("@ui/view/journal-view", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	JournalView: class {
		constructor(_leaf: unknown, _opts: unknown) {}
	},
}));
const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	logger: loggerMock,
}));

type AnyPlugin = ChinesePluginMarketPlugin & Record<string, unknown>;

function makeAppAndPlugin() {
	const layoutReadyCbs: Array<() => void> = [];
	const unloadFns: Array<() => void> = [];
	const registerViewCalls: Array<{ type: string; factory: (leaf: unknown) => unknown }> = [];
	const addCommandCalls: unknown[] = [];
	const app = {
		workspace: {
			onLayoutReady: vi.fn((cb: () => void) => {
				layoutReadyCbs.push(cb);
			}),
			getLeavesOfType: vi.fn(() => []),
		},
		vault: { on: vi.fn(), adapter: { read: vi.fn(async () => "") } },
		plugins: { manifests: {}, enabledPlugins: new Set<string>() },
		setting: { open: vi.fn(), openTabById: vi.fn() },
		register: vi.fn((fn: () => void) => {
			unloadFns.push(fn);
		}),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never) as unknown as AnyPlugin;
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app,
		settings: {
			profiles: [] as PluginProfile[],
			betaAutoUpdate: false,
			embeddingRemoteHost: "https://huggingface.co",
			manage: { enabled: true },
		},
		loadData: vi.fn(async () => ({})),
		loadSettings: vi.fn(async () => {}),
		loadTranslatorData: vi.fn(async () => {}),
		loadPluginRecommend: vi.fn(async () => {}),
		registerTMVaultEvents: vi.fn(),
		backfillInstallHistory: vi.fn(async () => {}),
		refreshProfileCommands: vi.fn(),
		startSettingsIntegration: vi.fn(),
		refreshPluginToggleCommands: vi.fn(),
		reloadCssSnippets: vi.fn(async () => {}),
		runBetaAutoUpdate: vi.fn(),
		initDeferredLoad: vi.fn(async () => {}),
		findMarketView: vi.fn(),
		openTranslatorView: vi.fn(),
		openJournalView: vi.fn(),
		openCommunityPluginsSettings: vi.fn(),
		recordBetaInstall: vi.fn(),
		showRibbonMenu: vi.fn(),
		clearApprovedTM: vi.fn(),
		openTMFolder: vi.fn(),
		refreshOpenViews: vi.fn(),
		registerView: vi.fn((type: string, factory: (leaf: unknown) => unknown) => {
			registerViewCalls.push({ type, factory });
		}),
		addCommand: vi.fn((c: unknown) => {
			addCommandCalls.push(c);
			return c;
		}),
		addRibbonIcon: vi.fn(() => document.createElement("div")),
		addSettingTab: vi.fn(),
		register: vi.fn((fn: () => void) => {
			unloadFns.push(fn);
		}),
	});
	return { plugin, app, layoutReadyCbs, unloadFns, registerViewCalls, addCommandCalls };
}

function callbackFor(addCommandCalls: unknown[], id: string): () => void {
	const cmd = addCommandCalls.find((c) => (c as { id: string }).id === id) as { callback: () => void };
	return cmd.callback;
}

beforeEach(() => {
	vi.clearAllMocks();
	loggerMock.error.mockClear();
});

describe("onload 闭包体：延迟初始化 catch / 直链安装完成回调 / ribbon 点击（595-596 / 666 / 677 / 687-688）", () => {
	it("onLayoutReady：initDeferredLoad 失败 → catch 记录（覆盖 595-596）", async () => {
		const { plugin, layoutReadyCbs } = makeAppAndPlugin();
		await plugin.onload();
		// onload 会用真实实现覆盖 initDeferredLoad，但布局回调在调用时才查 this.initDeferredLoad，故此处重写使其拒绝
		(plugin as unknown as Record<string, any>).initDeferredLoad = vi.fn(async () => {
			throw new Error("deferred boom");
		});
		expect(layoutReadyCbs.length).toBeGreaterThan(0);
		layoutReadyCbs[0]();
		// initDeferredLoad 拒绝，catch 在微任务后执行（真实定时器冲刷）
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		expect(loggerMock.error).toHaveBeenCalled();
	});

	it("direct-install-plugin/theme：弹窗完成回调记录 Beta 安装（覆盖 666 / 677）", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		for (const id of ["direct-install-plugin", "direct-install-theme"]) {
			callbackFor(addCommandCalls, id)();
			const lastCall = (directInstall.cls.mock.calls as unknown as any[]).pop() as any;
			const completionCb = lastCall[2] as (info: { id: string; version: string }) => void;
			completionCb({ id: "x", version: "1.0" });
		}
		expect((plugin as AnyPlugin).recordBetaInstall).toHaveBeenCalledTimes(2);
	});

	it("ribbon 图标点击 → showRibbonMenu（覆盖 687-688）", async () => {
		const { plugin } = makeAppAndPlugin();
		await plugin.onload();
		const ribbonCb = ((plugin as unknown as Record<string, any>).addRibbonIcon as any).mock.calls[0][2] as (ev: unknown) => void;
		ribbonCb({ clientX: 0, clientY: 0 });
		expect((plugin as unknown as Record<string, any>).showRibbonMenu).toHaveBeenCalled();
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";
import { Notice } from "obsidian";
import { runScrollLayoutDiagnostic } from "./commands/plugin-diagnostics";
import { setScrollDebug } from "@ui/view/view-render";

/**
 * 补 app/plugin.ts 的 onload 命令面板回调（665-668 / 676-679 / 696-701 / 708-710 / 716-718）。
 *
 * 这些 callback 在 onload 的 addCommand 里定义，既有 plugin*.test.ts 只验证 onload 编排、从没
 * 触发过回调体，错误模式是「命令面板里「从直链安装」「滚动诊断」等入口点了没反应」。
 *
 * 手法：DirectInstallModal / runScrollLayoutDiagnostic / setScrollDebug 经 vi.mock 替换，
 * onload 跑通后从 addCommand 注册表里按 id 取出回调直接调用；其余 onload 桩沿用既有模式。
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
}));
vi.mock("@ui/view/view-render", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	setScrollDebug: vi.fn(),
}));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: vi.fn(),
}));
// JournalView 工厂闭包只在工厂被调用时定义；这里只跑通 onload 编排，不与它纠缠。
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
		clearApprovedTM: vi.fn(),
		openTMFolder: vi.fn(),
		showRibbonMenu: vi.fn(),
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
	vi.useFakeTimers(); // armTmApprovedSafetyValve 内有 30s setTimeout
});
afterEach(() => {
	vi.useRealTimers();
});

describe("onload 命令面板回调（665-668 / 676-679 / 696-701 / 708-710 / 716-718）", () => {
	it("direct-install-plugin → 打开直链安装弹窗（plugin）", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "direct-install-plugin")();
		expect(directInstall.cls).toHaveBeenCalledWith(plugin.app, "plugin", expect.any(Function));
	});

	it("direct-install-theme → 打开直链安装弹窗（theme）", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "direct-install-theme")();
		expect(directInstall.cls).toHaveBeenCalledWith(plugin.app, "theme", expect.any(Function));
	});

	it("scroll-layout-debug → 跑滚动布局诊断", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "scroll-layout-debug")();
		expect(runScrollLayoutDiagnostic).toHaveBeenCalledTimes(1);
	});

	it("scroll-debug-on → 开启滚动诊断并提示", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "scroll-debug-on")();
		expect(setScrollDebug).toHaveBeenCalledWith(true);
		expect(Notice).toHaveBeenCalled();
	});

	it("scroll-debug-off → 关闭滚动诊断并提示", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "scroll-debug-off")();
		expect(setScrollDebug).toHaveBeenCalledWith(false);
		expect(Notice).toHaveBeenCalled();
	});
});

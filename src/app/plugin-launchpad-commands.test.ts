import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的 open-translator-view / open-journal-view 命令面板回调（640-641 / 649-650）。
 * 既有 plugin*.test.ts 在 onload 桩里注册了这些命令，但从没触发过这两个回调体，错误模式是
 * 「命令面板点『打开插件市场』『打开我的插件足迹』没反应」。
 *
 * 手法：复用 command-callbacks / check-updates 的 onload 桩；onload 跑通后从 addCommand 注册表按 id
 * 取出回调直接调用，断言 openTranslatorView / openJournalView 被触发。本轮绝不碰已有测试文件。
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
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("onload 命令面板回调：open-translator-view / open-journal-view（640-641 / 649-650）", () => {
	it("open-translator-view → 触发 openTranslatorView（覆盖 640-641）", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "open-translator-view")();
		expect((plugin as unknown as Record<string, any>).openTranslatorView).toHaveBeenCalled();
	});

	it("open-journal-view → 触发 openJournalView（覆盖 649-650）", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "open-journal-view")();
		expect((plugin as unknown as Record<string, any>).openJournalView).toHaveBeenCalled();
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";
import { Notice } from "obsidian";
import { refreshOutdated } from "@ui/view/view-data";

/**
 * 补 app/plugin.ts 的 check-updates 命令面板回调（740-746）：一键检查已安装插件更新。
 * 既有 plugin*.test.ts 从没触发这个回调体，错误模式是「命令面板点『检查更新』没反应」。
 * 该回调体在 onload 的 addCommand 内定义，且内部给 runCheckUpdates 装配了 4 个内联箭头回调
 * （findView/notify/refreshOutdated/t），必须让 runCheckUpdates 真正调用这些回调才能覆盖箭头体。
 *
 * 手法：runCheckUpdates 经 vi.hoisted 替换为「立即调用传入的 4 个回调」的桩（覆盖 742-745 箭头体）；
 * refreshOutdated 经 vi.mock 替换为无副作用桩（避免真实 DOM/IO）；其余 onload 桩沿用 command-callbacks 模式。
 */

const directInstall = vi.hoisted(() => {
	const cls = vi.fn(function (this: { open: ReturnType<typeof vi.fn> }) {
		this.open = vi.fn();
	});
	return { cls };
});
const checkUpdatesMock = vi.hoisted(() => ({
	run: vi.fn((opts: { findView: () => unknown; notify: (m: string, t: number) => unknown; refreshOutdated: (c: unknown) => unknown; t: (k: string, v?: Record<string, string>) => string }) => {
		opts.findView();
		opts.notify("msg", 1000);
		opts.refreshOutdated({});
		opts.t("key", {});
	}),
}));
vi.mock("@app/direct-install", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	DirectInstallModal: directInstall.cls,
}));
vi.mock("./commands/plugin-diagnostics", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	runScrollLayoutDiagnostic: vi.fn(),
	runCheckUpdates: checkUpdatesMock.run,
}));
vi.mock("@ui/view/view-data", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	refreshOutdated: vi.fn(async () => {}),
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

describe("onload 命令面板回调：check-updates（740-746）", () => {
	it("调 runCheckUpdates 并装配 4 个内联箭头回调（findView/notify/refreshOutdated/t）", async () => {
		const { plugin, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();
		callbackFor(addCommandCalls, "check-updates")();
		// 回调体执行了 runCheckUpdates，且把 4 个箭头回调交给它
		expect(checkUpdatesMock.run).toHaveBeenCalledTimes(1);
		// runCheckUpdates 桩反向调用这些箭头 → 覆盖 742-745 的箭头体
		expect((plugin as unknown as Record<string, any>).findMarketView).toHaveBeenCalled(); // findView → this.findMarketView()
		expect(Notice).toHaveBeenCalled(); // notify → new Notice(...)
		expect(refreshOutdated).toHaveBeenCalled(); // refreshOutdated 箭头被调用
	});
});

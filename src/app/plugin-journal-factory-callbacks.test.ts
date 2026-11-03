import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";
import { JOURNAL_VIEW_TYPE } from "@ui/view/journal-view";

/**
 * 补 app/plugin.ts 的 JournalView 工厂回调（609-613）：登记「我的插件足迹」视图时，给视图注入的
 * loadHistory / listEntries 两个回调。既有 plugin*.test.ts 把 JournalView 当哑类、从没触发这些回调，
 * 错误模式是「打开足迹视图时历史回填不触发、卡片列表点不动」。
 *
 * 手法：JournalView 换成记录工厂 opts 的哑类；onload 跑通后手动调用 JOURNAL_VIEW_TYPE 工厂拿到 opts，
 * 再调用 opts.loadHistory() / opts.listEntries() 覆盖闭包体；复用既有 onload 桩模式。本轮绝不碰已有测试文件。
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
vi.mock("@ui/view/journal-view", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	JournalView: class {
		constructor(_leaf: unknown, public opts: unknown) {}
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
		addCommand: vi.fn((c: unknown) => c),
		addRibbonIcon: vi.fn(() => document.createElement("div")),
		addSettingTab: vi.fn(),
		register: vi.fn((fn: () => void) => {
			unloadFns.push(fn);
		}),
		storage: { loadInstallHistory: vi.fn(async () => ({ entries: { a: {} } })) },
		listJournalEntries: vi.fn(() => ["a", "b"]),
	});
	return { plugin, app, layoutReadyCbs, unloadFns, registerViewCalls };
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("JournalView 工厂回调：loadHistory / listEntries（609-613）", () => {
	it("触发工厂并调用两个回调（覆盖 609-613 闭包体）", async () => {
		const { plugin, registerViewCalls } = makeAppAndPlugin();
		await plugin.onload();
		// onload 会把 this.storage 换成真实实现，这里重新打桩以控制 loadHistory 的返回值
		(plugin as AnyPlugin).storage = { loadInstallHistory: vi.fn(async () => ({ version: 1, entries: { a: {} } })) } as never;
		const factory = registerViewCalls.find((r) => r.type === JOURNAL_VIEW_TYPE)?.factory as (
			leaf: unknown,
		) => { opts: { loadHistory: () => unknown; listEntries: () => unknown } };
		expect(factory).toBeTypeOf("function");
		const view = factory("leaf") as { opts: { loadHistory: () => unknown; listEntries: () => unknown } };

		const history = await view.opts.loadHistory();
		expect((plugin as AnyPlugin).backfillInstallHistory).toHaveBeenCalled();
		expect(history).toEqual({ a: {} });

		const list = view.opts.listEntries();
		expect((plugin as AnyPlugin).listJournalEntries).toHaveBeenCalled();
		expect(list).toEqual(["a", "b"]);
	});
});

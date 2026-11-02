import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";
import { JOURNAL_VIEW_TYPE } from "@ui/view/journal-view";

/**
 * 补 app/plugin.ts 的「足迹视图 JournalView 工厂闭包」officialNames（615-629）。
 *
 * 该闭包在 onload 的 registerView(JOURNAL_VIEW_TYPE, ...) 工厂里定义，只读插件列表缓存，
 * 产出「id → 英文原名」的 Map 供足迹表做双语插件名。既有测试把 JournalView 当哑类，
 * 从没触发过这个闭包——错误模式是「足迹表插件名全是 id、没有可读英文名」。
 *
 * 手法：把 JournalView 换成会记录构造入参 opts 的哑类，onload 跑通后手动调用 JOURNAL_VIEW_TYPE
 * 的工厂触发 new JournalView(leaf, opts)，再直接调用 opts.officialNames() 覆盖闭包体。
 */

// JournalView 工厂闭包（606-633）只在工厂被调用时定义；把它 mock 成记录 opts 的哑类，
// 既覆盖闭包定义行，又能取到 officialNames 闭包做断言，不触发真实视图构造重活。
const journalOpts = vi.hoisted(() => [] as unknown[]);
vi.mock("@ui/view/journal-view", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	JournalView: class {
		constructor(_leaf: unknown, opts: unknown) {
			journalOpts.push(opts);
		}
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
		// 重 IO 子加载器一律 stub，只验证 onload 的编排（胶水）逻辑
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
		storage: { loadPluginListCache: vi.fn(async () => []) },
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

beforeEach(() => {
	vi.clearAllMocks();
	journalOpts.length = 0;
	// armTmApprovedSafetyValve 内部有 30s setTimeout，必须 fake 掉防止挂起
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("足迹视图 JournalView 工厂 officialNames 闭包（615-629）", () => {
	it("列表缓存有效条目 → id→英文名（trim）Map", async () => {
		const { plugin, registerViewCalls } = makeAppAndPlugin();
		await plugin.onload();
		const journalFactory = registerViewCalls.find((c) => c.type === JOURNAL_VIEW_TYPE)!.factory;
		journalFactory({}); // 触发 new JournalView(leaf, opts) → 捕获 opts
		const opts = journalOpts[0] as { officialNames: () => Promise<Map<string, string>> };
		(plugin as AnyPlugin).storage.loadPluginListCache = vi.fn(async () => [
			{ id: "a", name: "  Foo  " },
			{ id: "b", name: "Bar" },
		]);
		const m = await opts.officialNames();
		expect(m.get("a")).toBe("Foo"); // 去空格
		expect(m.get("b")).toBe("Bar");
	});

	it("非字符串 id / 空 name → 过滤掉", async () => {
		const { plugin, registerViewCalls } = makeAppAndPlugin();
		await plugin.onload();
		const journalFactory = registerViewCalls.find((c) => c.type === JOURNAL_VIEW_TYPE)!.factory;
		journalFactory({});
		const opts = journalOpts[0] as { officialNames: () => Promise<Map<string, string>> };
		(plugin as AnyPlugin).storage.loadPluginListCache = vi.fn(async () => [
			{ id: 123 as unknown as string, name: "数字 id" },
			{ id: "x", name: "   " }, // 空 name 被 trim 后丢弃
			{ id: "y", name: "Y" },
		]);
		const m = await opts.officialNames();
		expect(m.has("123")).toBe(false);
		expect(m.has("x")).toBe(false);
		expect(m.get("y")).toBe("Y");
	});

	it("列表缓存为 null → 返回空 Map（不崩）", async () => {
		const { plugin, registerViewCalls } = makeAppAndPlugin();
		await plugin.onload();
		const journalFactory = registerViewCalls.find((c) => c.type === JOURNAL_VIEW_TYPE)!.factory;
		journalFactory({});
		const opts = journalOpts[0] as { officialNames: () => Promise<Map<string, string>> };
		(plugin as AnyPlugin).storage.loadPluginListCache = vi.fn(async () => null);
		const m = await opts.officialNames();
		expect(m.size).toBe(0);
	});

	it("loadPluginListCache 抛错 → catch 返回空 Map（不阻断足迹视图）", async () => {
		const { plugin, registerViewCalls } = makeAppAndPlugin();
		await plugin.onload();
		const journalFactory = registerViewCalls.find((c) => c.type === JOURNAL_VIEW_TYPE)!.factory;
		journalFactory({});
		const opts = journalOpts[0] as { officialNames: () => Promise<Map<string, string>> };
		(plugin as AnyPlugin).storage.loadPluginListCache = vi.fn(async () => {
			throw new Error("ENOSPC");
		});
		const m = await opts.officialNames();
		expect(m.size).toBe(0);
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的 initDeferredLoad 后台加载 catch 群（1012-1030），共 5 个 .catch 分支：
 * loadReleaseDates / loadChineseEcosystem / loadPluginDeps / loadBambooSeries / loadYulinPicks
 * 后台加载失败时各自 catch 记录、不中断启动。错误模式「某维度后台清单加载失败（网络/IO）时控制台报红且
 * 拖垮整条延迟初始化」。这些是启动韧性路径，既有测试从没让这些 loader 失败过。
 *
 * 手法：复用 onload 桩跑通 onload（onload 会把 initDeferredLoad 绑定为真实实现）；之后把所有被 initDeferredLoad
 * 调用的依赖（scheduleLocalEmbeddingWarmup / autoMigrateTMIfNeeded / scanVaultTM / translator / storage /
 * ensureVectorIndexLoaded / _resolveTmApprovedReady 等）经 Object.assign 桩成成功路径，唯独把 5 个后台 loader
 * 桩成拒绝；直接调用 initDeferredLoad() 并冲刷微任务，覆盖 5 个 catch（1012-1030）。本轮绝不碰已有测试文件。
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
		// initDeferredLoad 依赖的成功路径桩（5 个后台 loader 在测试里改拒绝）
		scheduleLocalEmbeddingWarmup: vi.fn(),
		autoMigrateTMIfNeeded: vi.fn(async () => {}),
		scanVaultTM: vi.fn(async () => {}),
		translator: { cache: {}, tmApproved: {} },
		storage: {
			loadInstallHistory: vi.fn(async () => ({ version: 1, entries: {} })),
			loadStatsCache: vi.fn(async () => null),
			loadTrendingHistory: vi.fn(async () => null),
		},
		ensureVectorIndexLoaded: vi.fn(async () => {}),
		_resolveTmApprovedReady: vi.fn(),
		refreshJournalStats: vi.fn(),
	});
	return { plugin, app, layoutReadyCbs, unloadFns, registerViewCalls, addCommandCalls };
}

beforeEach(() => {
	vi.clearAllMocks();
	loggerMock.warn.mockClear();
});

describe("initDeferredLoad 后台加载 catch 群（1012-1030）", () => {
	it("5 个后台 loader 全部失败 → 各自 catch 记录、不中断启动", async () => {
		const { plugin } = makeAppAndPlugin();
		await plugin.onload();
		// onload 期间 backfillInstallHistory 等可能已产生 warn；清零只统计本次 initDeferredLoad 的 catch
		loggerMock.warn.mockClear();
		// onload 不会把 initDeferredLoad 绑成真实实现；用类原型拿到真实方法，并把所有被它调用的
		// 依赖重新桩成成功路径（避免 onload 装上的真实 storage/translator 触发真实 IO），
		// 唯独把 5 个后台 loader 桩成拒绝以走 .catch。
		Object.assign(plugin, {
			storage: {
				loadInstallHistory: vi.fn(async () => ({ version: 1, entries: {} })),
				loadStatsCache: vi.fn(async () => null),
				loadTrendingHistory: vi.fn(async () => null),
			},
			translator: { cache: {}, tmApproved: {} },
			scheduleLocalEmbeddingWarmup: vi.fn(),
			autoMigrateTMIfNeeded: vi.fn(async () => {}),
			scanVaultTM: vi.fn(async () => {}),
			ensureVectorIndexLoaded: vi.fn(async () => {}),
			_resolveTmApprovedReady: vi.fn(),
			refreshOpenViews: vi.fn(),
			refreshJournalStats: vi.fn(),
			loadReleaseDates: vi.fn(async () => {
				throw new Error("net");
			}),
			loadChineseEcosystem: vi.fn(async () => {
				throw new Error("net");
			}),
			loadPluginDeps: vi.fn(async () => {
				throw new Error("net");
			}),
			loadBambooSeries: vi.fn(async () => {
				throw new Error("net");
			}),
			loadYulinPicks: vi.fn(async () => {
				throw new Error("net");
			}),
		});
		// 主动触发延迟初始化（onload 仅注册到 onLayoutReady，并不立即执行）
		await (ChinesePluginMarketPlugin.prototype as unknown as Record<string, any>).initDeferredLoad.call(plugin);
		// 5 个失败的 loader 各自走 .catch（微任务），冲刷后再断言
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		expect(loggerMock.warn).toHaveBeenCalledTimes(5);
	});
});

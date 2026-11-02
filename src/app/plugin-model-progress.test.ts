import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的「本地模型下载进度上报闭包」setModelProgressReporter（524-536）。
 *
 * 该闭包在 onload 里经模块级 setModelProgressReporter(cb) 注册，只有 cb 被 worker 调用时才会
 * 写入 this.localModelState。既有测试把 worker 模块当真实导入、从没捕获过这个 cb，闭包体零覆盖。
 * 错误模式是「本地语义搜索/设置页预建时，进度条永远停在初始态、百分比不更新」。
 *
 * 手法：把 @semantic/workers/worker-backend 的 setModelProgressReporter 换成 vi.fn 捕获 cb，
 * onload 跑通后手动调 cb 覆盖 downloading/ready/error 三态。
 */

const workerBackend = vi.hoisted(() => ({ setModelProgressReporter: vi.fn() }));
vi.mock("@semantic/workers/worker-backend", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	setModelProgressReporter: workerBackend.setModelProgressReporter,
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

beforeEach(() => {
	vi.clearAllMocks();
	workerBackend.setModelProgressReporter.mockClear();
	vi.useFakeTimers(); // armTmApprovedSafetyValve 内有 30s setTimeout
});
afterEach(() => {
	vi.useRealTimers();
});

describe("setModelProgressReporter 闭包：本地模型下载进度上报（524-536）", () => {
	it("onload 向 worker 后端注册了一个进度回调", async () => {
		const { plugin } = makeAppAndPlugin();
		await plugin.onload();
		expect(workerBackend.setModelProgressReporter).toHaveBeenCalledTimes(1);
		const cb = workerBackend.setModelProgressReporter.mock.calls[0][0];
		expect(typeof cb).toBe("function");
	});

	it("downloading → localModelState 记录 loaded/total（缺省归零）", async () => {
		const { plugin } = makeAppAndPlugin();
		await plugin.onload();
		const cb = workerBackend.setModelProgressReporter.mock.calls[0][0] as (p: any) => void;
		cb({ status: "downloading", loaded: 3, total: 9 });
		expect((plugin as AnyPlugin).localModelState).toEqual({ status: "downloading", loaded: 3, total: 9 });
		// 缺省归零
		cb({ status: "downloading" });
		expect((plugin as AnyPlugin).localModelState).toEqual({ status: "downloading", loaded: 0, total: 0 });
	});

	it("ready → 标记完成", async () => {
		const { plugin } = makeAppAndPlugin();
		await plugin.onload();
		const cb = workerBackend.setModelProgressReporter.mock.calls[0][0] as (p: any) => void;
		cb({ status: "ready" });
		expect((plugin as AnyPlugin).localModelState).toEqual({ status: "ready", loaded: 0, total: 0 });
	});

	it("error → 记录错误信息", async () => {
		const { plugin } = makeAppAndPlugin();
		await plugin.onload();
		const cb = workerBackend.setModelProgressReporter.mock.calls[0][0] as (p: any) => void;
		cb({ status: "error", error: "NOMEM" });
		expect((plugin as AnyPlugin).localModelState).toEqual({ status: "error", loaded: 0, total: 0, error: "NOMEM" });
	});
});

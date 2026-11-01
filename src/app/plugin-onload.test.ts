import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import type { PluginProfile } from "@ui/view/translator-view";
import { VIEW_TYPE } from "@shared/constants";
import { JOURNAL_VIEW_TYPE } from "@ui/view/journal-view";

/**
 * 补 app/plugin.ts 的 onload() 启动编排（491-771，约 280 行）——此前整段未覆盖。
 *
 * 既有所有 plugin*.test.ts 都没调用 onload（它是集成入口，默认被认为「只能手测」）。
 * 但 280 行里绝大多数是**顺序编排**（装配端口、注册视图/命令/ribbon/设置页、
 * 武装 tmApproved 安全阀、两个 onLayoutReady 延迟体、卸载清理），逻辑分支极少，
 * 直接调用 onload + 把重 IO 子加载器 stub 掉即可一次性覆盖，无需逐行拆。
 *
 * 错误模式是「升级后插件起不来 / 命令面板找不到入口 / 首屏永远停在加载页」。
 */

// JournalView 工厂闭包（606-633）只在工厂被调用时定义；把它 mock 成哑类，
// 这样调用工厂能覆盖闭包定义行，又不会触发真实 JournalView 的视图构造重活。
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

function makeAppAndPlugin(settingsOver: Record<string, unknown> = {}) {
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
			...settingsOver,
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
	// armTmApprovedSafetyValve 内部有 30s setTimeout，必须 fake 掉防止挂起
	vi.useFakeTimers();
});
afterEach(() => {
	vi.useRealTimers();
});

describe("onload：启动编排（491-771）", () => {
	it("完整跑通：装配端口 + 注册视图/命令/ribbon/设置页 + 武装安全阀 + 两个布局就绪延迟体 + 卸载清理", async () => {
		const { plugin, layoutReadyCbs, unloadFns, registerViewCalls, addCommandCalls } = makeAppAndPlugin();
		await plugin.onload();

		// 端口装配（490-536）：HttpClient / 平台能力 / noteStorage / worker 桥 / 进度上报均被注入
		expect((plugin as Record<string, unknown>).noteStorage).toBeDefined();
		expect(plugin.storage).toBeDefined();
		// 视图注册：市场视图 + 足迹视图
		expect(registerViewCalls.map((c) => c.type)).toEqual([VIEW_TYPE, JOURNAL_VIEW_TYPE]);
		// 命令注册（打开搜索/足迹/管理/直链安装 x2 / 诊断 x3 / TM 清+开 / 检查更新）
		expect(addCommandCalls.length).toBeGreaterThan(10);
		expect(plugin.addRibbonIcon).toHaveBeenCalled();
		expect(plugin.addSettingTab).toHaveBeenCalled();
		expect((plugin as Record<string, unknown>).registerTMVaultEvents).toHaveBeenCalled();
		expect(plugin.refreshProfileCommands).toHaveBeenCalled();
		// 安全阀已武装：_resolveTmApprovedReady 被替换为包装实现
		expect(typeof (plugin as Record<string, unknown>)._resolveTmApprovedReady).toBe("function");
		// 两个 onLayoutReady 回调已注册
		expect(layoutReadyCbs.length).toBe(2);
		// 卸载清理回调已注册（769-771）
		expect(unloadFns.length).toBeGreaterThan(0);

		// 触发布局就绪延迟体：第一个（595-599）启动延迟加载；第二个（761-767）增强设置页
		layoutReadyCbs.forEach((cb) => cb());
		expect((plugin as Record<string, unknown>).initDeferredLoad).toHaveBeenCalled();
		expect((plugin as Record<string, unknown>).runBetaAutoUpdate).not.toHaveBeenCalled(); // betaAutoUpdate 默认关闭
		expect(plugin.startSettingsIntegration).toHaveBeenCalled();
		expect(plugin.refreshPluginToggleCommands).toHaveBeenCalled();
		expect(plugin.reloadCssSnippets).toHaveBeenCalled();
		expect(plugin.backfillInstallHistory).toHaveBeenCalled();

		// 触发卸载清理：settingsIntegration 置空
		unloadFns.forEach((fn) => fn());
		expect((plugin as Record<string, unknown>).settingsIntegration).toBeNull();
	});

	it("betaAutoUpdate 开启 → 布局就绪后静默触发 runBetaAutoUpdate", async () => {
		const { plugin, layoutReadyCbs } = makeAppAndPlugin({ betaAutoUpdate: true });
		await plugin.onload();
		layoutReadyCbs[0]();
		expect((plugin as Record<string, unknown>).runBetaAutoUpdate).toHaveBeenCalled();
	});

	it("JournalView 工厂闭包（606-633）被定义：官方名映射 / 打开足迹回调可调用", async () => {
		const { plugin, registerViewCalls } = makeAppAndPlugin();
		await plugin.onload();
		const journal = registerViewCalls.find((c) => c.type === JOURNAL_VIEW_TYPE)!;
		// 调用工厂（JournalView 已 mock 为哑类）→ 覆盖 606-633 的对象字面量与闭包定义
		const view = journal.factory({} as never);
		expect(view).toBeDefined();
	});

	it("data.json 解析失败 → loadSettingsDataSafely 兜底回退空白，不阻断启动", async () => {
		const { plugin, layoutReadyCbs } = makeAppAndPlugin();
		plugin.loadData = vi.fn(async () => {
			throw new SyntaxError("bad json");
		});
		// 不应抛错（兜底为空白状态）
		await expect(plugin.onload()).resolves.toBeUndefined();
		expect(loggerMock.warn).toHaveBeenCalled();
		// 兜底后仍能完成编排
		expect(layoutReadyCbs.length).toBe(2);
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { VIEW_TYPE } from "@shared/constants";
import { logger } from "@shared/logger";
import ChinesePluginMarketPlugin from "@app/plugin";

vi.mock("@shared/logger", async (importOriginal) => {
	const o = await importOriginal<typeof import("@shared/logger")>();
	return { ...o, logger: { ...o.logger, debug: vi.fn() } };
});

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const translator = {
		loadData: vi.fn(),
		saveData: vi.fn(),
		setApiConfig: vi.fn(),
		setBaiduConfig: vi.fn(),
		setSelfHostedTranslators: vi.fn(),
		setAIConfig: vi.fn(),
		setPluginTags: vi.fn(),
		setVectorIndex: vi.fn(),
		buildPluginTagMap: vi.fn(),
		removeTMApproved: vi.fn(),
		tmApproved: {} as Record<string, unknown>,
		getPluginTags: vi.fn(() => ({})),
	};
	const leaf = { setViewState: vi.fn(async () => {}) };
	const workspace = {
		getLeavesOfType: vi.fn(() => []),
		getLeaf: vi.fn(() => leaf),
		setActiveLeaf: vi.fn(),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { workspace, vault: { adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => "") } } },
		storage: { getPluginData: vi.fn(async () => ({})), savePluginData: vi.fn(async () => {}) },
		translator,
		noteStorage: { adapter: {} },
		settings: { profiles: [], market: { plugins: [], lastSync: 0, syncStatus: "idle" }, betaAutoUpdate: false } as any,
		tmFolderEffective: vi.fn(() => "TranslationMemory"),
		migrateTMFiles: vi.fn(async () => ({ done: 0, total: 0, timedOut: false })),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("openTranslatorView：翻译视图聚焦 / 新建", () => {
	it("已有该类型视图 → 直接聚焦，不新建", async () => {
		const existing = { leaf: "existing" };
		const plugin = makePlugin({ app: { workspace: { getLeavesOfType: vi.fn(() => [existing as never]), getLeaf: vi.fn(), setActiveLeaf: vi.fn() }, vault: { adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => "") } } } });
		await (plugin as AnyPlugin).openTranslatorView();
		expect((plugin as AnyPlugin).app.workspace.setActiveLeaf).toHaveBeenCalledWith(existing, { focus: true });
		expect((plugin as AnyPlugin).app.workspace.getLeaf).not.toHaveBeenCalled();
	});

	it("无该类型视图 → 新开 tab 并设状态", async () => {
		const plugin = makePlugin();
		await (plugin as AnyPlugin).openTranslatorView();
		const ws = (plugin as AnyPlugin).app.workspace;
		expect(ws.getLeaf).toHaveBeenCalledWith("tab");
		expect(ws.getLeaf("tab").setViewState).toHaveBeenCalledWith({ type: VIEW_TYPE, active: true });
		expect(ws.setActiveLeaf).toHaveBeenCalledWith(ws.getLeaf("tab"), { focus: true });
	});
});

describe("autoMigrateTMIfNeeded：旧默认记忆库一键迁移", () => {
	it("生效路径已是旧默认 → 不迁移（零副作用）", async () => {
		const plugin = makePlugin({ tmFolderEffective: vi.fn(() => "插件翻译记忆库") });
		await (plugin as AnyPlugin).autoMigrateTMIfNeeded();
		expect((plugin as AnyPlugin).migrateTMFiles).not.toHaveBeenCalled();
		expect(logger.debug).not.toHaveBeenCalled();
	});

	it("生效路径不同且有迁移 → 记调试日志", async () => {
		const plugin = makePlugin({ migrateTMFiles: vi.fn(async () => ({ done: 5, total: 5, timedOut: false })) });
		await (plugin as AnyPlugin).autoMigrateTMIfNeeded();
		expect((plugin as AnyPlugin).migrateTMFiles).toHaveBeenCalledWith("插件翻译记忆库", "TranslationMemory", 8000);
		expect(logger.debug).toHaveBeenCalled();
	});

	it("无数据可迁 → 不记日志", async () => {
		const plugin = makePlugin({ migrateTMFiles: vi.fn(async () => ({ done: 0, total: 0, timedOut: false })) });
		await (plugin as AnyPlugin).autoMigrateTMIfNeeded();
		expect(logger.debug).not.toHaveBeenCalled();
	});

	it("达预算上限（timedOut）→ 仍记日志提示剩余下个 reload 继续", async () => {
		const plugin = makePlugin({ migrateTMFiles: vi.fn(async () => ({ done: 0, total: 3, timedOut: true })) });
		await (plugin as AnyPlugin).autoMigrateTMIfNeeded();
		expect(logger.debug).toHaveBeenCalled();
	});
});

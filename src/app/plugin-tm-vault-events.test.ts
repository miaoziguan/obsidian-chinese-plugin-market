import { describe, it, expect, vi, beforeEach } from "vitest";
import { TFile } from "obsidian";
import ChinesePluginMarketPlugin from "@app/plugin";

type AnyPlugin = Record<string, any>;

function makeTranslator() {
	return {
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
}

function makePlugin(extra: Record<string, any> = {}) {
	const translator = makeTranslator();
	const handlers: Record<string, (file: unknown) => void> = {};
	const vault = {
		configDir: ".obsidian",
		adapter: { exists: vi.fn(async () => false), read: vi.fn(async () => "") },
		// 抓取 vault.on 注册的 create/delete 回调，便于直接触发 handler body
		on: vi.fn((type: string, cb: (file: unknown) => void) => {
			handlers[type] = cb;
			return {} as never;
		}),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { vault, workspace: { getLeavesOfType: vi.fn(() => []) }, metadataCache: {} },
		storage: { getPluginData: vi.fn(async () => ({})), savePluginData: vi.fn(async () => {}) },
		translator,
		noteStorage: { adapter: {} },
		settings: { profiles: [], market: { plugins: [], lastSync: 0, syncStatus: "idle" }, betaAutoUpdate: false } as any,
		// 仅验证编排：registerEvent 是 Plugin 基类能力，mock 里没有，桩掉
		registerEvent: vi.fn(),
		tmFolderEffective: vi.fn(() => "TranslationMemory"),
		resolveTMFileIntoIndex: vi.fn(async () => {}),
		_lastTMIdsByPath: {} as Record<string, string>,
		...extra,
	});
	(plugin as AnyPlugin)._handlers = handlers;
	return plugin;
}

function tmFile(path: string): TFile {
	const f = new TFile();
	(f as unknown as { path: string }).path = path;
	return f;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("registerTMVaultEvents：vault 事件实时发现/清理 TM 笔记", () => {
	it("TM 目录等于配置目录 → 不注册事件（靠启动全扫覆盖）", () => {
		const plugin = makePlugin({ tmFolderEffective: vi.fn(() => ".obsidian") });
		(plugin as AnyPlugin).registerTMVaultEvents();
		expect((plugin as AnyPlugin).app.vault.on).not.toHaveBeenCalled();
	});

	it("注册 create / delete 两个 handler", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).registerTMVaultEvents();
		const h = (plugin as AnyPlugin)._handlers;
		expect(h.create).toBeTypeOf("function");
		expect(h.delete).toBeTypeOf("function");
		expect((plugin as AnyPlugin).registerEvent).toHaveBeenCalledTimes(2);
	});

	describe("create handler", () => {
		it("非 TFile（如文件夹）→ 忽略", () => {
			const plugin = makePlugin();
			(plugin as AnyPlugin).registerTMVaultEvents();
			const h = (plugin as AnyPlugin)._handlers;
			h.create!({ path: "TranslationMemory/foo.md" });
			expect((plugin as AnyPlugin).resolveTMFileIntoIndex).not.toHaveBeenCalled();
		});

		it("非 TM 目录下的文件 → 忽略", () => {
			const plugin = makePlugin();
			(plugin as AnyPlugin).registerTMVaultEvents();
			const h = (plugin as AnyPlugin)._handlers;
			h.create!(tmFile("other/bar.md"));
			expect((plugin as AnyPlugin).resolveTMFileIntoIndex).not.toHaveBeenCalled();
		});

		it("TM 目录下但非 .md → 忽略（不读 frontmatter）", () => {
			const plugin = makePlugin();
			(plugin as AnyPlugin).registerTMVaultEvents();
			const h = (plugin as AnyPlugin)._handlers;
			h.create!(tmFile("TranslationMemory/foo.txt"));
			expect((plugin as AnyPlugin).resolveTMFileIntoIndex).not.toHaveBeenCalled();
		});

		it("TM 目录下的 .md → 触发索引重建", () => {
			const plugin = makePlugin();
			(plugin as AnyPlugin).registerTMVaultEvents();
			const h = (plugin as AnyPlugin)._handlers;
			h.create!(tmFile("TranslationMemory/foo.md"));
			expect((plugin as AnyPlugin).resolveTMFileIntoIndex).toHaveBeenCalledWith("TranslationMemory/foo.md");
		});
	});

	describe("delete handler", () => {
		it("删除的正是已记录 path → 从 tmApproved 与路径索引移除", () => {
			const plugin = makePlugin({
				translator: {
					...makeTranslator(),
					tmApproved: { idX: { name: "X" } },
				},
				_lastTMIdsByPath: { "TranslationMemory/foo.md": "idX" },
			});
			(plugin as AnyPlugin).registerTMVaultEvents();
			const h = (plugin as AnyPlugin)._handlers;
			h.delete!(tmFile("TranslationMemory/foo.md"));
			expect(plugin.translator.tmApproved.idX).toBeUndefined();
			expect((plugin as AnyPlugin)._lastTMIdsByPath["TranslationMemory/foo.md"]).toBeUndefined();
		});

		it("删除未知 path → 不报错、不动索引", () => {
			const plugin = makePlugin({
				translator: { ...makeTranslator(), tmApproved: { idY: { name: "Y" } } },
				_lastTMIdsByPath: {},
			});
			(plugin as AnyPlugin).registerTMVaultEvents();
			const h = (plugin as AnyPlugin)._handlers;
			expect(() => h.delete!(tmFile("TranslationMemory/other.md"))).not.toThrow();
			expect(plugin.translator.tmApproved.idY).toBeDefined();
		});
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import { Notice } from "obsidian";
import { parseJournalNote } from "@domain/journal/journal-entry";
import { SettingsTranslator } from "@translation/settings/settings-translator";
import { logger } from "@shared/logger";
import ChinesePluginMarketPlugin from "@app/plugin";

vi.mock("obsidian", async (importOriginal) => {
	const orig = await importOriginal<typeof import("obsidian")>();
	return { ...orig, Notice: vi.fn() };
});

vi.mock("@shared/logger", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@shared/logger")>();
	return { ...orig, logger: { warn: vi.fn(), error: vi.fn(), debug: vi.fn(), info: vi.fn() } };
});

vi.mock("@domain/journal/journal-entry", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@domain/journal/journal-entry")>();
	return { ...orig, parseJournalNote: vi.fn() };
});

vi.mock("@translation/settings/settings-translator", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@translation/settings/settings-translator")>();
	return { ...orig, SettingsTranslator: vi.fn() };
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
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { openWithDefaultApp: vi.fn() },
		storage: { getPluginData: vi.fn(async () => ({})), savePluginData: vi.fn(async () => {}) },
		translator,
		noteStorage: { exists: vi.fn(async () => false), readNote: vi.fn(async () => "") },
		journalFolder: vi.fn(() => "Journal"),
		tmFolderEffective: vi.fn(() => "TranslationMemory"),
		settings: {
			profiles: [],
			translateSettingsEnabled: true,
			translateSettingsProvider: "youdao",
			translateSettingsBlacklist: "foo, bar ,",
			market: { plugins: [], lastSync: 0, syncStatus: "idle" },
			betaAutoUpdate: false,
		} as any,
		settingsTranslator: null as unknown,
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("loadJournalEntry：读取评测笔记（253-262）", () => {
	it("笔记不存在 → null（不读内容）", async () => {
		const plugin = makePlugin({ noteStorage: { exists: vi.fn(async () => false), readNote: vi.fn() } });
		const r = await (plugin as AnyPlugin).loadJournalEntry("id1");
		expect(r).toBeNull();
		expect((plugin as AnyPlugin).noteStorage.readNote).not.toHaveBeenCalled();
	});

	it("笔记存在且解析成功 → 返回解析结果", async () => {
		(parseJournalNote as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ id: "id1", rating: 5 });
		const plugin = makePlugin({ noteStorage: { exists: vi.fn(async () => true), readNote: vi.fn(async () => "# note") } });
		const r = await (plugin as AnyPlugin).loadJournalEntry("id1");
		expect(r).toEqual({ id: "id1", rating: 5 });
		expect(parseJournalNote).toHaveBeenCalledWith("# note");
	});

	it("读取抛错 → catch 记日志返回 null（不影响抽屉打开）", async () => {
		const plugin = makePlugin({
			noteStorage: { exists: vi.fn(async () => true), readNote: vi.fn(async () => { throw new Error("EIO"); }) },
		});
		const r = await (plugin as AnyPlugin).loadJournalEntry("id1");
		expect(r).toBeNull();
		expect(logger.warn).toHaveBeenCalled();
	});
});

describe("ensureSettingsTranslator：懒创建设置页翻译器（1053-1063）", () => {
	it("已存在 → 直接返回，不再 new", () => {
		const plugin = makePlugin({ settingsTranslator: { already: true } });
		(plugin as AnyPlugin).ensureSettingsTranslator();
		expect(SettingsTranslator).not.toHaveBeenCalled();
	});

	it("不存在 → 创建并缓存，配置回调读取 settings", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).ensureSettingsTranslator();
		expect(SettingsTranslator).toHaveBeenCalledTimes(1);
		const [appArg, trArg, getCfg] = (SettingsTranslator as unknown as ReturnType<typeof vi.fn>).mock.calls[0];
		expect(appArg).toBe((plugin as AnyPlugin).app);
		expect(trArg).toBe((plugin as AnyPlugin).translator);
		expect((plugin as AnyPlugin).settingsTranslator).toBeTruthy();
		// 触发配置回调，验证它读的是 settings 字段
		const cfg = getCfg();
		expect(cfg).toEqual({
			enabled: true,
			provider: "youdao",
			blacklist: ["foo", "bar"],
		});
	});
});

describe("openTMFolder：用系统文件管理器打开记忆库（920-928）", () => {
	it("openWithDefaultApp 成功 → 不弹通知", async () => {
		const plugin = makePlugin({ app: { openWithDefaultApp: vi.fn() } });
		await (plugin as AnyPlugin).openTMFolder();
		expect(Notice).not.toHaveBeenCalled();
	});

	it("openWithDefaultApp 抛错 → 弹失败通知", async () => {
		const plugin = makePlugin({ app: { openWithDefaultApp: vi.fn(() => { throw new Error("unsupported"); }) } });
		await (plugin as AnyPlugin).openTMFolder();
		expect(Notice).toHaveBeenCalledTimes(1);
	});
});

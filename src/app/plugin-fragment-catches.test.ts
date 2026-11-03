import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 三处 1-2 行碎片兜底分支——此前各自孤立、没被任何测试触发：
 *  - getDefaultTMFolder（822-823）：公开只读 getter，直接调用即可覆盖 return 行
 *  - openCommunityPluginsSettings（1900-1901）：原生设置页打开失败时 catch 记日志兜底
 *  - saveJournalEntry（285-286）：清空评测后删除残留 .md 失败时的 catch 兜底
 *
 * 错误模式：「设置面板读不到 TM 默认落点」「原生设置页打不开时控制台报红且静默失败」
 * 「清空评测时日志里无谓的删除异常」。手法：相关依赖经 Object.assign 打桩（deleteNote/openTabById
 * 抛错以覆盖 catch）；私人方法经 AnyPlugin 转型访问。本文件自包含，无需 onload。本轮绝不碰已有测试文件。
 */

const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", () => ({ logger: loggerMock }));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { vault: { configDir: ".obsidian" }, workspace: { getLeavesOfType: vi.fn(() => []) } },
		journalEntryIds: new Set<string>(),
		journalAbandonedIds: new Set<string>(),
		journalFolder: vi.fn(() => "jdir"),
		refreshJournalStats: vi.fn(),
		noteStorage: {
			exists: vi.fn(async () => true),
			deleteNote: vi.fn(async () => undefined),
			createFolder: vi.fn(async () => undefined),
			writeNote: vi.fn(async () => undefined),
		},
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	loggerMock.warn.mockClear();
});

describe("app/plugin.ts 三处碎片兜底（285-286 / 822-823 / 1900-1901）", () => {
	it("getDefaultTMFolder → 返回默认 TM 目录（覆盖 823）", () => {
		const plugin = makePlugin();
		const folder = (plugin as AnyPlugin).getDefaultTMFolder();
		expect(folder).toBe(".obsidian/plugins/chinese-plugin-market/tm");
	});

	it("openCommunityPluginsSettings：openTabById 抛错 → catch 记日志不抛出（覆盖 1900-1901）", () => {
		const plugin = makePlugin({
			app: {
				setting: { open: vi.fn(), openTabById: vi.fn(() => { throw new Error("boom"); }) },
			},
		});
		expect(() => (plugin as AnyPlugin).openCommunityPluginsSettings()).not.toThrow();
		expect(loggerMock.warn).toHaveBeenCalled();
	});

	it("saveJournalEntry：清空评测后删除残留 .md 失败 → catch 不抛出（覆盖 285-286）", async () => {
		const plugin = makePlugin({
			noteStorage: {
				exists: vi.fn(async () => true),
				deleteNote: vi.fn(async () => {
					throw new Error("disk");
				}),
				createFolder: vi.fn(async () => undefined),
				writeNote: vi.fn(async () => undefined),
			},
		});
		const entry = { id: "p-no-content", status: undefined, rating: undefined, verdict: "" as string, note: "" };
		await expect((plugin as AnyPlugin).saveJournalEntry(entry)).resolves.toBeUndefined();
		// 即使删除失败，仍完成集合维护与视图刷新（不中断）
		expect((plugin as AnyPlugin).journalEntryIds.has("p-no-content")).toBe(false);
		expect(loggerMock.warn).toHaveBeenCalledTimes(0); // 删除失败被静默忽略
	});
});

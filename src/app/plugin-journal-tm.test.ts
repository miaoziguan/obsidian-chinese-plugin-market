import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { renderJournalNote, type JournalEntry } from "@domain/journal/journal-entry";
import { ChinesePluginMarketView } from "@ui/view/translator-view";
import type { TMEntry } from "@translation/memory/translation-memory";

/**
 * 评测笔记（journal）与翻译记忆（TM）的落盘路径。
 *
 * 共同点：都通过 noteStorage 端口读写笔记，都遵循「先写后删 / 失败保留待重试」
 * 的防丢数据原则。这里锁定三件事：
 *   1. 清空评测要删掉残留笔记（否则「取消评测」形同虚设）
 *   2. 写盘失败绝不能清脏标记（否则人工校正会静默丢失）
 *   3. 批量迁移单条失败不中断整体，且预算到点能优雅中止
 */
const tmMock = vi.hoisted(() => ({
	writeTMNote: vi.fn(async (_storage: unknown, _entry: unknown, _folder: string) => {}),
	removeTMNote: vi.fn(async (_storage: unknown, _id: string, _folder: string) => {}),
	parseTMNote: vi.fn(() => ({ id: "tm-1", source: "s", target: "t" }) as unknown as TMEntry),
}));

vi.mock("@translation/memory/translation-memory", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@translation/memory/translation-memory")>();
	return {
		...actual,
		writeTMNote: tmMock.writeTMNote,
		removeTMNote: tmMock.removeTMNote,
		parseTMNote: tmMock.parseTMNote,
	};
});

type View = Record<string, unknown> & { refreshCardState: ReturnType<typeof vi.fn>; renderPluginList: ReturnType<typeof vi.fn> };

function makeView(): View {
	const view = Object.create(ChinesePluginMarketView.prototype) as unknown as View;
	view.refreshCardState = vi.fn();
	view.renderPluginList = vi.fn();
	return view;
}

function makePlugin(over: Record<string, unknown> = {}) {
	const noteStorage = {
		exists: vi.fn(async () => false),
		readNote: vi.fn(async (_path: string) => ""),
		writeNote: vi.fn(async () => {}),
		deleteNote: vi.fn(async () => {}),
		createFolder: vi.fn(async () => {}),
		listMarkdown: vi.fn(async () => [] as string[]),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	const refreshJournalStats = vi.fn(async () => {});
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market" },
		app: { workspace: { getLeavesOfType: () => [] as View[] } },
		settings: { reviewFolder: "" },
		noteStorage,
		translator: {
			peekTMDirty: vi.fn(() => [] as string[]),
			peekTMRemoved: vi.fn(() => [] as string[]),
			tmApproved: {} as Record<string, TMEntry>,
			clearTMDirty: vi.fn(),
			clearTMRemoved: vi.fn(),
		},
		tmFolderEffective: vi.fn(() => "tm-folder"),
		journalEntryIds: new Set<string>(),
		journalAbandonedIds: new Set<string>(),
		refreshJournalStats,
		...over,
	});
	return { plugin, noteStorage, refreshJournalStats };
}

const entry = (over: Partial<JournalEntry> = {}): JournalEntry => ({
	id: "p1",
	name: "插件一",
	note: "",
	...over,
});

beforeEach(() => {
	vi.clearAllMocks();
	tmMock.parseTMNote.mockReturnValue({ id: "tm-1", source: "s", target: "t" } as unknown as TMEntry);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("saveJournalEntry：清空评测 = 删除残留笔记", () => {
	it("无实质内容时不写盘，删除目录里可能残留的笔记", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(true);

		await plugin.saveJournalEntry(entry({ note: "   " }));

		expect(noteStorage.deleteNote).toHaveBeenCalled();
		expect(noteStorage.writeNote).not.toHaveBeenCalled();
	});

	it("无内容且笔记本就不存在时不调用删除（省一次 IO）", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(false);

		await plugin.saveJournalEntry(entry());

		expect(noteStorage.deleteNote).not.toHaveBeenCalled();
	});

	it("清空后从「已写评测」与「已弃用」集合中移除", async () => {
		const { plugin } = makePlugin();
		plugin.journalEntryIds = new Set(["p1"]);
		plugin.journalAbandonedIds = new Set(["p1"]);

		await plugin.saveJournalEntry(entry());

		expect(plugin.journalEntryIds.has("p1")).toBe(false);
		expect(plugin.journalAbandonedIds.has("p1")).toBe(false);
	});

	it("清空要让已打开卡片的评测高亮立刻消失", async () => {
		const view = makeView();
		const { plugin } = makePlugin({
			app: { workspace: { getLeavesOfType: () => [{ view }] } },
		});

		await plugin.saveJournalEntry(entry({ note: "" }));

		expect(view.refreshCardState).toHaveBeenCalledWith("p1");
	});

	it("清空路径同样触发全局统计重算", async () => {
		const { plugin, refreshJournalStats } = makePlugin();
		await plugin.saveJournalEntry(entry());
		expect(refreshJournalStats).toHaveBeenCalled();
	});
});

describe("saveJournalEntry：有内容则落盘", () => {
	it("目录不存在时先建目录再写笔记（adapter 不会自动建目录）", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(false);

		await plugin.saveJournalEntry(entry({ note: "踩坑了" }));

		expect(noteStorage.createFolder).toHaveBeenCalled();
		expect(noteStorage.writeNote).toHaveBeenCalledWith(expect.stringContaining("p1.md"), expect.any(String));
	});

	it("目录已存在时不重复建目录", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(true);

		await plugin.saveJournalEntry(entry({ note: "有内容" }));

		expect(noteStorage.createFolder).not.toHaveBeenCalled();
		expect(noteStorage.writeNote).toHaveBeenCalled();
	});

	it("写入的正文能被解析回原条目（render → parse 往返）", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(true);
		// 固定 updated：renderJournalNote 在缺省时会写 Date.now()，
		// 两次渲染跨毫秒就会让字符串比较偶发失败（曾在本机全量跑时复现）
		const e = entry({
			status: "abandoned",
			rating: 4,
			verdict: ["易冲突"],
			note: "正文备注",
			updated: 1700000000000,
		});

		await plugin.saveJournalEntry(e);

		const written = String((noteStorage.writeNote.mock.calls[0] as unknown[])[1]);
		expect(written).toContain("易冲突");
		expect(written).toContain("正文备注");
		expect(written).toBe(renderJournalNote(e));
	});

	it("状态为 abandoned 时加入已弃用集合", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(true);

		await plugin.saveJournalEntry(entry({ status: "abandoned", note: "弃" }));

		expect(plugin.journalAbandonedIds.has("p1")).toBe(true);
		expect(plugin.journalEntryIds.has("p1")).toBe(true);
	});

	it("状态改回非 abandoned 时从已弃用集合移除", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(true);
		plugin.journalAbandonedIds = new Set(["p1"]);

		await plugin.saveJournalEntry(entry({ status: "using", note: "好了" }));

		expect(plugin.journalAbandonedIds.has("p1")).toBe(false);
	});

	it("写盘失败时只记日志，且不把该条目标记为「已评测」", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.exists.mockResolvedValue(true);
		noteStorage.writeNote.mockRejectedValue(new Error("EACCES"));

		await expect(plugin.saveJournalEntry(entry({ note: "写不进去" }))).resolves.toBeUndefined();

		expect(plugin.journalEntryIds.has("p1")).toBe(false);
	});
});

describe("refreshJournalStats：扫描目录聚合统计", () => {
	/**
	 * makePlugin 为了隔离把 refreshJournalStats 桩成了空函数（saveJournalEntry 会
	 * fire-and-forget 调它）。本组要验证真实实现，故移除自有属性让调用回落到原型。
	 */
	const runRealStats = (plugin: ChinesePluginMarketPlugin) => {
		delete (plugin as unknown as Record<string, unknown>).refreshJournalStats;
		return (plugin as unknown as { refreshJournalStats(): Promise<void> }).refreshJournalStats();
	};
	it("聚合已写评测与被弃用集合，并重跑已打开视图的列表管线", async () => {
		const view = makeView();
		const { plugin, noteStorage } = makePlugin({
			app: { workspace: { getLeavesOfType: () => [{ view }] } },
		});
		noteStorage.listMarkdown.mockResolvedValue(["a/p1.md", "a/p2.md"]);
		noteStorage.readNote.mockImplementation(async (p: string) =>
			p.includes("p1")
				? renderJournalNote(entry({ id: "p1", status: "abandoned", note: "弃" }))
				: renderJournalNote(entry({ id: "p2", note: "还好" })),
		);

		await runRealStats(plugin);

		expect([...plugin.journalEntryIds].sort()).toEqual(["p1", "p2"]);
		expect(plugin.journalAbandonedIds.has("p1")).toBe(true);
		expect(plugin.journalAbandonedIds.has("p2")).toBe(false);
		expect(plugin.journalStats).not.toBeNull();
		expect(view.renderPluginList).toHaveBeenCalledWith(false);
	});

	it("无法解析的笔记被跳过（目录里用户随手放的 md 不能让卡片莫名高亮）", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.listMarkdown.mockResolvedValue(["a/broken.md", "a/p1.md"]);
		noteStorage.readNote.mockImplementation(async (p: string) =>
			p.includes("broken") ? "不是笔记" : renderJournalNote(entry({ id: "p1", note: "ok" })),
		);

		await runRealStats(plugin);

		expect([...plugin.journalEntryIds]).toEqual(["p1"]);
	});

	it("目录不存在或无笔记时静默降级，集合保持为空", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.listMarkdown.mockRejectedValue(new Error("ENOENT"));

		await expect(runRealStats(plugin)).resolves.toBeUndefined();

		expect(plugin.journalEntryIds.size).toBe(0);
		expect(plugin.journalStats).toBeNull();
	});
});

describe("flushTMVault：写成功才清脏标记", () => {
	const withTranslator = (over: Record<string, unknown> = {}) => {
		const made = makePlugin();
		Object.assign(made.plugin.translator, over);
		return made;
	};

	it("脏条目写盘成功后清除标记", async () => {
		const { plugin } = withTranslator({
			peekTMDirty: vi.fn(() => ["t1"]),
			tmApproved: { t1: { id: "t1", source: "s", target: "t" } },
		});

		await (plugin as unknown as { flushTMVault(): Promise<void> }).flushTMVault();

		expect(tmMock.writeTMNote).toHaveBeenCalled();
		expect(plugin.translator.clearTMDirty).toHaveBeenCalledWith("t1");
	});

	it("脏条目在索引里已消失时只清标记，不写盘", async () => {
		const { plugin } = withTranslator({
			peekTMDirty: vi.fn(() => ["gone"]),
			tmApproved: {},
		});

		await (plugin as unknown as { flushTMVault(): Promise<void> }).flushTMVault();

		expect(tmMock.writeTMNote).not.toHaveBeenCalled();
		expect(plugin.translator.clearTMDirty).toHaveBeenCalledWith("gone");
	});

	it("写盘失败时保留脏标记等待重试（否则人工校正会静默丢失）", async () => {
		const { plugin } = withTranslator({
			peekTMDirty: vi.fn(() => ["t1"]),
			tmApproved: { t1: { id: "t1", source: "s", target: "t" } },
		});
		tmMock.writeTMNote.mockRejectedValueOnce(new Error("EBUSY"));

		await (plugin as unknown as { flushTMVault(): Promise<void> }).flushTMVault();

		expect(plugin.translator.clearTMDirty).not.toHaveBeenCalled();
	});

	it("单条写失败不影响同批其他条目", async () => {
		const { plugin } = withTranslator({
			peekTMDirty: vi.fn(() => ["bad", "good"]),
			tmApproved: {
				bad: { id: "bad", source: "s", target: "t" },
				good: { id: "good", source: "s", target: "t" },
			},
		});
		tmMock.writeTMNote.mockImplementation(async (_s: unknown, e: unknown) => {
			if ((e as TMEntry).id === "bad") throw new Error("EBUSY");
		});

		await (plugin as unknown as { flushTMVault(): Promise<void> }).flushTMVault();

		expect(plugin.translator.clearTMDirty).toHaveBeenCalledWith("good");
		expect(plugin.translator.clearTMDirty).not.toHaveBeenCalledWith("bad");
	});

	it("待删除条目删除成功后清除标记", async () => {
		const { plugin } = withTranslator({ peekTMRemoved: vi.fn(() => ["r1"]) });

		await (plugin as unknown as { flushTMVault(): Promise<void> }).flushTMVault();

		expect(tmMock.removeTMNote).toHaveBeenCalled();
		expect(plugin.translator.clearTMRemoved).toHaveBeenCalledWith("r1");
	});

	it("删除失败时保留标记等待重试", async () => {
		const { plugin } = withTranslator({ peekTMRemoved: vi.fn(() => ["r1"]) });
		tmMock.removeTMNote.mockRejectedValueOnce(new Error("EBUSY"));

		await (plugin as unknown as { flushTMVault(): Promise<void> }).flushTMVault();

		expect(plugin.translator.clearTMRemoved).not.toHaveBeenCalled();
	});
});

describe("migrateTMFiles：批量迁移（先写后删、单条容错、预算中止）", () => {
	const migrate = (plugin: unknown, src: string, dst: string, budgetMs = 0) =>
		(
			plugin as {
				migrateTMFiles(s: string, d: string, b?: number): Promise<{
					done: number;
					total: number;
					timedOut: boolean;
				}>;
			}
		).migrateTMFiles(src, dst, budgetMs);

	it("源目录为空时直接返回零值（启动零副作用）", async () => {
		const { plugin } = makePlugin();
		await expect(migrate(plugin, "old", "new")).resolves.toEqual({ done: 0, total: 0, timedOut: false });
	});

	it("逐条执行「先写新位置、再删旧位置」", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.listMarkdown.mockResolvedValue(["old/a.md"]);

		const r = await migrate(plugin, "old", "new");

		expect(r).toEqual({ done: 1, total: 1, timedOut: false });
		expect(tmMock.writeTMNote).toHaveBeenCalledWith(expect.anything(), expect.anything(), "new");
		expect(tmMock.removeTMNote).toHaveBeenCalledWith(expect.anything(), "tm-1", "old");
	});

	it("解析不出 id 的笔记跳过，不影响其他条目", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.listMarkdown.mockResolvedValue(["old/a.md", "old/b.md"]);
		tmMock.parseTMNote.mockReturnValueOnce(null as never).mockReturnValueOnce({ id: "t2" } as never);

		const r = await migrate(plugin, "old", "new");

		expect(r.done).toBe(1);
		expect(r.total).toBe(2);
	});

	it("单条写失败不中断整体（一条坏笔记不该卡死启动链）", async () => {
		const { plugin, noteStorage } = makePlugin();
		noteStorage.listMarkdown.mockResolvedValue(["old/a.md", "old/b.md"]);
		tmMock.writeTMNote.mockRejectedValueOnce(new Error("EBUSY"));

		const r = await migrate(plugin, "old", "new");

		expect(r.done).toBe(1);
		expect(r.timedOut).toBe(false);
	});

	it("预算耗尽时优雅中止并标记 timedOut（剩余源文件保留，下次 reload 续迁）", async () => {
		const { plugin, noteStorage } = makePlugin();
		// 21 个文件 → 2 批（BATCH=20）
		noteStorage.listMarkdown.mockResolvedValue(
			Array.from({ length: 21 }, (_, i) => `old/${i}.md`),
		);
		let now = 1_000;
		vi.spyOn(Date, "now").mockImplementation(() => now);
		tmMock.writeTMNote.mockImplementation(async () => {
			now += 2_000; // 第一批就超出 1ms 预算
		});

		const r = await migrate(plugin, "old", "new", 1);

		expect(r.timedOut).toBe(true);
		expect(r.total).toBe(21);
		expect(r.done).toBe(20);
	});
});

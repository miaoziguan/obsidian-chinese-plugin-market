import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { ChinesePluginMarketView } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的 saveJournalEntry（269-321）的两个视图刷新循环（290-294 / 313-317）。
 * 既有 plugin*.test.ts 从没驱动这个方法，错误模式是「保存/清空评测后，已打开的搜索视图里
 * 那张卡片的评测高亮（金边/弃用灰）不刷新，要等下次全量重扫才变」。
 *
 * 手法：@ui/view/translator-view 的 ChinesePluginMarketView 换成可控 FakeView（instanceof 判定通过、
 * refreshCardState 可断言）；journalFolder/noteStorage/各集合/refreshJournalStats 经 Object.assign 打桩；
 * 私有方法经 AnyPlugin 转型访问。两条分支分别驱动以覆盖各自的 for-of 刷新循环。
 */

vi.mock("@ui/view/translator-view", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	ChinesePluginMarketView: class {
		refreshCardState = vi.fn();
	},
}));

type AnyPlugin = Record<string, any>;

function makePlugin(app: Record<string, any>, extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app,
		journalFolder: vi.fn(() => "Journal"),
		noteStorage: {
			exists: vi.fn(),
			deleteNote: vi.fn(async () => {}),
			createFolder: vi.fn(async () => {}),
			writeNote: vi.fn(async () => {}),
		},
		journalEntryIds: new Set<string>(),
		journalAbandonedIds: new Set<string>(),
		refreshJournalStats: vi.fn(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("saveJournalEntry：两条分支都刷新已打开视图的卡片（269-321）", () => {
	it("无实质内容 → 删除残留 .md 并刷新（覆盖 290-294）", async () => {
		const view = new ChinesePluginMarketView({} as never, {} as never);
		const plugin = makePlugin({
			workspace: { getLeavesOfType: vi.fn(() => [{ view }]) },
		});
		// exists 返回 true → 触发 deleteNote（覆盖 282-283），_refreshCardState 循环随之覆盖
		(plugin as AnyPlugin).noteStorage.exists = vi.fn(async () => true);

		await (plugin as AnyPlugin).saveJournalEntry({ id: "p1" });

		expect((plugin as AnyPlugin).noteStorage.deleteNote).toHaveBeenCalled();
		expect(view.refreshCardState).toHaveBeenCalledWith("p1");
		expect((plugin as AnyPlugin).refreshJournalStats).toHaveBeenCalled();
	});

	it("有实质内容 → 落盘并刷新（覆盖 299-318，含 313-317）", async () => {
		const view = new ChinesePluginMarketView({} as never, {} as never);
		const plugin = makePlugin({
			workspace: { getLeavesOfType: vi.fn(() => [{ view }]) },
		});
		// dir 不存在 → 触发 createFolder（覆盖 301-302）
		(plugin as AnyPlugin).noteStorage.exists = vi.fn(async () => false);

		await (plugin as AnyPlugin).saveJournalEntry({
			id: "p2",
			status: "abandoned",
			rating: 4,
			verdict: ["too-noisy"],
			note: "噪音大",
		});

		expect((plugin as AnyPlugin).noteStorage.writeNote).toHaveBeenCalled();
		// status=abandoned → 进 add 分支（覆盖 306）；journalEntryIds.add（311）
		expect((plugin as AnyPlugin).journalAbandonedIds.has("p2")).toBe(true);
		expect((plugin as AnyPlugin).journalEntryIds.has("p2")).toBe(true);
		expect(view.refreshCardState).toHaveBeenCalledWith("p2");
		expect((plugin as AnyPlugin).refreshJournalStats).toHaveBeenCalled();
	});
});

describe("评测未读状态", () => {
	it("查看后归零，新增/编辑立即未读，清空评测立即移除", async () => {
		const view = new ChinesePluginMarketView({} as never, {} as never);
		const refreshJournalBadge = vi.fn();
		Object.assign(view, { refreshJournalBadge });
		const saveSettings = vi.fn();
		const plugin = makePlugin({ workspace: { getLeavesOfType: () => [{ view }] } }, {
			settings: { journalSeenIds: [] }, saveSettings,
		});
		const internal = plugin as AnyPlugin;
		await plugin.saveJournalEntry({ id: "a", note: "A" } as never);
		expect(plugin.getJournalUnreadCount()).toBe(1);
		internal.markJournalRead(["a"]);
		expect(plugin.getJournalUnreadCount()).toBe(0);
		expect(internal.settings.journalSeenIds).toEqual(["a"]);
		await plugin.saveJournalEntry({ id: "b", note: "B" } as never);
		expect(plugin.getJournalUnreadCount()).toBe(1);
		await plugin.saveJournalEntry({ id: "a", note: "A edited" } as never);
		expect(plugin.getJournalUnreadCount()).toBe(2);
		await plugin.saveJournalEntry({ id: "b" } as never);
		expect(plugin.getJournalUnreadCount()).toBe(1);
		expect(refreshJournalBadge).toHaveBeenCalled();
		expect(saveSettings).toHaveBeenCalled();
	});

	it("旧设置无已读字段时兼容，重复查看不重复保存设置", () => {
		const saveSettings = vi.fn();
		const plugin = makePlugin({ workspace: { getLeavesOfType: () => [] } }, {
			settings: {}, saveSettings, journalEntryIds: new Set(["a"]),
		});
		expect(plugin.getJournalUnreadCount()).toBe(1);
		(plugin as AnyPlugin).markJournalRead(["a"]);
		(plugin as AnyPlugin).markJournalRead(["a"]);
		expect(saveSettings).toHaveBeenCalledTimes(1);
	});
});

it("后发扫描先完成时，旧扫描不会覆盖最新评测集合", async () => {
	const plugin = makePlugin({ workspace: { getLeavesOfType: () => [] } }, { settings: {} });
	const internal = plugin as AnyPlugin;
	const pending: Array<(files: string[]) => void> = [];
	internal.noteStorage.listMarkdown = () => new Promise(resolve => pending.push(resolve));
	internal.noteStorage.readNote = async (p: string) => `---\nid: ${p.slice(0, -3)}\nname: Test\nstatus: using\n---\n评测`;
	// 使用生产方法，而非 makePlugin 为既有保存测试提供的刷新 stub。
	const refresh = (Object.getPrototypeOf(plugin) as AnyPlugin).refreshJournalStats.bind(plugin);
	const first = refresh();
	const second = refresh();
	pending[1](["new.md"]);
	await second;
	const latest = plugin.journalEntryIds;
	expect([...latest]).toEqual(["new"]);
	pending[0]([]);
	await first;
	expect(plugin.journalEntryIds).toBe(latest);
});

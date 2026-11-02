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

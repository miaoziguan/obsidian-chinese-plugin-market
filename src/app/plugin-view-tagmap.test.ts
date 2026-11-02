import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { ChinesePluginMarketView } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 两个自包含的私有方法：
 * - buildPluginTagMap（478-483）：从 translator.getAllPluginTags 重建 id→分类 Map（跳过无 category 的）。
 * - refreshOpenViews（1043-1050）：遍历已打开的翻译市场视图，触发局部重渲染。
 * 既有 plugin*.test.ts 没直接驱动这两个私有方法，错误模式是「分类 Tab 不显示分类 /
 * 已打开的搜索视图在改动后不刷新」。
 */

// 用可控的 FakeView 替换真实视图类，使 instanceof 判定通过且 invalidateAndRender 可断言。
vi.mock("@ui/view/translator-view", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@ui/view/translator-view")>();
	class FakeView {
		invalidateAndRender = vi.fn();
	}
	return { ...orig, ChinesePluginMarketView: FakeView };
});

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const translator = {
		getAllPluginTags: vi.fn(() => ({}) as Record<string, { category?: string } | undefined>),
	};
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { workspace: { getLeavesOfType: vi.fn(() => []) } },
		translator,
		pluginTagMap: new Map<string, string>(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("buildPluginTagMap：重建 id→分类映射（478-483）", () => {
	it("有分类的标签写入 Map，无 category 的跳过", () => {
		const plugin = makePlugin({
			translator: { getAllPluginTags: vi.fn(() => ({ a: { category: "ai" }, b: {}, c: { category: "util" } })) },
		});
		(plugin as AnyPlugin).buildPluginTagMap();
		const m = (plugin as AnyPlugin).pluginTagMap as Map<string, string>;
		expect(m.get("a")).toBe("ai");
		expect(m.get("c")).toBe("util");
		expect(m.has("b")).toBe(false);
	});

	it("getAllPluginTags 为空 → 清空并留空", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).pluginTagMap.set("stale", "x");
		(plugin as AnyPlugin).buildPluginTagMap();
		expect((plugin as AnyPlugin).pluginTagMap.size).toBe(0);
	});
});

describe("refreshOpenViews：刷新已打开的翻译市场视图（1043-1050）", () => {
	it("市场视图实例 → 触发局部重渲染", () => {
		const view = new (ChinesePluginMarketView as unknown as { new (): { invalidateAndRender: ReturnType<typeof vi.fn> } })();
		const plugin = makePlugin({
			app: { workspace: { getLeavesOfType: vi.fn(() => [{ view }]) } },
		});
		(plugin as AnyPlugin).refreshOpenViews();
		expect(view.invalidateAndRender).toHaveBeenCalledWith(false);
	});

	it("非市场视图 → 不触发（避免误渲染别的视图）", () => {
		const other = { invalidateAndRender: vi.fn() };
		const plugin = makePlugin({
			app: { workspace: { getLeavesOfType: vi.fn(() => [{ view: other }]) } },
		});
		(plugin as AnyPlugin).refreshOpenViews();
		expect(other.invalidateAndRender).not.toHaveBeenCalled();
	});

	it("无打开视图 → 空转", () => {
		const plugin = makePlugin({ app: { workspace: { getLeavesOfType: vi.fn(() => []) } } });
		expect(() => (plugin as AnyPlugin).refreshOpenViews()).not.toThrow();
	});
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { ChinesePluginMarketView } from "@ui/view/translator-view";

/**
 * 补 app/plugin.ts 的 findMarketView（1285-1289）：取当前打开的市场视图供诊断命令复用。
 * 既有 plugin*.test.ts 没驱动这个方法，错误模式是「命令面板诊断类命令拿不到当前市场视图」。
 *
 * 手法：@ui/view/translator-view 的 ChinesePluginMarketView 换成可控 FakeView（instanceof 判定通过）。
 */

vi.mock("@ui/view/translator-view", async (importOriginal) => {
	const orig = await importOriginal<typeof import("@ui/view/translator-view")>();
	class FakeView {}
	return { ...orig, ChinesePluginMarketView: FakeView };
});

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { workspace: { getLeavesOfType: vi.fn(() => []) } },
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("findMarketView：取当前市场视图（1285-1289）", () => {
	it("有打开的市场视图 → 返回该视图", () => {
		const view = new (ChinesePluginMarketView as unknown as { new (): unknown })();
		const plugin = makePlugin({
			app: { workspace: { getLeavesOfType: vi.fn(() => [{ view }]) } },
		});
		expect((plugin as AnyPlugin).findMarketView()).toBe(view);
	});

	it("无打开视图 → null", () => {
		const plugin = makePlugin({ app: { workspace: { getLeavesOfType: vi.fn(() => []) } } });
		expect((plugin as AnyPlugin).findMarketView()).toBeNull();
	});

	it("打开的视图不是市场视图 → null", () => {
		const plugin = makePlugin({
			app: { workspace: { getLeavesOfType: vi.fn(() => [{ view: {} }]) } },
		});
		expect((plugin as AnyPlugin).findMarketView()).toBeNull();
	});
});

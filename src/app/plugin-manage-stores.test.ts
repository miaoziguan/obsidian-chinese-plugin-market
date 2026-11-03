import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 的两个分组/管理 store 工厂——createManageStore（1728-1759，private）与
 * createGroupManageStore（1558-1581）。既有测试只把它们的消费者（设置页集成、GroupManagementModal）
 * 当桩，从没真正调用过工厂产出的 saveMeta/replaceMeta/saveGroups/saveFilterState/installedIds 回调，
 * 错误模式是「设置页里改分组元信息、保存筛选状态后不落盘、已装插件列表取不到」。
 *
 * 手法：settings.manage 与 flushSaveSettings 经 Object.assign 打桩（避免真实写盘）；app 留空，
 * asAppInternals(app).plugins?.manifests 退化为 {}（installedIds 返回 []）；私人方法经 AnyPlugin 转型访问。
 * 本方法自包含，无需 onload。本轮绝不碰已有测试文件。
 */

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		settings: {
			manage: {
				pluginMeta: {},
				cssMeta: {},
				pluginGroups: [],
				cssGroups: [],
				pluginGroupColors: {},
				cssGroupColors: {},
				filterState: {},
			},
		},
		flushSaveSettings: vi.fn(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("分组/管理 store 工厂（1728-1581）", () => {
	it("createManageStore：整方法 + 各回调（覆盖 1734-1757 含 1743-1749）", () => {
		const plugin = makePlugin();
		const store = (plugin as AnyPlugin).createManageStore();
		expect(store.settings).toBe((plugin as AnyPlugin).settings.manage);
		store.saveMeta("id1", { foo: "bar" });
		expect((plugin as AnyPlugin).flushSaveSettings).toHaveBeenCalled();
		store.replaceMeta({ a: 1 });
		expect((plugin as AnyPlugin).settings.manage.pluginMeta).toEqual({ a: 1 });
		store.saveGroups([], {});
		store.saveFilterState({ x: 1 });
		expect(store.installedIds()).toEqual([]);
	});

	it("createGroupManageStore：saveMeta/replaceMeta 回调（覆盖 1572-1578）", () => {
		const plugin = makePlugin();
		const store = (plugin as AnyPlugin).createGroupManageStore("favorites");
		store.saveMeta("id2", { v: 1 });
		expect((plugin as AnyPlugin).flushSaveSettings).toHaveBeenCalled();
		store.replaceMeta({ b: 2 });
		expect((plugin as AnyPlugin).settings.manage.pluginMeta).toEqual({ b: 2 });
	});
});

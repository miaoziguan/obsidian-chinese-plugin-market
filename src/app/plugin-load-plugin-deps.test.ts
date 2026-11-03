import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { DepGraph } from "@domain/deps/graph";

/**
 * 补 app/plugin.ts 的 loadPluginDeps（2256-2271）：加载随插件分发的插件依赖数据集。
 * 既有 plugin*.test.ts 从没驱动这个方法——错误模式是「plugin-deps.json 存在却不生效、或解析
 * 失败/文件损坏时静默崩溃」。
 *
 * 手法：@domain/deps/graph 的 DepGraph 换成可控桩（静态 parse 经 vi.mock 替换）；app.vault.adapter
 * 的 exists/read 经 Object.assign 打桩；refreshOpenViews 经 Object.assign 打桩；私人方法/字段
 * 经 AnyPlugin 转型访问。本方法自包含，无需 onload。
 */

vi.mock("@domain/deps/graph", () => ({
	DepGraph: class {
		static parse = vi.fn();
	},
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { vault: { adapter: { exists: vi.fn(), read: vi.fn() } } },
		pluginDeps: null,
		refreshOpenViews: vi.fn(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("loadPluginDeps：加载插件依赖数据集（2256-2271）", () => {
	it("文件存在且解析成功 → 写入 pluginDeps 并刷新视图（覆盖 2262-2266）", async () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).app.vault.adapter.exists = vi.fn(async () => true);
		(plugin as AnyPlugin).app.vault.adapter.read = vi.fn(async () => '{"nodes":[]}');
		(DepGraph.parse as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue({ nodes: [] });

		await (plugin as AnyPlugin).loadPluginDeps();

		expect((plugin as AnyPlugin).pluginDeps).toEqual({ nodes: [] });
		expect((plugin as AnyPlugin).refreshOpenViews).toHaveBeenCalled();
	});

	it("文件不存在 → 提前返回", async () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).app.vault.adapter.exists = vi.fn(async () => false);
		await (plugin as AnyPlugin).loadPluginDeps();
		expect(DepGraph.parse).not.toHaveBeenCalled();
		expect((plugin as AnyPlugin).refreshOpenViews).not.toHaveBeenCalled();
	});

	it("解析为空 → 提前返回（不写 pluginDeps）", async () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).app.vault.adapter.exists = vi.fn(async () => true);
		(plugin as AnyPlugin).app.vault.adapter.read = vi.fn(async () => "");
		(DepGraph.parse as unknown as { mockReturnValue: (v: unknown) => void }).mockReturnValue(null);
		await (plugin as AnyPlugin).loadPluginDeps();
		expect((plugin as AnyPlugin).pluginDeps).toBeNull();
		expect((plugin as AnyPlugin).refreshOpenViews).not.toHaveBeenCalled();
	});
});

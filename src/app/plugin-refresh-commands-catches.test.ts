import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";

/**
 * 补 app/plugin.ts 三个命令刷新方法的命令移除 catch——既有测试从没让「removeCommand 抛错」发生过：
 *  - refreshProfileCommands（1265-1266）：对已注册 profile 命令做 removeCommand 失败时忽略
 *  - refreshPluginToggleCommands（1927-1928）：注册插件切换命令失败时整体兜底记日志
 *  - refreshSnippetToggleCommands（1966-1967）：注册 CSS 片段切换命令失败时整体兜底记日志
 * 错误模式「Obsidian 命令系统异常时刷新命令列表会冒红/中断」。
 *
 * 手法：把 app.commands.removeCommand 桩成拒绝（真实 removeCommand 私有方法会调用它并冒泡异常），
 * 三个命令 id 数组各放一条，直接调用三个刷新方法，首个 removeCommand 抛错即走各自 catch。logger 经
 * vi.mock 换带 spy 的桩以断言。本文件自包含，无需 onload。私人方法经 AnyPlugin 转型访问。本轮绝不碰已有测试文件。
 */

const loggerMock = vi.hoisted(() => ({ warn: vi.fn(), error: vi.fn() }));
vi.mock("@shared/logger", () => ({ logger: loggerMock }));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {
			commands: {
				removeCommand: vi.fn(() => {
					throw new Error("cmd unavailable");
				}),
			},
		},
		profileCommandIds: ["p1"],
		pluginToggleCommandIds: ["t1"],
		cssToggleCommandIds: ["c1"],
		settings: { profiles: [] as { name: string }[] },
		addCommand: vi.fn(),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	loggerMock.warn.mockClear();
});

describe("refresh*Commands 命令移除失败 catch（1265-1266 / 1927-1928 / 1966-1967）", () => {
	it("refreshProfileCommands：removeCommand 抛错 → 忽略（覆盖 1265-1266）", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).refreshProfileCommands();
		expect(loggerMock.warn).toHaveBeenCalledTimes(0); // 被静默忽略
	});

	it("refreshPluginToggleCommands：removeCommand 抛错 → 整体兜底（覆盖 1927-1928）", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).refreshPluginToggleCommands();
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
	});

	it("refreshSnippetToggleCommands：removeCommand 抛错 → 整体兜底（覆盖 1966-1967）", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).refreshSnippetToggleCommands();
		expect(loggerMock.warn).toHaveBeenCalledTimes(1);
	});
});

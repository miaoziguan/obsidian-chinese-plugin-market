import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { Notice } from "obsidian";

/**
 * 补 app/plugin.ts 的 openManageGroups（1584-1592）：弹窗管理分组（对齐参考插件的模态框交互）。
 * 既有 plugin*.test.ts 从没驱动这个方法——错误模式是「设置页点开『管理分组』弹窗失败/无反馈」。
 *
 * 手法：@ui/settings/group-management-modal 的 GroupManagementModal 换成可控哑类——open() 默认无操作
 * （覆盖 1586-1587）、throw 模式覆盖 catch（1588-1590 的 logger.warn + Notice）；obsidian 的 Notice
 * 经 vi.mock 替换；createGroupManageStore 经 Object.assign 打桩。本方法自包含，无需 onload。
 */

const modalState = vi.hoisted(() => ({ throwOnOpen: false }));
vi.mock("@ui/settings/group-management-modal", () => ({
	GroupManagementModal: class {
		constructor(_app: unknown, _store: unknown) {}
		open(): void {
			if (modalState.throwOnOpen) throw new Error("boom");
		}
	},
}));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: vi.fn(),
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		createGroupManageStore: vi.fn(() => ({})),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	modalState.throwOnOpen = false;
});

describe("openManageGroups：弹窗管理分组（1584-1592）", () => {
	it("正常打开弹窗 → 用 store 构造模态框", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).openManageGroups("favorites");
		expect((plugin as AnyPlugin).createGroupManageStore).toHaveBeenCalledWith("favorites");
		expect(Notice).not.toHaveBeenCalled();
	});

	it("弹窗打开失败 → 记日志并提示，不抛到上层", () => {
		modalState.throwOnOpen = true;
		const plugin = makePlugin();
		expect(() => (plugin as AnyPlugin).openManageGroups("favorites")).not.toThrow();
		expect(Notice).toHaveBeenCalled();
	});
});

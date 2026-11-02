import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { Notice } from "obsidian";

/**
 * 补 app/plugin.ts 的 renameSnippetPrompt（1882-1892）：弹窗请求重命名 CSS 片段，确认后调用
 * store 层重命名（同步启用状态与元数据 key）。既有 plugin*.test.ts 从没驱动这个方法——
 * 错误模式是「设置页里重命名 CSS 片段失败/无反馈，启用状态与元数据 key 错位」。
 *
 * 手法：@ui/settings/snippet-rename-modal 的 SnippetRenameModal 换成可控哑类——open() 默认调用
 * 入参的 onRename 回调（覆盖 1885 的 createCssStore().renameSnippet），或在 throw 模式下抛错
 * （覆盖 1888-1890 的 logger.warn + Notice）；obsidian 的 Notice 经 vi.mock 替换；createCssStore
 * 经 Object.assign 打桩返回含 renameSnippet 的桩。
 */

const renameState = vi.hoisted(() => ({ throwOnOpen: false }));
vi.mock("@ui/settings/snippet-rename-modal", () => ({
	SnippetRenameModal: class {
		captured: (newBase: string) => void;
		constructor(_app: unknown, _base: unknown, cb: (newBase: string) => void) {
			this.captured = cb;
		}
		open(): void {
			if (renameState.throwOnOpen) throw new Error("boom");
			this.captured("newBase");
		}
	},
}));
vi.mock("obsidian", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	Notice: vi.fn(),
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const cssStore = { renameSnippet: vi.fn() };
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: {},
		createCssStore: vi.fn(() => cssStore),
		...extra,
		__cssStore: cssStore,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
	renameState.throwOnOpen = false;
});

describe("renameSnippetPrompt：CSS 片段重命名弹窗（1882-1892）", () => {
	it("确认重命名 → 调用 store 层 renameSnippet", () => {
		const plugin = makePlugin();
		(plugin as AnyPlugin).renameSnippetPrompt("oldBase");
		expect((plugin as AnyPlugin).__cssStore.renameSnippet).toHaveBeenCalledWith("oldBase", "newBase");
	});

	it("弹窗打开失败 → 记日志并提示，不抛到上层", () => {
		renameState.throwOnOpen = true;
		const plugin = makePlugin();
		expect(() => (plugin as AnyPlugin).renameSnippetPrompt("oldBase")).not.toThrow();
		expect(Notice).toHaveBeenCalled();
	});
});

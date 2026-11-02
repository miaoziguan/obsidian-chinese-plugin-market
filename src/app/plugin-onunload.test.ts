import { describe, it, expect, vi, beforeEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { disposeAllShared } from "@semantic/workers/worker-backend";

/**
 * 补 app/plugin.ts 的 onunload（1065-1114）：卸载期资源释放与兜底落盘。既有 plugin*.test.ts
 * 没驱动这个生命周期方法，错误模式是「自我更新/禁用时向量 worker 内存泄漏、刚编辑的缓存静默丢失、
 * 已打开的市场视图没关闭」。
 *
 * 手法：disposeAllShared 经 vi.mock 替换；indexRefreshTimer / _saveTranslatorDataTimer /
 * vectorStore / settingsTranslator / _saveSettingsDebounce / 各 immediate 落盘方法、
 * getLeavesOfType 经 Object.assign 打桩，直接调用 onunload。
 */

vi.mock("@semantic/workers/worker-backend", async (importOriginal) => ({
	...(await importOriginal<Record<string, unknown>>()),
	disposeAllShared: vi.fn(),
}));

type AnyPlugin = Record<string, any>;

function makePlugin(extra: Record<string, any> = {}) {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	Object.assign(plugin, {
		manifest: { id: "chinese-plugin-market", version: "1.0.0" },
		app: { workspace: { getLeavesOfType: vi.fn(() => []) } },
		settings: {},
		indexRefreshTimer: null as number | null,
		localIndexUnloadRequested: false,
		_saveTranslatorDataTimer: null as number | null,
		_saveSettingsDebounce: { cancel: vi.fn(), pending: vi.fn(() => false) },
		saveVectorIndex: vi.fn(async () => {}),
		vectorStore: { dispose: vi.fn(async () => {}) },
		settingsTranslator: null as null | { disable: ReturnType<typeof vi.fn>; exportCache: ReturnType<typeof vi.fn> },
		_saveSettingsImmediate: vi.fn(async () => {}),
		_saveTranslatorDataImmediate: vi.fn(async () => {}),
		...extra,
	});
	return plugin;
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("onunload：卸载期资源释放与兜底落盘（1065-1114）", () => {
	it("含待释放资源 → 清理定时器/worker、落盘缓存、关闭视图", async () => {
		const leaf = { detach: vi.fn() };
		const plugin = makePlugin({
			indexRefreshTimer: 123,
			_saveTranslatorDataTimer: 456,
			app: { workspace: { getLeavesOfType: vi.fn(() => [leaf]) } },
			settingsTranslator: { disable: vi.fn(), exportCache: vi.fn(() => ({ cached: 1 })) },
		});
		(plugin as AnyPlugin).onunload();
		// 清理索引刷新定时器
		expect((plugin as AnyPlugin).indexRefreshTimer).toBeNull();
		// 释放本地语义 worker（防内存泄漏）
		expect(disposeAllShared).toHaveBeenCalled();
		// 卸载设置页翻译钩子并回写缓存
		expect((plugin as AnyPlugin).settingsTranslator.disable).toHaveBeenCalled();
		expect((plugin as AnyPlugin).settingsTranslator.exportCache).toHaveBeenCalled();
		expect((plugin as AnyPlugin).settings.settingsTranslateCache).toEqual({ cached: 1 });
		// 清理翻译数据防抖定时器
		expect((plugin as AnyPlugin)._saveTranslatorDataTimer).toBeNull();
		// 防抖取消已触发
		expect((plugin as AnyPlugin)._saveSettingsDebounce.cancel).toHaveBeenCalled();
		// 落盘相关调用在 fire-and-forget 异步块里，冲刷微任务后再断言
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		// 落盘 partial 向量索引 + 关闭 SQLite
		expect((plugin as AnyPlugin).saveVectorIndex).toHaveBeenCalled();
		expect((plugin as AnyPlugin).vectorStore.dispose).toHaveBeenCalled();
		// 有 pending translator → 触发 immediate 落盘
		expect((plugin as AnyPlugin)._saveTranslatorDataImmediate).toHaveBeenCalledWith(false);
		// 关闭所有翻译视图
		expect(leaf.detach).toHaveBeenCalled();
	});
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import ChinesePluginMarketPlugin from "@app/plugin";
import { Translator } from "@domain/catalog/translator";

/**
 * 持久化层回归（审计 P0-1）。
 * 桩掉 Obsidian 的 saveData/loadData + app，验证 saveSettings（防抖合并）/
 * flushSaveSettings（即时） / onunload（卸载兜底）三路径的写盘契约，
 * 防止「后写覆盖先写」竞态或埋点丢失在重构中被悄悄引入。
 */
function makePlugin() {
	const plugin = new ChinesePluginMarketPlugin({} as never, {} as never);
	const saveData = vi.fn(async () => {});
	Object.assign(plugin, {
		saveData,
		loadData: vi.fn(async () => ({})),
		_data: {} as Record<string, unknown>,
		settings: {} as never,
		translator: new Translator(),
		app: { workspace: { getLeavesOfType: () => [] } },
		_saveTranslatorDataTimer: null,
	});
	return { plugin, saveData };
}

describe("Plugin 持久化契约（P0 回归）", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("连续 saveSettings 合并为单次写盘（防抖 300ms）", async () => {
		const { plugin, saveData } = makePlugin();
		plugin.saveSettings();
		plugin.saveSettings();
		plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
		await vi.advanceTimersByTimeAsync(300);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("flushSaveSettings 立即写盘并取消挂起定时器", async () => {
		const { plugin, saveData } = makePlugin();
		plugin.saveSettings();
		expect(saveData).not.toHaveBeenCalled();
		await plugin.flushSaveSettings();
		expect(saveData).toHaveBeenCalledTimes(1);
		await vi.advanceTimersByTimeAsync(300);
		expect(saveData).toHaveBeenCalledTimes(1);
	});

	it("本地模型旧默认值迁移：all-MiniLM-L6-v2 → bge-small-zh", async () => {
		const { plugin } = makePlugin();
		// 模拟旧版 data.json 里持久化的旧默认模型名
		const allData: Record<string, unknown> = {
			embeddingLocalModel: "Xenova/all-MiniLM-L6-v2",
		};
		await (plugin as any).loadSettings(allData);
		expect(plugin.settings.embeddingLocalModel).toBe("Xenova/bge-small-zh-v1.5");
		// 用户主动改的其它模型名应保留
		const allData2: Record<string, unknown> = {
			embeddingLocalModel: "Xenova/custom-model",
		};
		await (plugin as any).loadSettings(allData2);
		expect(plugin.settings.embeddingLocalModel).toBe("Xenova/custom-model");
	});

	it("onunload 对挂起的 settings 兜底落盘", async () => {
		const { plugin, saveData } = makePlugin();
		plugin.saveSettings(); // 挂起，未到 300ms
		plugin.onunload();
		await vi.runAllTimersAsync();
		expect(saveData).toHaveBeenCalled();
	});
});

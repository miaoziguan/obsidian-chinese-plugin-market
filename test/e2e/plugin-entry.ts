/**
 * E2E 测试入口（浏览器侧）——整插件启动关键路径。
 * 实例化真实 ChinesePluginMarketPlugin，跑 onload()，暴露 window.__e2ePlugin
 * 供 Playwright 断言「命令注册 / 设置页 / 视图注册 / 设置读写」。
 * 不依赖真实 Obsidian 运行时，仅用 obsidian-mock 提供的 App/数据仓。
 */
import "./obsidian-mock";
import ChinesePluginMarketPlugin from "../../src/app/plugin";
import { makeApp } from "./obsidian-mock";
// eslint-disable-next-line @typescript-eslint/no-var-requires
import manifest from "../../manifest.json";

let instance: any = null;

interface StartResult {
	commandIds: string[];
	commandNames: string[];
	settingTabs: number;
	viewTypes: string[];
	recommendedIdsSize: number;
	recommendedTitle: string;
	defaultLanguage: string | undefined;
}

async function startPlugin(presetData: Record<string, unknown> = {}): Promise<StartResult> {
	instance = new ChinesePluginMarketPlugin(makeApp(), {
		id: "chinese-plugin-market",
		...(manifest as Record<string, unknown>),
	});
	// 预置数据仓（模拟已落盘的 data.json），供「设置读取」断言
	instance._data = { ...presetData };
	// e2e 环境无真实 metadataCache，模拟「已 resolved」，避免 scanVaultTM 卡在 waitMetadataResolved
	(instance as any).waitMetadataResolved = async () => {};
	await instance.onload();
	// 推荐清单加载已移到 onLayoutReady → initDeferredLoad（异步），onload() 返回时可能未完成；
	// 轮询等待 recommendedIds 填充（读取 plugin-recommend.json 或 fallback 内置清单），最多 6s
	const t0 = Date.now();
	while (instance.recommendedIds.size === 0 && Date.now() - t0 < 6000) {
		await new Promise((r) => setTimeout(r, 25));
	}
	return {
		commandIds: instance.commands.map((c: any) => c.id),
		commandNames: instance.commands.map((c: any) => c.name),
		settingTabs: instance.settingTabs.length,
		viewTypes: instance.views.map((v: any) => v.type),
		recommendedIdsSize: instance.recommendedIds.size,
		recommendedTitle: instance.recommendedTitle,
		defaultUseMyMemory: instance.settings.useMyMemory,
		defaultSortBy: instance.settings.sortBy,
	};
}

(window as any).__e2ePlugin = {
	startPlugin,
	getInstance: () => instance,
	getData: () => (instance ? instance._data : null),
	reset: () => {
		instance = null;
	},
};

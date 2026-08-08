/**
 * 已安装插件状态实时同步（#14）。
 *
 * 桌面端（Electron）用 Node fs.watch 监听 vault/.obsidian/plugins/ 目录，
 * 监听到 add/remove 事件（debounce 500ms）后重新快照 installedIds，
 * 原地刷新受影响卡片的「已安装」徽标，并在列表成员可能变化（installFilter=installed）时重渲。
 *
 * 移动端无 fs.watch：降级为 60s 轮询（同样走快照 + diff + 刷新）。
 * require 走 runtime（globalThis.require），避免 esbuild 静态解析 node:fs 导致移动端构建异常。
 */

import { logger } from "@shared/logger";
import { applyCardState } from "@ui/components/card-render";
import type { ViewContext } from "@ui/view/view-context";

/** 桌面端是否可用 fs.watch */
function tryGetFsWatch(): ((dir: string, cb: () => void) => { close: () => void }) | null {
	// 运行时取 require：CJS 产物在桌面 Electron 下存在；移动端 require 不存在或 require("fs") 抛错 → 降级轮询
	const g = globalThis as unknown as { require?: (id: string) => unknown };
	const fsRequire = g.require;
	if (!fsRequire) return null;
	try {
		const fs = fsRequire("fs") as {
			watch: (path: string, cb: () => void) => { close: () => void };
			existsSync?: (p: string) => boolean;
		};
		if (typeof fs?.watch !== "function") return null;
		return fs.watch;
	} catch (e) {
		logger.debug("[Chinese Plugin Market] 无 fs 模块，已安装监听降级为轮询：", e);
		return null;
	}
}

/**
 * 启动已安装状态监听，返回 disposer（onClose 时调用以释放 watcher / 轮询定时器）。
 */
export function startInstalledWatch(ctx: ViewContext): () => void {
	// vault 根路径：桌面端 FileAdapter 在运行时暴露 basePath（指向 vault 根目录）；
	// 官方 DataAdapter 类型未声明，用受控 as any 读取。移动端无此字段 → 降级轮询。
	const adapter = ctx.app.vault.adapter as unknown as { basePath?: string };
	const basePath = adapter.basePath;
	if (typeof basePath !== "string" || basePath.length === 0) {
		logger.debug("[Chinese Plugin Market] 无法解析 vault 路径，跳过已安装监听");
		return () => {};
	}
	const watchDir = `${basePath}/.obsidian/plugins`;

	let debounceTimer: number | undefined;
	let intervalId: number | undefined;
	let fsWatcher: { close: () => void } | null = null;

	// 重新快照 + diff + 刷新（桌面事件与移动轮询共用）
	const onChange = () => {
		if (ctx.disposed) return;
		const before = ctx.installedIds;
		ctx.snapshotInstalled();
		const after = ctx.installedIds;

		// diff：找出新增/移除的 id
		const changed = new Set<string>();
		for (const id of after) if (!before.has(id)) changed.add(id);
		for (const id of before) if (!after.has(id)) changed.add(id);
		if (changed.size === 0) return;

		logger.debug(
			`[Chinese Plugin Market] 已安装状态变化：新增 ${[...changed].filter((id) => after.has(id)).length} / 移除 ${[...changed].filter((id) => before.has(id)).length}，原地刷新卡片`
		);

		// 原地刷新受影响卡片（避免全量重建、保滚动位置）
		const renderCtx = ctx.cardPoolCtx;
		if (renderCtx) {
			for (const id of changed) {
				const card = ctx.cardById.get(id);
				if (!card) continue;
				const plugin = ctx.plugins.find((p) => p.id === id);
				if (plugin) {
					applyCardState(card, plugin, ctx.translatedResults[id], renderCtx);
				}
			}
		}
		// 列表成员可能变化（installFilter=installed）：触发一次重渲（保滚动）
		ctx.scheduleRender(true);
	};

	const scheduleChange = () => {
		if (debounceTimer) window.clearTimeout(debounceTimer);
		debounceTimer = window.setTimeout(onChange, 500);
	};

	const watch = tryGetFsWatch();
	if (watch) {
		try {
			fsWatcher = watch(watchDir, scheduleChange);
			logger.debug(`[Chinese Plugin Market] 已启动已安装监听（fs.watch）：${watchDir}`);
		} catch (e) {
			logger.warn("[Chinese Plugin Market] fs.watch 启动失败，降级轮询：", e);
			fsWatcher = null;
		}
	}

	if (!fsWatcher) {
		// 移动端 / fs.watch 不可用：60s 轮询
		intervalId = window.setInterval(onChange, 60_000);
		logger.debug("[Chinese Plugin Market] 已启动已安装监听（轮询 60s）");
	}

	return () => {
		if (debounceTimer) window.clearTimeout(debounceTimer);
		if (intervalId) window.clearInterval(intervalId);
		if (fsWatcher) {
			try {
				fsWatcher.close();
			} catch {
				/* 忽略关闭异常 */
			}
			fsWatcher = null;
		}
	};
}

/**
 * 直链 Beta 插件聚合更新（P0 闭环）。
 *
 * 单插件更新逻辑在 direct-install.ts 的 updateBetaPlugin（复用 installFiles 写盘/重载）。
 * 本模块负责「批量」与「纯函数」，供设置页「全部更新」与插件启动自动更新调用，
 * 并集中处理移动端限制与逐条错误隔离（一条失败不影响其余）。
 */

import { type App, Platform, Notice } from "obsidian";
import {
	updateBetaPlugin,
	updateBetaTheme,
	type BetaKind,
	type BetaPluginEntry,
} from "@app/direct-install";
import { makeT } from "@shared/i18n";

export type { BetaPluginEntry } from "@app/direct-install";

const t = makeT();

/** 由一次成功的直链安装构造跟踪表项（未冻结） */
export function buildBetaEntry(
	id: string,
	name: string,
	version: string,
	rootUrl: string,
	kind: BetaKind = "plugin",
	release = false,
): BetaPluginEntry {
	return { id, name: name || id, rootUrl, installedVersion: version, frozen: false, kind, release };
}

/** 按类型更新单项（插件走三件套，主题走 theme.css） */
export async function updateBetaEntry(
	app: App,
	entry: BetaPluginEntry,
): Promise<{ updated: boolean; manifest: { version: string } }> {
	return entry.kind === "theme"
		? updateBetaTheme(app, entry)
		: updateBetaPlugin(app, entry);
}

export interface BetaUpdateItemResult {
	id: string;
	name: string;
	/** 是否有新版本被写入（false = 已最新 / 冻结跳过） */
	updated: boolean;
	/** 更新后的版本号（updated=true 时存在） */
	version?: string;
	/** 失败原因（失败时出现） */
	error?: string;
}

export interface BetaUpdateResult {
	total: number;
	updated: number;
	skipped: number;
	failed: number;
	results: BetaUpdateItemResult[];
}

/**
 * 批量更新直链 Beta 插件。
 * @param entries 跟踪表（来自 settings.betaPlugins）
 * @param opts.silent 为 true 时不弹逐条 Notice，仅返回结果（供启动自动更新静默跑）
 */
export async function updateAllBetaPlugins(
	app: App,
	entries: BetaPluginEntry[],
	opts: { silent?: boolean } = {},
): Promise<BetaUpdateResult> {
	const silent = opts.silent ?? false;
	const res: BetaUpdateResult = {
		total: entries.length,
		updated: 0,
		skipped: 0,
		failed: 0,
		results: [],
	};
	if (Platform.isMobile) {
		if (!silent) new Notice(t("beta.mobileBlocked"));
		return res;
	}
	for (const e of entries) {
		if (e.frozen) {
			res.skipped++;
			res.results.push({ id: e.id, name: e.name, updated: false });
			continue;
		}
		try {
			const r = await updateBetaEntry(app, e);
			if (r.updated) {
				res.updated++;
				res.results.push({ id: e.id, name: e.name, updated: true, version: r.manifest.version });
				if (!silent) {
					new Notice(t("beta.updated", { name: e.name || e.id, version: r.manifest.version }), 5000);
				}
			} else {
				res.skipped++;
				res.results.push({ id: e.id, name: e.name, updated: false });
			}
		} catch (err) {
			res.failed++;
			const msg = err instanceof Error ? err.message : String(err);
			res.results.push({ id: e.id, name: e.name, updated: false, error: msg });
			if (!silent) new Notice(t("beta.failed", { msg }), 8000);
		}
	}
	if (!silent && res.total > 0) {
		new Notice(t("beta.updateAllDone", { total: String(res.total), updated: String(res.updated) }), 6000);
	}
	return res;
}

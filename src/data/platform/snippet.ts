/**
 * CSS 片段的平台操作层（I2：封装 app.customCss 与 vault adapter）。
 *
 * 与插件管理对称，但数据源是 `.obsidian/snippets/*.css` 文件 + app.customCss
 * 的启用集合。所有写操作（重命名 / 删除 / 创建）走 vault.adapter 并全程容错，
 * 失败只 warn，绝不抛给原生事件链。
 */

import type { App, TFile } from "obsidian";
import { asAppInternals } from "./obsidian-internals";
import { logger } from "@shared/logger";

/** snippets 目录（相对 vault 根） */
export const SNIPPET_DIR = ".obsidian/snippets";

export interface SnippetInfo {
	/** 文件名（含 .css 后缀） */
	name: string;
	/** 去 .css 后缀的基名，用作分组 / 元数据 key */
	baseName: string;
	/** 是否处于启用状态（由 app.customCss.snippets 判定） */
	enabled: boolean;
	/** vault 相对路径 */
	path: string;
}

const SNIPPET_TYPE = "snippet" as const;

/** 列出全部 CSS 片段文件，并标记启用状态（按基名排序） */
export function listSnippets(app: App): SnippetInfo[] {
	const enabled = new Set(asAppInternals(app).customCss?.snippets ?? []);
	const files = app.vault.getFiles().filter(
		(f): f is TFile =>
			f.path.startsWith(`${SNIPPET_DIR}/`) && f.path.endsWith(".css"),
	);
	return files
		.map((f) => {
			const baseName = f.name.replace(/\.css$/i, "");
			return {
				name: f.name,
				baseName,
				enabled: enabled.has(baseName),
				path: f.path,
			};
		})
		.sort((a, b) => a.baseName.localeCompare(b.baseName));
}

/** 某个片段是否启用 */
export function isSnippetEnabled(app: App, baseName: string): boolean {
	return Boolean(asAppInternals(app).customCss?.snippets?.includes(baseName));
}

/** 切换片段启用状态（兼容 Obsidian 1.x 三参签名与旧版两参签名） */
export async function setSnippetEnabled(
	app: App,
	baseName: string,
	enabled: boolean,
): Promise<void> {
	const cc = asAppInternals(app).customCss;
	if (!cc?.setCssEnabled) {
		logger.warn("[Chinese Plugin Market] app.customCss.setCssEnabled 不可用，跳过切换");
		return;
	}
	try {
		cc.setCssEnabled(enabled, baseName, SNIPPET_TYPE);
	} catch {
		// 旧版回退：仅 (enabled, name)
		try {
			(cc.setCssEnabled as (e: boolean, n: string) => void)(enabled, baseName);
		} catch (error) {
			logger.warn("[Chinese Plugin Market] 切换 CSS 片段启用失败:", error);
		}
	}
}

/** 读取片段文件内容 */
export async function readSnippetContent(app: App, path: string): Promise<string> {
	return app.vault.adapter.read(path);
}

/** 写入（创建 / 覆盖）片段文件 */
export async function writeSnippet(
	app: App,
	baseName: string,
	content: string,
): Promise<void> {
	await app.vault.adapter.write(`${SNIPPET_DIR}/${baseName}.css`, content);
}

/** 删除片段文件（不存在则静默） */
export async function deleteSnippet(app: App, baseName: string): Promise<void> {
	const path = `${SNIPPET_DIR}/${baseName}.css`;
	if (await app.vault.adapter.exists(path)) {
		await app.vault.adapter.remove(path);
	}
}

/**
 * 重命名片段：复制内容到新文件 → 删除旧文件 → 同步启用状态。
 * 旧名仍启用则先启用新名再关闭旧名，避免闪烁与状态丢失。
 */
export async function renameSnippet(
	app: App,
	oldBase: string,
	newBase: string,
): Promise<void> {
	const content = await readSnippetContent(app, `${SNIPPET_DIR}/${oldBase}.css`);
	await writeSnippet(app, newBase, content);
	await deleteSnippet(app, oldBase);
	const wasEnabled = isSnippetEnabled(app, oldBase);
	if (wasEnabled) {
		await setSnippetEnabled(app, newBase, true);
		await setSnippetEnabled(app, oldBase, false);
	}
}

/** 用系统默认应用打开片段源文件（桌面端；移动端静默失败） */
export function openSnippetInDefaultApp(app: App, path: string): void {
	try {
		const open = (app as unknown as {
			openWithDefaultApp?: (p: string) => void;
		}).openWithDefaultApp;
		if (typeof open === "function") open(path);
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 系统打开 CSS 片段失败:", error);
	}
}

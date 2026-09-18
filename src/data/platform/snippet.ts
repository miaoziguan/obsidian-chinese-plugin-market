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

/** snippets 目录跟随用户自定义的配置目录（通过 Vault#configDir 获取，切勿写死 .obsidian） */

/**
 * snippets 目录（vault 相对路径），跟随用户自定义的配置目录。
 *
 * 不能写死 `.obsidian`：用户可用自定义 configDir，写死会导致整份名单为空。
 */
export function snippetDir(app: App): string {
	const cfg = app.vault?.configDir ?? "";
	return `${cfg.replace(/\/+$/, "")}/snippets`;
}

/**
 * 读取当前已启用 CSS 片段集合。
 *
 * 优先使用 Obsidian 内部 `customCss.enabledSnippets`（Set）。
 * 部分旧版 Obsidian 无此字段，且 `customCss.snippets` 是「检测到的全部」而非
 * 「已启用」，直接 fallback 会导致所有片段被误判为启用。此时从 appearance.json
 * 的 `enabledCssSnippets` 数组读取真实启用状态。
 */
async function readEnabledSnippets(app: App): Promise<Set<string>> {
	const cc = asAppInternals(app).customCss;
	if (cc?.enabledSnippets instanceof Set) return cc.enabledSnippets;

	const cfgDir = app.vault?.configDir ?? ".obsidian";
	try {
		const text = await app.vault.adapter.read(`${cfgDir}/appearance.json`);
		const data = JSON.parse(text) as { enabledCssSnippets?: string[] };
		const arr = Array.isArray(data?.enabledCssSnippets) ? data.enabledCssSnippets : [];
		return new Set(arr.map((n) => n.replace(/\.css$/i, "")));
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 读取 appearance.json 失败，CSS 启用状态可能不准确:", error);
		return new Set();
	}
}

export interface SnippetInfo {
	/** 文件名（含 .css 后缀） */
	name: string;
	/** 去 .css 后缀的基名，用作分组 / 元数据 key */
	baseName: string;
	/** 是否处于启用状态（由 app.customCss.enabledSnippets 或 appearance.json 判定） */
	enabled: boolean;
	/** vault 相对路径 */
	path: string;
}

/**
 * 片段清单缓存（按 app 隔离，避免插件重载 / 多 vault 串味）。
 *
 * 为什么必须缓存：枚举 snippets 只能异步走 `vault.adapter.list`，而 UI 渲染是同步的；
 * 由调用方在合适的时机调 refreshSnippets 预扫，listSnippets 同步读镜像。
 */
const snippetCache = new WeakMap<App, SnippetInfo[]>();

/**
 * 同步读取片段清单镜像（UI 渲染用）。
 *
 * 尚未异步扫描过（或扫描失败）时返回空数组——此时为空是「还没加载」，
 * 而不是「vault 里没有片段」，UI 层据此区分加载态与真空态。
 */
export function listSnippets(app: App): SnippetInfo[] {
	return snippetCache.get(app) ?? [];
}

/**
 * 异步重扫 snippets 目录并刷新缓存（多入口共用：启动 / 进入外观页 / 打开设置页 / 重命名后）。
 *
 * 为什么不能用 `app.vault.getFiles()`：配置目录（默认 .obsidian，可被用户改名）
 * **根本不在 vault 文件树里** —— 它既不广播 create/delete 事件，也不会出现在
 * getFiles() 的结果中。此前用它枚举片段，结果恒为空，于是出现「原生外观页显示
 * 已启用 N 个片段、本插件显示 0 个并提示暂无片段」的错位。
 * Obsidian 自身加载片段同样是 `adapter.list(<configDir>/snippets)`。
 */
export async function refreshSnippets(app: App): Promise<SnippetInfo[]> {
	const dir = snippetDir(app);
	const enabled = await readEnabledSnippets(app);
	const byBase = new Map<string, string>();

	for (const fileName of await listSnippetFileNames(app, dir)) {
		byBase.set(fileName.replace(/\.css$/i, ""), fileName);
	}
	// 兜底：即便目录扫描失败（adapter 不可用 / 目录被占用），也至少把 customCss
	// 里处于启用状态的片段呈现出来，避免再次出现「原生有、本插件 0 个」的错位。
	for (const baseName of enabled) {
		if (!byBase.has(baseName)) byBase.set(baseName, `${baseName}.css`);
	}

	const list = Array.from(byBase, ([baseName, fileName]) => ({
		name: fileName,
		baseName,
		enabled: enabled.has(baseName),
		path: `${dir}/${fileName}`,
	})).sort((a, b) => a.baseName.localeCompare(b.baseName));

	snippetCache.set(app, list);
	return list;
}

/** 读取 snippets 目录下的 .css 文件名；adapter.list 不可用时退回 vault 文件树 */
async function listSnippetFileNames(app: App, dir: string): Promise<string[]> {
	try {
		const listing = await app.vault.adapter.list(dir);
		return (listing?.files ?? [])
			.map((p) => p.split("/").pop() ?? "")
			.filter((name) => name.toLowerCase().endsWith(".css"));
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 扫描 CSS 片段目录失败，退回 vault 文件树:", error);
		return app.vault
			.getFiles()
			.filter(
				(f): f is TFile =>
					f.path.startsWith(`${dir}/`) && f.path.toLowerCase().endsWith(".css"),
			)
			.map((f) => f.name);
	}
}

/** 某个片段是否启用（优先 app.customCss.enabledSnippets，否则读缓存/appearance.json） */
export function isSnippetEnabled(app: App, baseName: string): boolean {
	const cc = asAppInternals(app).customCss;
	if (cc?.enabledSnippets instanceof Set) return cc.enabledSnippets.has(baseName);
	// 无运行时集合时，以最近一次 refreshSnippets 缓存为准
	const cached = snippetCache.get(app)?.find((s) => s.baseName === baseName);
	return cached?.enabled ?? false;
}

/** 切换片段启用状态（调用 Obsidian 内部 setCssEnabledStatus(name, enabled) 并刷新应用） */
export async function setSnippetEnabled(
	app: App,
	baseName: string,
	enabled: boolean,
): Promise<void> {
	const cc = asAppInternals(app).customCss;
	if (!cc?.setCssEnabledStatus) {
		logger.warn("[Chinese Plugin Market] app.customCss.setCssEnabledStatus 不可用，跳过切换");
		return;
	}
	try {
		cc.setCssEnabledStatus(baseName, enabled);
		// setCssEnabledStatus 只改内部状态，不会自动重新加载 CSS；
		// 必须手动触发加载，否则命令面板 / 设置页开关看起来「点了没反应」。
		if (cc.requestLoadSnippetsDebouncer) cc.requestLoadSnippetsDebouncer();
		else if (cc.loadSnippets) cc.loadSnippets();
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 切换 CSS 片段启用失败:", error);
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
	await app.vault.adapter.write(`${snippetDir(app)}/${baseName}.css`, content);
}

/** 删除片段文件（不存在则静默） */
export async function deleteSnippet(app: App, baseName: string): Promise<void> {
	const path = `${snippetDir(app)}/${baseName}.css`;
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
	const dir = snippetDir(app);
	const content = await readSnippetContent(app, `${dir}/${oldBase}.css`);
	await writeSnippet(app, newBase, content);
	await deleteSnippet(app, oldBase);
	const wasEnabled = isSnippetEnabled(app, oldBase);
	if (wasEnabled) {
		await setSnippetEnabled(app, newBase, true);
		await setSnippetEnabled(app, oldBase, false);
	}
	// 文件名变了，重新对齐缓存清单供立即渲染（否则列表还是旧名）
	try {
		await refreshSnippets(app);
	} catch (error) {
		logger.warn("[Chinese Plugin Market] 重命名后刷新 CSS 片段清单失败:", error);
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

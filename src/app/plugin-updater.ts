/**
 * 一键更新已安装的社区插件（桌面端）。
 *
 * 复用直链安装（direct-install.ts）的「下载 → 写盘 → 重载」三段式逻辑，
 * 但来源从「用户直链」改为「官方仓库 repo」：
 *   - repo（owner/name）经 buildManifestUrl / buildMainJsUrl 拼成 raw.githubusercontent
 *     源（与洞察/信号抓取同源，自动享受镜像容错）；
 *   - 下载 manifest.json / main.js / styles.css 三件套，覆盖写盘；
 *   - disable + enablePluginAndSave 让新代码生效（与 installFromUrl 一致）。
 *
 * 移动端限制：Obsidian 移动端禁止写入 plugins 目录，故直接拒绝并提示回原生设置面板。
 */

import { type App, Platform, requestUrl, requireApiVersion } from "obsidian";
import { asAppInternals } from "@data/platform/obsidian-internals";
import { buildManifestUrl, buildMainJsUrl } from "@domain/compare/plugin-insight";
import { resolveUrl, type MirrorConfig } from "@domain/catalog/mirror";
import { makeT } from "@shared/i18n";

const t = makeT();

/** 插件 manifest 最小形状（obsidian 包未导出 Manifest 类型，按需本地声明） */
interface Manifest {
	id: string;
	version?: string;
	main?: string;
	minAppVersion?: string;
	name?: string;
}

/** 由 repo 构造 styles.css 的 raw URL（manifest/main.js 已有现成构造器，styles 需补） */
function buildStylesUrl(repo: string, mirror: MirrorConfig): string {
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
	const rawUrl = `https://raw.githubusercontent.com/${parts[0]}/${parts[1]}/HEAD/styles.css`;
	return resolveUrl(rawUrl, mirror);
}

/**
 * 把已安装插件升级到官方仓库最新版本。
 *
 * @param app    Obsidian App（写盘 + 重载插件实例）
 * @param id     插件 id（用于写盘目录与校验 manifest.id）
 * @param repo   插件仓库 owner/name（来自官方列表 PluginInfo.repo）
 * @param mirror 镜像配置（manifest/main.js 下载源）
 * @returns 安装后的 Manifest（含版本号）
 * @throws 移动端 / 无仓库 / 下载失败 / 启用失败等错误（调用方负责 Notice）
 */
export async function updatePluginCore(
	app: App,
	id: string,
	repo: string,
	mirror: MirrorConfig,
): Promise<Manifest> {
	if (Platform.isMobile) throw new Error(t("action.update.mobileBlocked"));
	if (!repo) throw new Error(t("action.update.noRepo"));

	// 1) 拉最新 manifest 原始文本（用 installFromUrl 同款校验，避免覆盖成装不上的版本）
	const manUrl = buildManifestUrl(repo, mirror);
	if (!manUrl) throw new Error(t("action.update.noRepo"));
	const manResp = await requestUrl({ url: manUrl, throw: false });
	if (manResp.status < 200 || manResp.status >= 300) {
		throw new Error(t("action.update.fetchFail", { file: "manifest.json", code: String(manResp.status) }));
	}
	const man = JSON.parse(manResp.text) as Manifest;
	if (typeof man.id !== "string" || man.id !== id) throw new Error(t("directInstall.badManifest"));
	// 写盘不可逆：先确认新版本在本机能跑起来
	if (man.minAppVersion && !requireApiVersion(man.minAppVersion)) {
		throw new Error(t("directInstall.minApp", { v: man.minAppVersion }));
	}

	// 2) 下载 main.js（必选）/ styles.css（可选）
	const mainUrl = buildMainJsUrl(repo, man.main, mirror);
	const cssUrl = buildStylesUrl(repo, mirror);
	const mainResp = await requestUrl({ url: mainUrl, throw: false });
	if (mainResp.status < 200 || mainResp.status >= 300) {
		throw new Error(t("action.update.fetchFail", { file: "main.js", code: String(mainResp.status) }));
	}
	const mainText = mainResp.text;
	if (!mainText || !mainText.trim()) throw new Error(t("directInstall.emptyMain"));
	let cssText: string | null = null;
	const cssResp = await requestUrl({ url: cssUrl, throw: false });
	if (cssResp.status >= 200 && cssResp.status < 300) cssText = cssResp.text;

	// 3) 写盘覆盖（manifest / main.js 必写；styles.css 新版无则删旧）
	const ad = app.vault.adapter;
	const dir = app.vault.configDir + "/plugins/" + id;
	if (!(await ad.exists(dir))) await ad.mkdir(dir);
	await ad.write(dir + "/manifest.json", manResp.text);
	await ad.write(dir + "/main.js", mainText);
	if (cssText != null) await ad.write(dir + "/styles.css", cssText);
	else if (await ad.exists(dir + "/styles.css")) await ad.remove(dir + "/styles.css");

	// 4) 重载插件实例（先停后起，否则新代码不生效）
	const plugins = asAppInternals(app).plugins;
	if (!plugins) throw new Error(t("directInstall.noPluginsApi"));
	await plugins.loadManifests?.();
	if (plugins.manifests?.[id] || plugins.enabledPlugins?.has?.(id)) {
		await plugins.disablePlugin?.(id);
	}
	if (plugins.enablePluginAndSave) await plugins.enablePluginAndSave(id);
	else if (plugins.enablePlugin) await plugins.enablePlugin(id);
	else throw new Error(t("directInstall.noPluginsApi"));
	const stillEnabled = plugins.enabledPlugins?.has?.(id) ?? Boolean(plugins.manifests?.[id]);
	if (!stillEnabled) throw new Error(t("directInstall.enableFailed"));

	return man;
}

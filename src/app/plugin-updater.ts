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
import { buildManifestUrl } from "@domain/compare/plugin-insight";
import { resolveUrl, type MirrorConfig } from "@domain/catalog/mirror";
import { githubReleaseAssetUrls } from "@app/direct-install";
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

/** 从 owner/name 字符串反解 */
function parseRepo(repo: string): { owner: string; repo: string } | null {
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { owner: parts[0], repo: parts[1] };
}

/** 构造任意文件的 raw 源码树 URL（经镜像） */
function buildRawUrl(repo: string, file: string, mirror: MirrorConfig): string {
	const ref = parseRepo(repo);
	if (!ref) return "";
	const rawUrl = `https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/HEAD/${file}`;
	return resolveUrl(rawUrl, mirror);
}

/**
 * 拉取文件：先走 raw 源码树（镜像），404/410 再回退 GitHub Release 资产。
 * 这是为 Vinzent03/obsidian-git 这类不提交 main.js 到源码树的插件准备的。
 */
export async function fetchWithReleaseFallback(
	repo: string,
	file: string,
	version: string,
	mirror: MirrorConfig,
	optional = false,
): Promise<string | null> {
	const gh = parseRepo(repo);
	const urls: string[] = [];
	const raw = buildRawUrl(repo, file, mirror);
	if (raw) urls.push(raw);
	if (gh) urls.push(...githubReleaseAssetUrls(gh, file, version || undefined));
	let lastStatus = 0;
	for (const url of urls) {
		const r = await requestUrl({ url, throw: false });
		if (r.status >= 200 && r.status < 300) return r.text;
		// 500/403 等不继续试下一个来源，直接抛错（当成服务端问题）
		if (r.status !== 404 && r.status !== 410) {
			throw new Error(t("action.update.fetchFail", { file, code: String(r.status) }));
		}
		lastStatus = r.status;
	}
	if (optional) return null;
	throw new Error(t("action.update.fetchFail", { file, code: String(lastStatus || 404) }));
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
	// 源码树优先（享镜像），404 则回退 GitHub Release 资产（很多插件不把构建产物提交到 git）
	const mainFile = man.main && man.main.trim() ? man.main.trim() : "main.js";
	const mainText = await fetchWithReleaseFallback(repo, mainFile, man.version ?? "", mirror);
	if (!mainText || !mainText.trim()) throw new Error(t("directInstall.emptyMain"));
	const cssText = await fetchWithReleaseFallback(repo, "styles.css", man.version ?? "", mirror, true);

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

/**
 * 一键安装社区插件。
 *
 * 实现：不依赖 Obsidian 内置社区市场页面跳转，而是直接下载插件 release 资产
 * （manifest.json / main.js / styles.css）到 vault/.obsidian/plugins/{id}/，
 * 再调用 Obsidian 半官方插件管理 API 刷新 manifest、加载并启用插件。
 *
 * 失败时回退到原行为：打开 obsidian://show-plugin?id= 跳转。
 */

import { Notice } from "obsidian";
import { asAppInternals, type AppPlugins } from "@data/platform/obsidian-internals";
import { fetchManifest } from "@domain/compare/plugin-insight";
import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "@ui/view/view-context";
import { netRequest } from "@data/net/net";
import { resolveUrl, type MirrorConfig } from "@domain/catalog/mirror";
import { mirrorConfig } from "@ui/view/view-data";
import { logger } from "@shared/logger";

/** 安装结果 */
export interface InstallResult {
	ok: boolean;
	/** 失败原因（用户可读） */
	reason?: string;
	/** 是否已回退到市场跳转 */
	fallback?: boolean;
}

/**
 * 构造 GitHub raw release 资产 URL（按 tag = version），并应用镜像映射。
 * 社区插件通常以 manifest.version 作为 release tag。
 */
function buildReleaseAssetUrl(
	repo: string | undefined,
	file: string,
	version: string,
	mirror: MirrorConfig
): string {
	if (!repo) return "";
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
	const [owner, name] = parts;
	const rawUrl = `https://raw.githubusercontent.com/${owner}/${name}/${version}/${file}`;
	return resolveUrl(rawUrl, mirror);
}

/** 读取响应文本，兼容 netRequest 返回结构 */
function responseText(resp: { text?: string; json?: unknown }): string {
	if (typeof resp.text === "string") return resp.text;
	return "";
}

/**
 * 尝试多种 tag 变体下载 release 资产（先 version，再 v{version}）。
 * 某些社区插件的 release tag 带 "v" 前缀，而 manifest.version 不带。
 */
async function fetchReleaseAsset(
	repo: string,
	file: string,
	version: string,
	mirror: MirrorConfig
): Promise<{ ok: boolean; text: string; url: string }> {
	const variants = [version];
	if (!version.startsWith("v")) variants.push(`v${version}`);
	else variants.push(version.slice(1));

	for (const tag of variants) {
		const url = buildReleaseAssetUrl(repo, file, tag, mirror);
		if (!url) continue;
		try {
			const resp = await netRequest({ url, method: "GET" });
			if (resp.status >= 200 && resp.status < 300) {
				return { ok: true, text: responseText(resp), url };
			}
		} catch {
			/* 继续尝试下一个 tag 变体 */
		}
	}
	return { ok: false, text: "", url: "" };
}

/**
 * 一键安装插件。
 * @param plugin 要安装的插件
 * @returns 安装结果
 */
export async function installCommunityPlugin(
	ctx: ViewContext,
	plugin: PluginInfo
): Promise<InstallResult> {
	const t = ctx.t;

	// 1. 前置校验
	if (!plugin.repo) {
		return fallbackToMarket(ctx, plugin, t("notice.install.noRepo"));
	}
	if (ctx.installedIds.has(plugin.id)) {
		new Notice(t("notice.install.alreadyInstalled"));
		return { ok: false, reason: "已安装" };
	}

	const internals = asAppInternals(ctx.app);
	const plugins: AppPlugins | undefined = internals.plugins;
	if (!plugins) {
		return fallbackToMarket(ctx, plugin, t("notice.install.noPluginManager"));
	}

	// 2. 拉取 manifest（HEAD）拿到版本与入口信息
	const mirror = mirrorConfig(ctx);
	new Notice(t("notice.install.downloading", { name: plugin.name }));
	const manifest = await fetchManifest(plugin.repo, mirror);
	if (!manifest.version) {
		return fallbackToMarket(ctx, plugin, t("notice.install.manifestFail"));
	}

	// 3. 准备目录
	const adapter = ctx.app.vault.adapter as unknown as {
		mkdir?: (path: string) => Promise<unknown>;
		write?: (path: string, data: string) => Promise<unknown>;
	};
	if (typeof adapter.mkdir !== "function" || typeof adapter.write !== "function") {
		return fallbackToMarket(ctx, plugin, t("notice.install.noAdapter"));
	}

	const dir = `${ctx.app.vault.configDir}/plugins/${plugin.id}`;
	try {
		await adapter.mkdir(dir);
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 创建插件目录失败：", e);
		return fallbackToMarket(ctx, plugin, t("notice.install.mkdirFail"));
	}

	// 4. 写 manifest.json
	try {
		await adapter.write(`${dir}/manifest.json`, JSON.stringify(manifest));
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 写入 manifest.json 失败：", e);
		return fallbackToMarket(ctx, plugin, t("notice.install.writeManifestFail"));
	}

	// 5. 下载 main.js（核心入口）
	const mainFile = manifest.main && manifest.main.trim() ? manifest.main.trim() : "main.js";
	const mainAsset = await fetchReleaseAsset(plugin.repo, mainFile, manifest.version, mirror);
	if (!mainAsset.ok) {
		return fallbackToMarket(ctx, plugin, t("notice.install.mainJsFail"));
	}
	try {
		await adapter.write(`${dir}/${mainFile}`, mainAsset.text);
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 写入 main.js 失败：", e);
		return fallbackToMarket(ctx, plugin, t("notice.install.writeMainJsFail"));
	}

	// 6. styles.css 可选（很多插件没有）
	const stylesAsset = await fetchReleaseAsset(plugin.repo, "styles.css", manifest.version, mirror);
	if (stylesAsset.ok && stylesAsset.text) {
		try {
			await adapter.write(`${dir}/styles.css`, stylesAsset.text);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 写入 styles.css 失败：", e);
			/* styles.css 可选，不阻断安装 */
		}
	}

	// 7. 让 Obsidian 识别并启用插件
	try {
		await plugins.loadManifests?.();
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] loadManifests 失败：", e);
	}

	try {
		// loadPlugin 签名在不同版本 Obsidian 中可能不同（id 或 plugin 实例）
		const loadFn = (plugins as unknown as { loadPlugin?: (id: string) => Promise<unknown> }).loadPlugin;
		if (typeof loadFn === "function") await loadFn(plugin.id);
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] loadPlugin 失败：", e);
	}

	try {
		// enablePlugin 可能是 (id) 或 (plugin) 签名
		const enableFn = (plugins as unknown as { enablePlugin?: (id: string) => Promise<unknown> }).enablePlugin;
		if (typeof enableFn === "function") await enableFn(plugin.id);
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] enablePlugin 失败：", e);
	}

	// 8. 刷新本地状态并通知用户
	ctx.snapshotInstalled();
	ctx.scheduleRender(true);

	if (ctx.installedIds.has(plugin.id)) {
		new Notice(t("notice.install.success", { name: plugin.name }));
		return { ok: true };
	}

	// 文件已写入但 Obsidian 未成功加载：提示用户重载
	return fallbackToMarket(
		ctx,
		plugin,
		t("notice.install.needReload", { name: plugin.name }),
		true
	);
}

/**
 * 安装失败时回退到打开 Obsidian 社区市场页面。
 * @param reason 失败原因，用于 Notice
 * @param fileWritten 是否已把文件写入 plugins 目录（用户重载即可用）
 */
function fallbackToMarket(
	ctx: ViewContext,
	plugin: PluginInfo,
	reason: string,
	fileWritten = false
): InstallResult {
	const t = ctx.t;
	new Notice(`${reason}${fileWritten ? t("notice.install.reloadHint") : ""}`);
	try {
		window.open(`obsidian://show-plugin?id=${plugin.id}`, "_self");
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 跳转社区市场失败：", e);
	}
	return { ok: false, reason, fallback: true };
}

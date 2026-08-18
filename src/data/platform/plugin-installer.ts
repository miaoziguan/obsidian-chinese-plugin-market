/**
 * 一键安装社区插件。
 *
 * 实现：不依赖 Obsidian 内置社区市场页面跳转，而是直接下载插件 release 资产
 * （manifest.json / main.js / styles.css）到 vault/.obsidian/plugins/{id}/，
 * 再调用 Obsidian 半官方插件管理 API 刷新 manifest、加载并启用插件。
 *
 * 失败时回退到原行为：打开 obsidian://show-plugin?id= 跳转。
 */

import { Notice, type App } from "obsidian";
import { asAppInternals, type AppPlugins } from "@data/platform/obsidian-internals";

import type { PluginInfo } from "@domain/catalog/translator";
import type { ViewContext } from "@ui/view/view-context";
import { netRequest } from "@data/net/net";
import type { MirrorConfig } from "@domain/catalog/mirror";
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
 * 构造 GitHub Release 资产下载 URL（install 用），并应用镜像映射。
 *
 * 关键：main.js / styles.css 是 build 产物，仅存在于 GitHub Release 资产里，
 * 不在源码树（raw.githubusercontent.com 会 404）。社区插件市场的官方安装方式
 * 就是从 `github.com/{repo}/releases/download/{version}/{file}` 下载。
 *
 * 镜像适配：jsDelivr / custom 仅服务源码树（gh），不支持 release 资产，
 * 故 release 资产统一走 github.com 直连（Obsidian 的 fetch 走系统代理）；
 * ghproxy 源则用 `gh-proxy.com/` 前缀。
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
	const base = `https://github.com/${owner}/${name}/releases/download/${version}/${file}`;
	if (mirror.source === "ghproxy") return `https://gh-proxy.com/${base}`;
	// github / jsdelivr / custom：release 资产直连 github.com
	return base;
}

/**
 * 构造 manifest.json 的 raw URL（与官方社区市场一致，从源码树 HEAD 读取）。
 */
function buildManifestUrl(repo: string, mirror: MirrorConfig): string {
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return "";
	const [owner, name] = parts;
	const base = `https://raw.githubusercontent.com/${owner}/${name}/HEAD/manifest.json`;
	if (mirror.source === "ghproxy") return `https://gh-proxy.com/${base}`;
	if (mirror.source === "jsdelivr") {
		return `https://cdn.jsdelivr.net/gh/${owner}/${name}@HEAD/manifest.json`;
	}
	if (mirror.source === "custom" && mirror.customBase) {
		const withSlash = mirror.customBase.replace(/\/$/, "");
		return `${withSlash}/${owner}/${name}/HEAD/manifest.json`;
	}
	return base;
}

/** 完整插件 manifest（安装时必须原样保留所有字段，否则 Obsidian 会忽略该插件）。 */
interface FullPluginManifest {
	id: string;
	name: string;
	version: string;
	minAppVersion?: string;
	main?: string;
	description?: string;
	author?: string;
	authorUrl?: string;
	isDesktopOnly?: boolean;
	// 允许官方 manifest 中的其他字段透传
	[key: string]: unknown;
}

/**
 * 下载完整 manifest.json（不精简字段，与官方安装行为一致）。
 * 官方社区市场也是从 raw.githubusercontent.com/{repo}/HEAD/manifest.json 读取 manifest。
 */
async function downloadFullManifest(
	repo: string,
	mirror: MirrorConfig
): Promise<FullPluginManifest | null> {
	const url = buildManifestUrl(repo, mirror);
	if (!url) return null;
	try {
		const resp = await netRequest({ url, method: "GET" });
		if (resp.status < 200 || resp.status >= 300) return null;
		const json = resp.json;
		if (!json || typeof json !== "object") return null;
		// 仅 id/name/version 为真正必需字段；minAppVersion 官方容忍缺失（视为兼容所有版本），
		// 但写入磁盘时为兼容 Obsidian 扫描，缺失时补默认 "1.0.0"。
		if (
			typeof (json as FullPluginManifest).id !== "string" ||
			typeof (json as FullPluginManifest).name !== "string" ||
			typeof (json as FullPluginManifest).version !== "string"
		) {
			logger.warn("[Chinese Plugin Market] manifest.json 缺少必要字段：", json);
			return null;
		}
		const manifest = json as FullPluginManifest;
		if (typeof manifest.minAppVersion !== "string") {
			manifest.minAppVersion = "1.0.0";
		}
		return manifest;
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 下载 manifest.json 失败：", e);
		return null;
	}
}

/**
 * 取 Node 内置 https 模块（桌面端可用，移动端无）。
 * Obsidian 渲染进程暴露 window.require，与 installed-watch.ts 用 require("fs") 同理。
 * 用 Node https 发请求可同时绕开两个坑：
 *   - CORS：渲染进程 fetch 受 app://obsidian.md 的 CORS 限制，github release 资产不带 ACAO 头；
 *   - JSON 解析：Obsidian requestUrl 对 JS 文本响应会尝试 JSON.parse 而抛错。
 * Node https 返回原始文本，且不受 CORS 约束。
 */
function getNodeHttps(): { get: (url: string, opts: unknown, cb: (res: unknown) => void) => { on: (e: string, cb: (err: Error) => void) => void } } | null {
	const req = (window as unknown as { require?: (id: string) => unknown }).require;
	if (!req) return null;
	try {
		return req("https") as never;
	} catch {
		return null;
	}
}

/**
 * 用 Node https 下载（桌面端主路径）。手动跟随 302 → release-assets CDN，
 * 取响应原始文本（utf8，Accept-Encoding: identity 避免 gzip）。最多 5 跳防环。
 *
 * 关键修复：Node https 在 socket 级错误（ECONNRESET / socket hang up）或连接半开时，
 * 错误事件可能未可靠转发到 ClientRequest 的 "error"，导致 Promise 永久 pending
 * （既不 resolve 也不 reject）→ 上层 installing 状态卡死。这里加：
 *   1) 全链路 error 兜底（req.error + socket.error）；
 *   2) 15s 连接/读取超时，超时主动 destroy 并判定失败；
 * 确保任何失败都在有限时间内明确 resolve({ok:false})，不挂起。
 */
function nodeDownload(url: string, depth = 0): Promise<{ ok: boolean; text: string; finalUrl: string }> {
	return new Promise((resolve) => {
		const https = getNodeHttps();
		if (!https || depth > 5) {
			resolve({ ok: false, text: "", finalUrl: url });
			return;
		}
		// 标记已结束，避免超时/错误/正常完成竞态下重复 resolve
		let settled = false;
		const fail = (msg: string) => {
			if (settled) return;
			settled = true;
			logger.warn(`[Chinese Plugin Market] Node 下载失败：${msg} @ ${url}`);
			resolve({ ok: false, text: "", finalUrl: url });
		};

		type NodeReq = {
			on: (e: string, cb: (arg?: unknown) => void) => void;
			setTimeout: (ms: number, cb?: () => void) => void;
			destroy: () => void;
		};
		let req: NodeReq | null = null;
		try {
			req = https.get(
				url,
				{
					headers: {
						"Accept-Encoding": "identity",
						"User-Agent": "obsidian-chinese-plugin-market",
					},
				},
				(res: {
					statusCode?: number;
					headers: Record<string, string>;
					setEncoding: (e: string) => void;
					on: (e: string, cb: (d: string | Error) => void) => void;
					resume: () => void;
				}) => {
					const code = res.statusCode ?? 0;
					// 3xx：手动跟随 Location
					if (code >= 300 && code < 400 && res.headers.location) {
						res.resume();
						const next = new URL(res.headers.location, url).toString();
						logger.debug(`[Chinese Plugin Market] Node 下载跟随重定向 ${code}: ${url} → ${next}`);
						if (settled) return;
						settled = true;
						resolve(nodeDownload(next, depth + 1));
						return;
					}
					if (code !== 200) {
						res.resume();
						fail(`HTTP ${code}`);
						return;
					}
					let data = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => { data += chunk; });
					res.on("end", () => {
						if (settled) return;
						settled = true;
						resolve({ ok: true, text: data, finalUrl: url });
					});
					// 响应体读取阶段也可能出错（连接中途断开）
					res.on("error", (e: Error) => fail(e.message));
				}
			) as NodeReq;
		} catch (e: unknown) {
			const msg = e instanceof Error ? e.message : String(e);
			fail(msg);
			return;
		}

		if (req) {
			// req 级错误（含 socket hang up 转发的 ECONNRESET）
			req.on("error", (e: Error) => fail(e.message));
			// 超时兜底：连接或读取超过 15s 视为失败，主动销毁避免半开挂起
			req.setTimeout(15_000, () => {
				fail("timeout 15s");
				try { req.destroy(); } catch { /* 已结束 */ }
			});
		} else {
			fail("https.get 返回空（运行时不支持）");
		}
	});
}

/**
 * 单次下载：优先 Obsidian requestUrl（走 Electron 主进程，跟随系统代理、不受 CORS 限制，
 * 是官方社区市场下载的同源通道，对用户网络环境最可靠），Node https 作为兜底
 * （某些环境下 requestUrl 对文本响应会尝试 JSON.parse 而抛错，Node https 返回原始文本更稳）。
 */
async function downloadWithRedirect(
	url: string
): Promise<{ ok: boolean; text: string; finalUrl: string }> {
	// 主路径：requestUrl（跟随系统代理，可访问 github）
	try {
		const resp = await netRequest({ url, method: "GET" });
		if (resp.status >= 200 && resp.status < 300) {
			return { ok: true, text: typeof resp.text === "string" ? resp.text : "", finalUrl: url };
		}
		logger.debug(`[Chinese Plugin Market] requestUrl HTTP ${resp.status} @ ${url}`);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.debug(`[Chinese Plugin Market] requestUrl 异常：${msg} @ ${url}`);
	}

	// 兜底：Node https（返回原始文本，绕开 requestUrl 的 JSON.parse 行为）
	const nodeRes = await nodeDownload(url);
	if (nodeRes.ok) return nodeRes;

	return { ok: false, text: "", finalUrl: url };
}

/**
 * 尝试多种 tag 变体 + 镜像兜底下载 release 资产（先 version，再 v{version}）。
 * 某些社区插件的 release tag 带 "v" 前缀，而 manifest.version 不带。
 * 按顺序：① 用户镜像构造（github 直连 / ghproxy 前缀）② gh-proxy.com 公共兜底。
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

	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2) return { ok: false, text: "", url: "" };
	const [owner, name] = parts;
	const githubDirect = (tag: string) =>
		`https://github.com/${owner}/${name}/releases/download/${tag}/${file}`;

	for (const tag of variants) {
		const candidates: string[] = [];
		const primary = buildReleaseAssetUrl(repo, file, tag, mirror);
		if (primary) candidates.push(primary);
		// 公共代理兜底（仅 gh-proxy.com 仍可能可用；ghproxy.net / mirror.ghproxy.com 已失效）
		const direct = githubDirect(tag);
		const ghproxyFallback = `https://gh-proxy.com/${direct}`;
		if (primary !== ghproxyFallback) candidates.push(ghproxyFallback);

		for (const url of candidates) {
			const r = await downloadWithRedirect(url);
			if (r.ok) return { ok: true, text: r.text, url: r.finalUrl };
			logger.debug(`[Chinese Plugin Market] 下载 ${file} 候选失败 @ ${url}`);
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

	// 2. 拉取完整 manifest（HEAD）拿到版本与入口信息；写入磁盘时必须保留所有字段
	const mirror = mirrorConfig(ctx);
	new Notice(t("notice.install.downloading", { name: plugin.name }));
	const manifest = await downloadFullManifest(plugin.repo, mirror);
	if (!manifest) {
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

	// 6. styles.css 可选（很多插件没有；GitHub 返回 404 属正常，静默跳过）
	const stylesAsset = await fetchReleaseAsset(plugin.repo, "styles.css", manifest.version, mirror);
	if (stylesAsset.ok && stylesAsset.text && stylesAsset.text.trim()) {
		try {
			await adapter.write(`${dir}/styles.css`, stylesAsset.text);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 写入 styles.css 失败：", e);
			/* styles.css 可选，不阻断安装 */
		}
	} else {
		logger.debug("[Chinese Plugin Market] 跳过 styles.css（插件未提供或 404）");
	}

	// 6.5 关键：把 id 写入 vault 本地的 community-plugins.json。
	// 这是 Obsidian 启动时判定「哪些插件已安装、需要加载」的唯一真相源。
	// 只写 app.json.enabledPlugins 而不写它，重启后 Obsidian 不会加载该插件，
	// 导致刚装/刚启用的插件「重启后变关」。官方社区市场安装时正是同时维护两者。
	await syncCommunityPluginsJson(ctx, plugin.id, true);

	// 7. 让 Obsidian 识别并启用插件（与官方社区市场安装流程保持一致）。
	// 官方顺序：loadManifests() → enablePlugin(manifest)。
	// 由于 Obsidian 版本间签名差异较大，这里做多重兼容尝试；
	// 只要文件写入成功，即便启用失败也视为「安装成功」，提示用户手动开启即可。
	let recognized = false;
	let enabled = false;
	try {
		await plugins.loadManifests?.call(plugins);
		// 给 Obsidian 一点时间完成磁盘扫描与内部状态更新
		await new Promise((r) => window.setTimeout(r, 50));
		recognized = Boolean(plugins.manifests?.[plugin.id]);
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] loadManifests 失败：", e);
	}

	if (recognized) {
		enabled = await tryEnablePlugin(ctx, plugins, plugin.id);
	}

	// 8. 刷新本地状态并通知用户
	// 真正清除 installingIds 的调用方在 view-cards.ts 的 finally 里，那里会同步删除并刷新。
	ctx.snapshotInstalled();
	ctx.refreshCardState(plugin.id);
	ctx.scheduleRender(true);

	if (enabled) {
		new Notice(t("notice.install.success", { name: plugin.name }));
		return { ok: true };
	}

	if (recognized) {
		// 文件已写入且 Obsidian 已识别，只是未能自动启用
		new Notice(t("notice.install.manualEnable", { name: plugin.name }));
		return { ok: true };
	}

	// 文件已写入但 Obsidian 未识别：提示重载
	return fallbackToMarket(
		ctx,
		plugin,
		t("notice.install.needReload", { name: plugin.name }),
		true
	);
}

/**
 * 启用插件。
 *
 * 1.13 行为实测（见 issue 排查）：官方 `app.plugins.enablePlugin(id)` 在非用户交互上下文
 * （非设置面板点开关）下会返回 `true` 但**不真正把 id 加进运行时 enabledPlugins、也不持久化**——
 * 它仅启动了一个异步加载（内部置 loadingPluginId），同步检查 isEnabled() 永远为 false。
 * 因此这里采用「官方 enablePlugin 触发加载 + 显式维护 enabledPlugins + 写 app.json」双轨策略：
 *   1) 调 enablePlugin/loadPlugin 让 Obsidian 真正加载插件实例；
 *   2) 显式把 id 加进运行时 enabledPlugins（本次会话 UI 立即显示启用）；
 *   3) 写 app.json.enabledPlugins（重启后 Obsidian 读它重新加载，保证持久化）。
 */
async function tryEnablePlugin(
	ctx: ViewContext,
	plugins: AppPlugins,
	id: string
): Promise<boolean> {
	const manifestEntry = plugins.manifests?.[id];
	const enableFn = plugins.enablePlugin?.bind(plugins);
	const enableSaveFn = plugins.enablePluginAndSave?.bind(plugins);
	const loadFn = plugins.loadPlugin?.bind(plugins);
	logger.debug(`[Chinese Plugin Market] tryEnable: enablePlugin=${typeof enableFn} enablePluginAndSave=${typeof enableSaveFn} loadPlugin=${typeof loadFn} manifestEntry=${Boolean(manifestEntry)}`);

	const isEnabled = () => Boolean(plugins.enabledPlugins?.has?.(id));

	// 主路径：优先官方 enablePluginAndSave（内部写 community-plugins.json，重启后保持启用）。
	// 注意：enablePluginAndSave / disablePluginAndSave 官方签名接受【字符串 id】，
	// 传 manifest 对象会静默失败（曾实证：传 manifestEntry 后 enabledPlugins.has 仍为 false）。
	// 缺失时回退 enablePlugin 触发加载（manifest 或 id 两种签名都试），不据此判定成功。
	try {
		if (typeof enableSaveFn === "function") {
			await enableSaveFn(id);
		} else if (typeof enableFn === "function" && manifestEntry) {
			await enableFn(manifestEntry);
		} else if (typeof enableFn === "function") {
			await enableFn(id);
		}
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("[Chinese Plugin Market] enablePlugin(AndSave) 调用异常（继续手动维护）：", msg);
	}

	// 让事件循环推进，给 enablePlugin 内部异步加载一点时间
	await new Promise((r) => window.setTimeout(r, 60));
	if (isEnabled()) {
		// 官方已成功启用：双写两个真相源持久化（1.13 非交互调用不自动持久化）。
		// community-plugins.json（已安装集）必须包含该 id，否则重启后 Obsidian
		// 不会把它纳入「已安装∩启用」加载交集，启用状态无法持久化。
		await syncCommunityPluginsJson(ctx, id, true);
		await persistEnabledPlugins(ctx, id);
		return true;
	}

	// 官方未启用（1.13 非交互早退）：显式把 id 加入运行时 enabledPlugins 并写 app.json。
	const ep = plugins.enabledPlugins as unknown as Set<string> | string[] | undefined;
	let added = false;
	if (ep) {
		if (Array.isArray(ep)) {
			if (!ep.includes(id)) ep.push(id);
			added = true;
		} else if (typeof ep.add === "function") {
			ep.add(id);
			added = true;
		}
	}
	// 确保插件实例已加载（enablePlugin 异步可能尚未完成，主动 loadPlugin 兜底）
	if (typeof loadFn === "function") {
		try {
			await loadFn(manifestEntry ?? id);
		} catch {
			/* loadPlugin 可能已加载或签名差异，忽略 */
		}
	}
	if (added) {
		// 双写：community-plugins.json（已安装集）+ app.json.enabledPlugins（启用集）。
		// 只写 app.json 不写 community-plugins.json 是此前「重启后变关」的根因——
		// Obsidian 启动只加载两者交集，缺已安装清单则不加载。
		await syncCommunityPluginsJson(ctx, id, true);
		await persistEnabledPlugins(ctx, id);
		logger.debug(`[Chinese Plugin Market] 已显式启用 ${id} 并持久化（community-plugins.json + app.json）`);
		return true;
	}
	logger.warn(`[Chinese Plugin Market] enabledPlugins 类型不可写入：${Object.prototype.toString.call(ep)}`);
	return false;
}

/**
 * 禁用单个插件（与 tryEnablePlugin 对称）。
 * 1.13 非交互上下文下官方 disablePlugin 可能返回 true 却不真正把 id 从运行时
 * enabledPlugins 移除（与 enable 早退对称），故显式从内存移除并双写两个真相源。
 * @returns 是否成功（内存或持久化任一生效即算成功）
 */
async function tryDisablePlugin(
	ctx: ViewContext,
	plugins: AppPlugins,
	id: string
): Promise<boolean> {
	// 优先官方 disablePluginAndSave（写 community-plugins.json 持久化，重启后保持禁用）；
	// disablePlugin 只改内存不写盘，是「重启后禁用失效」的根因之一。
	try {
		if (typeof plugins.disablePluginAndSave?.call === "function") {
			await plugins.disablePluginAndSave.call(plugins, id);
		} else {
			await plugins.disablePlugin?.call(plugins, id);
		}
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] disablePlugin(AndSave) 调用异常（继续手动维护）：", e instanceof Error ? e.message : String(e));
	}
	// 让事件循环推进
	await new Promise((r) => window.setTimeout(r, 30));
	const ep = plugins.enabledPlugins as unknown as Set<string> | string[] | undefined;
	let removed = false;
	if (ep && typeof (ep as Set<string>).delete === "function") {
		(ep as Set<string>).delete(id);
		removed = true;
	} else if (Array.isArray(ep)) {
		const idx = ep.indexOf(id);
		if (idx >= 0) { ep.splice(idx, 1); removed = true; }
	}
	if (removed) {
		// 双写：community-plugins.json（已安装集）+ app.json.enabledPlugins（启用集）
		await syncCommunityPluginsJson(ctx, id, false);
		await removeEnabledPlugin(ctx, id);
		logger.debug(`[Chinese Plugin Market] 已显式禁用 ${id} 并持久化`);
		return true;
	}
	logger.warn(`[Chinese Plugin Market] enabledPlugins 类型不可写入（disable ${id}）`);
	return false;
}

/**
 * 应用一个「启用组合 Profile」的核心逻辑（不依赖视图上下文）。
 * 把当前启用集切换为 target（命名快照），自动 diff 出 toEnable / toDisable 并逐个应用，
 * 且**永远排除 selfId**（Chinese Market 自身不能被任何 profile 误关，否则市场打不开需手动救）。
 *
 * @param app        Obsidian App（读 app.plugins、写盘）
 * @param current   当前启用的插件 id 集合（由调用方从 app.plugins.enabledPlugins 或 ctx.enabledIds 提供）
 * @param target     目标启用插件 id 集合（profile 内容）
 * @param selfId     本插件 id（chinese-plugin-market），从 toDisable 中排除
 * @returns 实际启用/禁用计数，供 UI 通知
 */
export async function applyProfileByIds(
	app: App,
	current: Set<string>,
	target: Set<string>,
	selfId: string
): Promise<{ enabled: number; disabled: number }> {
	const plugins = asAppInternals(app).plugins;
	if (!plugins) return { enabled: 0, disabled: 0 };
	// 刷新 manifests，确保待启用的插件已被 Obsidian 识别（否则 enablePlugin 无 manifest 可加载）
	try {
		await plugins.loadManifests?.call(plugins);
	} catch {
		/* manifest 扫描失败不阻断，下方按 manifests 存在性兜底 */
	}
	const toEnable = [...target].filter(
		(id) => !current.has(id) && id !== selfId && Boolean(plugins.manifests?.[id])
	);
	const toDisable = [...current].filter((id) => !target.has(id) && id !== selfId);

	// try* 函数只用到 ctx.app（写盘），构造最小伪 ctx 透传 app
	const fakeCtx = { app } as unknown as ViewContext;
	let enabled = 0;
	let disabled = 0;
	// 逐个 await 应用：Obsidian 1.13 非交互上下文启用/禁用含异步加载，
	// 并发易触发内部 loadingPluginId 竞态，逐个更稳。
	for (const id of toEnable) {
		if (await tryEnablePlugin(fakeCtx, plugins, id)) enabled++;
	}
	for (const id of toDisable) {
		if (await tryDisablePlugin(fakeCtx, plugins, id)) disabled++;
	}
	return { enabled, disabled };
}

/**
 * 视图上下文便捷封装：应用 Profile 后刷新卡片启用态。
 * @see applyProfileByIds
 */
export async function applyEnabledProfile(
	ctx: ViewContext,
	target: Set<string>,
	selfId: string
): Promise<{ enabled: number; disabled: number }> {
	const r = await applyProfileByIds(ctx.app, ctx.enabledIds, target, selfId);
	ctx.snapshotInstalled();
	ctx.invalidateAndRender(true);
	return r;
}

/**
 * 同步 vault 本地的 `.obsidian/community-plugins.json`。
 * 这是 Obsidian 启动时判定「哪些插件已安装、需要加载」的唯一真相源——
 * 只写 `app.json.enabledPlugins` 而不写它，重启后 Obsidian 不会去加载该插件，
 * 导致启用状态「无法持久化」。官方社区市场安装插件时正是同时维护这两个文件。
 * @param add true=把 id 追加进清单；false=从清单移除
 */
async function syncCommunityPluginsJson(
	ctx: ViewContext,
	id: string,
	add: boolean
): Promise<void> {
	try {
		const adapter = ctx.app.vault.adapter as unknown as {
			read?: (path: string) => Promise<string>;
			write?: (path: string, data: string) => Promise<unknown>;
		};
		if (typeof adapter.read !== "function" || typeof adapter.write !== "function") return;
		const path = `${ctx.app.vault.configDir}/community-plugins.json`;
		let list: string[] = [];
		try {
			const raw = await adapter.read(path);
			const parsed: unknown = JSON.parse(raw);
			if (Array.isArray(parsed)) list = parsed as string[];
		} catch {
			/* 文件不存在或损坏则用空数组 */
		}
		const has = list.includes(id);
		if (add && !has) {
			list.push(id);
			await adapter.write(path, JSON.stringify(list));
			logger.debug(`[Chinese Plugin Market] 已把 ${id} 写入 community-plugins.json`);
		} else if (!add && has) {
			list = list.filter((x) => x !== id);
			await adapter.write(path, JSON.stringify(list));
			logger.debug(`[Chinese Plugin Market] 已从 community-plugins.json 移除 ${id}`);
		}
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 同步 community-plugins.json 失败：", e);
	}
}

/**
 * 把 id 追加进 app.json.enabledPlugins 并写盘。
 * 1.13 下官方 enablePlugin 在非交互上下文不自动持久化，需我们显式写盘，
 * 确保重启后 Obsidian 读 app.json 重新加载该插件。
 */
async function persistEnabledPlugins(ctx: ViewContext, id: string): Promise<void> {
	try {
		const adapter = ctx.app.vault.adapter as unknown as {
			read?: (path: string) => Promise<string>;
			write?: (path: string, data: string) => Promise<unknown>;
		};
		if (typeof adapter.read !== "function" || typeof adapter.write !== "function") return;
		const appJsonPath = `${ctx.app.vault.configDir}/app.json`;
		let appJson: Record<string, unknown> = {};
		try {
			const raw = await adapter.read(appJsonPath);
			appJson = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			/* app.json 不存在则用空对象 */
		}
		const enabled = Array.isArray(appJson.enabledPlugins)
			? (appJson.enabledPlugins as string[])
			: [];
		if (!enabled.includes(id)) {
			enabled.push(id);
			appJson.enabledPlugins = enabled;
			await adapter.write(appJsonPath, JSON.stringify(appJson, null, 2));
			logger.debug(`[Chinese Plugin Market] 已持久化 ${id} 到 app.json.enabledPlugins`);
		}
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 持久化 enabledPlugins 失败：", e);
	}
}

/**
 * 把 id 从 app.json.enabledPlugins 中移除并写盘（持久化禁用状态，重启后保持）。
 */
async function removeEnabledPlugin(ctx: ViewContext, id: string): Promise<void> {
	try {
		const adapter = ctx.app.vault.adapter as unknown as {
			read?: (path: string) => Promise<string>;
			write?: (path: string, data: string) => Promise<unknown>;
		};
		if (typeof adapter.read !== "function" || typeof adapter.write !== "function") return;
		const appJsonPath = `${ctx.app.vault.configDir}/app.json`;
		let appJson: Record<string, unknown> = {};
		try {
			const raw = await adapter.read(appJsonPath);
			appJson = JSON.parse(raw) as Record<string, unknown>;
		} catch {
			/* app.json 不存在则用空对象 */
		}
		const enabled = Array.isArray(appJson.enabledPlugins)
			? (appJson.enabledPlugins as string[])
			: [];
		if (enabled.includes(id)) {
			appJson.enabledPlugins = enabled.filter((x) => x !== id);
			await adapter.write(appJsonPath, JSON.stringify(appJson, null, 2));
			logger.debug(`[Chinese Plugin Market] 已从 app.json.enabledPlugins 移除 ${id}`);
		}
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 持久化禁用状态失败：", e);
	}
}

/**
 * 卸载一个已安装的插件（对应卡片「卸载」按钮）。
 * 顺序与官方社区市场一致：
 *   1. 若仍在启用，先 disablePlugin 并清 app.json.enabledPlugins；
 *   2. 删除磁盘 `.obsidian/plugins/<id>/` 目录；
 *   3. 从 community-plugins.json 移除 id（否则重启后 Obsidian 仍会尝试加载已删除的目录）。
 * @returns 是否卸载成功
 */
export async function uninstallCommunityPlugin(
	ctx: ViewContext,
	plugin: PluginInfo
): Promise<boolean> {
	const t = ctx.t;
	const adapter = ctx.app.vault.adapter as unknown as {
		rmdir?: (path: string, recursive: boolean) => Promise<unknown>;
	};
	const internals = asAppInternals(ctx.app);
	const plugins = internals.plugins;

	// 1. 若启用中，先禁用（官方 disablePlugin 会自行更新内存并持久化到 app.json）
	if (plugins?.enabledPlugins?.has?.(plugin.id)) {
		try {
			await plugins.disablePlugin?.call(plugins, plugin.id);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 卸载前 disablePlugin 失败：", e);
		}
		// 1.5 双轨兜底：Obsidian 1.13 下 disablePlugin 在非交互上下文可能返回 true
		// 却不真正把 id 从内存 enabledPlugins 移除（与 enablePlugin 早退对称），
		// 导致卸载后 enabledIds 仍含该 id、卡片仍显示「已启用」、状态不切回。
		// 显式从运行时 enabledPlugins 移除（与 tryEnablePlugin 显式 add 对称）。
		const ep = plugins?.enabledPlugins as unknown as Set<string> | string[] | undefined;
		if (ep && typeof (ep as Set<string>).delete === "function") {
			(ep as Set<string>).delete(plugin.id);
		} else if (Array.isArray(ep)) {
			const idx = ep.indexOf(plugin.id);
			if (idx >= 0) ep.splice(idx, 1);
		}
	}

	// 2. 删除磁盘目录
	if (typeof adapter.rmdir !== "function") {
		new Notice(t("card.uninstall.fail", { name: plugin.name, reason: "adapter.rmdir 不可用" }));
		return false;
	}
	const dir = `${ctx.app.vault.configDir}/plugins/${plugin.id}`;
	try {
		await adapter.rmdir(dir, true);
	} catch (e: unknown) {
		const msg = e instanceof Error ? e.message : String(e);
		logger.warn("[Chinese Plugin Market] 删除插件目录失败：", e);
		new Notice(t("card.uninstall.fail", { name: plugin.name, reason: msg }));
		return false;
	}

	// 3. 从 community-plugins.json 移除（关键：否则重启后仍会被视为已安装）
	await syncCommunityPluginsJson(ctx, plugin.id, false);

	// 3.5 强制 Obsidian 重新扫描磁盘 manifest：删除目录后 plugins.manifests（内存 Map）
	// 不会自动移除已删插件，若直接 snapshotInstalled 读到的仍是旧 manifests，
	// installedIds 仍含该 id → 卡片卸载后仍显示「已安装/已启用」，状态不切回。
	// 官方社区市场卸载后同样依赖 loadManifests 刷新；加错误兜底避免内部 API 挂死。
	try {
		await plugins?.loadManifests?.call(plugins);
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 卸载后 loadManifests 失败（降级继续）：", e);
	}

	logger.debug(`[Chinese Plugin Market] 已卸载插件 ${plugin.id}`);
	ctx.snapshotInstalled();
	ctx.refreshCardState(plugin.id);
	return true;
}

/**
 * 切换插件的启用/禁用状态（卡片「已启用/已禁用」按钮）。
 * 已启用 → 禁用；已禁用 → 启用。与官方社区市场开关行为一致。
 * @returns 切换后是否处于启用状态
 */
export async function togglePluginEnabled(
	ctx: ViewContext,
	plugin: PluginInfo
): Promise<boolean> {
	const t = ctx.t;
	const internals = asAppInternals(ctx.app);
	const plugins = internals.plugins;
	if (!plugins) return ctx.enabledIds.has(plugin.id);

	const disableFn = plugins.disablePlugin?.bind(plugins);
	const isEnabled = () => Boolean(plugins.enabledPlugins?.has?.(plugin.id));

	if (isEnabled()) {
		// 当前启用 → 禁用。
		// 社区插件持久化的真相源是 community-plugins.json，而非 app.json.enabledPlugins（核心插件用）。
		// 因此优先走官方 disablePluginAndSave(id)（内部会写 community-plugins.json，重启后保持禁用），
		// disablePlugin(id) 只改内存不写盘，是此前「重启后禁用失效」的根因。
		let disabled = false;
		const disableSaveFn = plugins.disablePluginAndSave?.bind(plugins);
		if (typeof disableSaveFn === "function") {
			try {
				await disableSaveFn(plugin.id);
			} catch (e: unknown) {
				logger.warn("[Chinese Plugin Market] disablePluginAndSave(id) 失败：", e);
			}
		} else if (typeof disableFn === "function") {
			try {
				await disableFn(plugin.id);
			} catch (e: unknown) {
				logger.warn("[Chinese Plugin Market] disablePlugin(id) 失败：", e);
			}
		}
		// 1.13 下禁用可能不真正从内存移除，显式维护运行时 Set
		const ep = plugins.enabledPlugins as unknown as Set<string> | undefined;
		if (ep && typeof ep.delete === "function") {
			ep.delete(plugin.id);
			disabled = true;
		}
		if (disabled) {
			// 兜底双写：从 community-plugins.json 移除（官方 API 未写盘时的保障），
			// 并从 app.json.enabledPlugins 移除（历史版本曾错误地把社区插件写进 app.json，清理残留）。
			await syncCommunityPluginsJson(ctx, plugin.id, false);
			await removeEnabledPlugin(ctx, plugin.id);
			new Notice(t("notice.install.disabled", { name: plugin.name }));
			ctx.snapshotInstalled();
			ctx.refreshCardState(plugin.id);
			return false;
		}
		new Notice(t("notice.install.disableFail", { name: plugin.name }));
		return true;
	}

	// 当前禁用 → 启用
	const enabled = await tryEnablePlugin(ctx, plugins, plugin.id);
	if (enabled) {
		new Notice(t("notice.install.success", { name: plugin.name }));
		ctx.snapshotInstalled();
		ctx.refreshCardState(plugin.id);
		return true;
	}
	new Notice(t("notice.install.manualEnable", { name: plugin.name }));
	ctx.snapshotInstalled();
	ctx.refreshCardState(plugin.id);
	return false;
}

/**
 * 安装失败时回退到打开 Obsidian 社区市场页面。
 * 仅在网络/写入失败时跳转；文件已写入时改为提示用户手动开启或重载。
 */
function fallbackToMarket(
	ctx: ViewContext,
	plugin: PluginInfo,
	reason: string,
	fileWritten = false
): InstallResult {
	const t = ctx.t;
	new Notice(`${reason}${fileWritten ? t("notice.install.reloadHint") : ""}`);
	if (fileWritten) {
		// 文件已写入 plugins 目录，用户重载即可使用，无需跳转社区市场
		return { ok: false, reason, fallback: false };
	}
	try {
		window.open(`obsidian://show-plugin?id=${plugin.id}`, "_self");
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 跳转社区市场失败：", e);
	}
	return { ok: false, reason, fallback: true };
}

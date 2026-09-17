/**
 * 直链安装：从「按路径摊开放三件套」的目录 URL 安装另一个插件。
 *
 * 设计取舍（借鉴 notesynchelper/chinabrat，MIT）：
 * - 刻意不走 zip：源站把 manifest.json / main.js / styles.css 按路径摊开放，
 *   客户端就退化成三个 GET，无需任何解压依赖，且每个文件都能被 CDN 分别缓存。
 * - 安装前做完整安全校验，写盘不可逆。
 * - 装完确认 Obsidian 真的加载起来，不假报成功。
 *
 * 仅用半官方 app.plugins 内部 API（loadManifests / disablePlugin / enablePluginAndSave），
 * 与 BRAT / chinabrat 一致；其余皆公开 API（requestUrl / vault.adapter / requireApiVersion）。
 */

import { Modal, Notice, Setting, type App, requestUrl, requireApiVersion } from "obsidian";
import { makeT } from "@shared/i18n";
import { asAppInternals } from "@data/platform/obsidian-internals";

const t = makeT();

/** 一个插件的三件套，顺序固定；styles.css 允许缺失 */
const FILES = ["manifest.json", "main.js", "styles.css"] as const;

export interface Manifest {
	id: string;
	name?: string;
	version: string;
	minAppVersion?: string;
}

/** 安装来源解析结果 */
export interface SourceSpec {
	/** 三件套所在目录 URL（raw.githubusercontent 或普通目录） */
	root: URL;
	/** GitHub 仓库引用；非 GitHub 源为 null */
	gh: { owner: string; repo: string } | null;
	/** true = 三件套优先从 GitHub Release 资产取（源码树里没有构建产物） */
	release: boolean;
	/** 钉住的 release tag（来自 /releases/tag/<tag> 或 /releases/download/<tag>/...） */
	releaseTag?: string;
}

function rawRoot(gh: { owner: string; repo: string }, ref: string): URL {
	return new URL(`https://raw.githubusercontent.com/${gh.owner}/${gh.repo}/${ref}/`);
}

/**
 * 从目录直链安装：取三件套 → 写盘 → 加载并启用，返回它的 manifest。
 * 不做解压。抛错即代表安装失败（调用方负责 Notice）。
 */
/**
 * 解析安装来源（P1：支持钉选分支 / 标签 / commit，以及从 Release 安装）。
 * 支持：
 *   1) 裸目录 URL / 指向 manifest.json 的完整链接 → 目录
 *   2) GitHub 简写：owner/repo、owner/repo@<branch|tag|commit>、owner/repo@release|latest
 *   3) GitHub 网页 URL：仓库、/tree/<branch>、/blob/<branch>/...、.git
 *   4) GitHub Release 链接：/releases、/releases/latest、/releases/tag/<tag>、/releases/download/<tag>/x
 *   5) raw.githubusercontent.com 直链（跟踪表里的 rootUrl 即此形态）
 * @ 后的 ref 可为分支名（含 /）、标签或 commit SHA；release/latest 表示改从 Release 资产安装。
 */
export function parseSourceSpec(input: string): SourceSpec {
	const trimmed = input.trim();
	// 便利：粘贴 github.com/owner/repo（无 scheme）自动补 https
	const withScheme = /^(github\.com|raw\.githubusercontent\.com)\//i.test(trimmed)
		? `https://${trimmed}`
		: trimmed;
	// GitHub 简写 owner/repo[@ref]。owner 限定 [\w-]+（GitHub 用户名不含点），
	// 以免把 "example.com/myplugin" 这类无 scheme 的网址误判成仓库简写。
	const short = /^([\w-]+)\/([\w.-]+?)(?:\.git)?(?:@([\w./-]+))?$/.exec(withScheme);
	if (short) {
		const gh = { owner: short[1], repo: short[2] };
		const ref = short[3];
		if (ref === "release" || ref === "latest") {
			return { root: rawRoot(gh, "HEAD"), gh, release: true };
		}
		return { root: rawRoot(gh, ref || "HEAD"), gh, release: false };
	}
	let u: URL;
	try {
		u = new URL(withScheme);
	} catch {
		throw new Error(t("directInstall.badUrl"));
	}
	// 装什么就等于执行什么，明文 http 会被同网段的人换掉；只给本机开发放行
	const dev = u.protocol === "http:" && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname);
	if (u.protocol !== "https:" && !dev) throw new Error(t("directInstall.needHttps"));
	u.hash = "";

	// GitHub：仓库/分支/blob 链接 → 重写到 raw.githubusercontent.com（默认分支用 HEAD）
	if (u.hostname === "github.com") {
		const parts = u.pathname.split("/").filter(Boolean);
		if (parts.length < 2) throw new Error(t("directInstall.badUrl"));
		const owner = parts[0];
		let repo = parts[1];
		if (repo.endsWith(".git")) repo = repo.slice(0, -4);
		if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) {
			throw new Error(t("directInstall.badUrl"));
		}
		const gh = { owner, repo };
		// Release 链接：构建产物只挂在 Release 上，源码树里没有
		if (parts[2] === "releases") {
			const sub = parts[3];
			if ((sub === "tag" || sub === "download") && parts[4]) {
				const tag = parts[4];
				if (/[#?\s]/.test(tag)) throw new Error(t("directInstall.badUrl"));
				return { root: rawRoot(gh, tag), gh, release: true, releaseTag: tag };
			}
			// /releases 或 /releases/latest
			return { root: rawRoot(gh, "HEAD"), gh, release: true };
		}
		let branch = "HEAD";
		const sub = parts[2];
		if (sub === "tree") {
			const b = parts.slice(3).join("/");
			if (b) branch = b;
		} else if (sub === "blob" && parts[3]) {
			branch = parts[3];
		}
		// branch 里出现 #/?/空白 会让 URL 解析错位，提前拒绝
		if (/[#?\s]/.test(branch)) throw new Error(t("directInstall.badUrl"));
		const raw = rawRoot(gh, branch);
		raw.search = u.search; // 保留 query（签名参数等）
		return { root: raw, gh, release: false };
	}

	// raw.githubusercontent.com：跟踪表里的 rootUrl 即此形态，反解出 owner/repo 以启用 Release 回退
	if (u.hostname === "raw.githubusercontent.com") {
		return { root: u, gh: parseGithubRepoFromRaw(u), release: false };
	}

	// 其他：目录 URL 或 manifest.json 链接 → 标准化为目录
	u.pathname = u.pathname.replace(/\/manifest\.json$/i, "").replace(/\/+$/, "") + "/";
	return { root: u, gh: null, release: false };
}

/** 解析安装来源到三件套所在目录的 URL（parseSourceSpec 的简版，保留给旧调用方与测试） */
export function resolveInstallRoot(input: string): URL {
	return parseSourceSpec(input).root;
}

/** raw 根 URL（raw.githubusercontent.com/<owner>/<repo>/...）反解出 owner/repo */
export function parseGithubRepoFromRaw(root: URL): { owner: string; repo: string } | null {
	if (root.hostname !== "raw.githubusercontent.com") return null;
	const parts = root.pathname.split("/").filter(Boolean);
	if (parts.length < 2) return null;
	const [owner, repo] = parts;
	if (!/^[\w.-]+$/.test(owner) || !/^[\w.-]+$/.test(repo)) return null;
	return { owner, repo };
}

/**
 * GitHub Release 资产候选（main.js / styles.css 是构建产物，按官方 sample-plugin
 * 的 .gitignore 惯例只挂在 Release 上，源码树里没有）。先精确 tag（= manifest.version，
 * 社区市场约定），再兼容 v 前缀 tag，最后 latest 兜底。
 */
export function githubReleaseAssetUrls(
	ref: { owner: string; repo: string },
	file: string,
	version?: string
): string[] {
	const base = `https://github.com/${ref.owner}/${ref.repo}/releases`;
	if (!version) return [`${base}/latest/download/${file}`];
	const tag = encodeURIComponent(version);
	return [
		`${base}/download/${tag}/${file}`,
		`${base}/download/v${tag}/${file}`,
		`${base}/latest/download/${file}`,
	];
}

/** 候选链全部 404/410（「确实没有」）时抛出，供上层做 GitHub 诊断 */
export class FetchMissingError extends Error {
	constructor(
		readonly file: string,
		readonly status: number
	) {
		super(`${file} ${t("directInstall.fetchFail")} ${status}`);
	}
}

/** 在搜索结果里找「仓库名完全一致」的项，作为拼写纠错建议；没有则 null */
export function pickExactNameMatch(
	items: { full_name?: unknown; name?: unknown }[],
	repo: string
): string | null {
	const target = repo.toLowerCase();
	for (const it of items) {
		if (
			typeof it.full_name === "string" &&
			typeof it.name === "string" &&
			it.name.toLowerCase() === target
		) {
			return it.full_name;
		}
	}
	return null;
}

/** GitHub 源安装失败时的诊断：区分「仓库不存在（附拼写建议）/ 仓库存在但没有 manifest」 */
async function diagnoseGithubRepo(
	ref: { owner: string; repo: string },
	original: FetchMissingError
): Promise<Error> {
	const full = `${ref.owner}/${ref.repo}`;
	try {
		const r = await requestUrl({ url: `https://api.github.com/repos/${full}`, throw: false });
		if (r.status === 200) {
			return new Error(t("directInstall.ghNoManifest", { repo: full }));
		}
		if (r.status === 404) {
			// 仓库不存在：多半是用户名/仓库名拼错，搜索完全同名仓库给纠错建议
			const sug = await searchGithubRepoName(ref.repo);
			if (sug) return new Error(t("directInstall.ghSuggest", { repo: full, sug }));
			return new Error(t("directInstall.ghNotFound", { repo: full }));
		}
		// 403（限流）等无法判断的状态：退回原始错误
	} catch {
		// 诊断请求本身失败：退回原始错误
	}
	return original;
}

async function searchGithubRepoName(repo: string): Promise<string | null> {
	try {
		const q = encodeURIComponent(`${repo} in:name`);
		const r = await requestUrl({
			url: `https://api.github.com/search/repositories?q=${q}&per_page=5`,
			throw: false,
		});
		if (r.status !== 200) return null;
		const items = (r.json as { items?: { full_name?: unknown; name?: unknown }[] })?.items ?? [];
		return pickExactNameMatch(items, repo);
	} catch {
		return null;
	}
}

/**
 * 依次尝试候选 URL 取文件文本；404/410 时换下一个来源，其余状态码立即报错。
 * optional=true 且全部缺失时返回 null（用于 styles.css / 主题 manifest 这类可缺文件）。
 */
export async function fetchFromUrls(
	urls: string[],
	name: string,
	optional = false,
): Promise<string | null> {
	let lastStatus = 0;
	for (const u of urls) {
		const r = await requestUrl({ url: u, throw: false });
		if (r.status >= 200 && r.status < 300) return r.text;
		// 只有「确实没有」才换下一个来源：500/403 当成缺失会误删已装好的旧样式
		if (r.status !== 404 && r.status !== 410) {
			throw new Error(`${name} ${t("directInstall.fetchFail")} ${r.status}`);
		}
		lastStatus = r.status;
	}
	if (optional) return null;
	throw new FetchMissingError(name, lastStatus);
}

/** 从 root 目录拉取单个文件（可附带候选来源） */
export async function fetchFileText(
	root: URL,
	name: string,
	fallbackUrls: string[] = [],
	optional = false,
): Promise<string | null> {
	const primary = new URL(root);
	primary.pathname += name;
	return fetchFromUrls([primary.href, ...fallbackUrls], name, optional);
}

/** 直链安装的目标类型：插件写 plugins/，主题写 themes/ */
export type BetaKind = "plugin" | "theme";

/** 直链 Beta 跟踪表的一项：记录来源，使装上的插件/主题可被回头更新（P0 + 主题 P1） */
export interface BetaPluginEntry {
	/** 插件 id（= manifest.id，写盘目录名）／主题的目录名 */
	id: string;
	/** 显示名（安装时的 manifest.name，仅展示用） */
	name: string;
	/** 已解析的安装根 URL（raw.githubusercontent 或目录直链，已编码分支/标签/commit） */
	rootUrl: string;
	/** 安装/上次更新时的版本号（用于判断是否有新版本） */
	installedVersion: string;
	/** 冻结：启动自动更新与「全部更新」时跳过 */
	frozen: boolean;
	/** 类型；缺省按 plugin 兼容旧数据 */
	kind?: BetaKind;
	/** 是否从 GitHub Release 资产安装（否则从源码树 raw 拉取） */
	release?: boolean;
	/** 钉选的 Release tag（仅 release 模式有意义）；更新时用来回拉同一 tag 的资产，缺失则退化为 latest */
	releaseTag?: string;
}

/**
 * 把三件套写盘并启用（installFromUrl / updateBetaPlugin 共用）。
 * - 普通模式：先取源码树（root），取不到再回退 GitHub Release 资产（精确 tag → v 前缀 → latest）
 * - release 模式（spec.release）：只从 Release 资产取（源码树里没有构建产物）
 */
export async function installFiles(
	app: App,
	spec: SourceSpec,
	manText: string,
	man: Manifest,
): Promise<Manifest> {
	const { gh } = spec;
	const rel = (file: string) =>
		gh ? githubReleaseAssetUrls(gh, file, spec.releaseTag ?? man.version) : [];
	const rootUrl = (name: string): string => {
		const p = new URL(spec.root);
		p.pathname += name;
		return p.href;
	};
	// release 模式跳过源码树，直接取 Release 资产；否则源码树优先、Release 兜底
	const mainUrls = spec.release ? rel(FILES[1]) : [rootUrl(FILES[1]), ...rel(FILES[1])];
	const styleUrls = spec.release ? rel(FILES[2]) : [rootUrl(FILES[2]), ...rel(FILES[2])];
	const fetchMain = async (): Promise<string> => {
		try {
			return (await fetchFromUrls(mainUrls, FILES[1])) as string;
		} catch (e) {
			// 源码树和 Release 都没有 main.js：多半是作者没发布构建产物
			if (e instanceof FetchMissingError && gh) {
				throw new Error(t("directInstall.ghNoMain", { repo: `${gh.owner}/${gh.repo}` }));
			}
			throw e;
		}
	};
	const texts: (string | null)[] = [
		manText,
		await fetchMain(),
		await fetchFromUrls(styleUrls, FILES[2], true),
	];
	if (!(texts[1] as string).trim()) throw new Error(t("directInstall.emptyMain"));

	const ad = app.vault.adapter;
	const id = man.id;
	const dir = app.vault.configDir + "/plugins/" + id;
	if (!(await ad.exists(dir))) await ad.mkdir(dir);
	for (let i = 0; i < FILES.length; i++) {
		const f = dir + "/" + FILES[i];
		// 新版本不再带 styles.css 时要删掉旧的，否则老样式会继续生效
		if (texts[i] != null) await ad.write(f, texts[i] as string);
		else if (await ad.exists(f)) await ad.remove(f);
	}

	const plugins = asAppInternals(app).plugins;
	if (!plugins) throw new Error(t("directInstall.noPluginsApi"));
	await plugins.loadManifests?.();
	// 已在运行的先停掉，否则新代码不会生效（报错不能吞：吞了会留下两个实例）
	if (plugins.manifests?.[id] || plugins.enabledPlugins?.has?.(id)) {
		await plugins.disablePlugin?.(id);
	}
	if (plugins.enablePluginAndSave) {
		await plugins.enablePluginAndSave(id);
	} else if (plugins.enablePlugin) {
		await plugins.enablePlugin(id);
	} else {
		throw new Error(t("directInstall.noPluginsApi"));
	}
	// 启用可能悄悄失败（不兼容、main.js 报错），别把它说成安装成功
	const stillEnabled = plugins.enabledPlugins?.has?.(id) ?? Boolean(plugins.manifests?.[id]);
	if (!stillEnabled) {
		throw new Error(t("directInstall.enableFailed"));
	}
	return man;
}

/** 校验 manifest 的 id / version 合法性（安装与更新共用） */
function assertValidManifest(man: Manifest): void {
	const id = man.id;
	if (
		typeof id !== "string" ||
		!/^[\w.-]+$/.test(id) ||
		id.startsWith(".") ||
		typeof man.version !== "string"
	) {
		throw new Error(t("directInstall.badManifest"));
	}
	if (man.minAppVersion && !requireApiVersion(man.minAppVersion)) {
		throw new Error(t("directInstall.minApp", { v: man.minAppVersion }));
	}
}

/** 拉取并校验 manifest（源码树优先，Release 兜底；GitHub 源 404 时给诊断） */
async function fetchManifest(spec: SourceSpec): Promise<Manifest> {
	let manText: string;
	try {
		if (spec.release && spec.gh) {
			manText = (await fetchFromUrls(
				githubReleaseAssetUrls(spec.gh, FILES[0], spec.releaseTag),
				FILES[0],
			)) as string;
		} else {
			manText = (await fetchFileText(
				spec.root,
				FILES[0],
				spec.gh ? githubReleaseAssetUrls(spec.gh, FILES[0], spec.releaseTag) : [],
			)) as string;
		}
	} catch (e) {
		if (e instanceof FetchMissingError && spec.gh) throw await diagnoseGithubRepo(spec.gh, e);
		throw e;
	}
	const man = JSON.parse(manText) as Manifest;
	assertValidManifest(man);
	return man;
}

export async function installFromUrl(app: App, url: string): Promise<Manifest> {
	const spec = parseSourceSpec(url);
	const man = await fetchManifest(spec);
	return installFiles(app, spec, JSON.stringify(man), man);
}

// ──────────────────────────────────────────
// 主题（P1）：写 themes/<name>/theme.css 并启用
// ──────────────────────────────────────────

/** 主题的必需文件；manifest.json 可选（很多主题仓库没有） */
const THEME_CSS = "theme.css";

/** 主题安装结果（复用 Manifest 形状，便于跟踪表统一处理） */
export interface ThemeInfo {
	/** 主题目录名（写盘路径） */
	id: string;
	/** 显示名 */
	name: string;
	/** 版本；主题没有 manifest.json 时为空串（此时更新按「无法判断」处理，直接重拉） */
	version: string;
}

/** 主题目录名合法性：会拼进写盘路径，禁止路径穿越与隐藏目录 */
function assertValidThemeName(name: string): void {
	if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) {
		throw new Error(t("badThemeName"));
	}
}

/** 主题目录名：优先 manifest.name，其次仓库名 */
function deriveThemeName(spec: SourceSpec, man: Manifest | null): string {
	const fromManifest = man?.name?.trim();
	if (fromManifest) return fromManifest;
	const fromRepo = spec.gh?.repo;
	if (fromRepo) return fromRepo;
	// 非 GitHub 源：取目录最后一段
	const seg = spec.root.pathname.split("/").filter(Boolean).pop();
	return seg ?? "";
}

/** 从来源拉 theme.css（release 模式取 Release 资产，否则源码树优先） */
async function fetchThemeCss(spec: SourceSpec): Promise<string> {
	const rel = spec.gh ? githubReleaseAssetUrls(spec.gh, THEME_CSS, spec.releaseTag) : [];
	const p = new URL(spec.root);
	p.pathname += THEME_CSS;
	const urls = spec.release ? rel : [p.href, ...rel];
	try {
		return (await fetchFromUrls(urls, THEME_CSS)) as string;
	} catch (e) {
		if (e instanceof FetchMissingError && spec.gh) {
			throw new Error(t("directInstall.ghNoTheme", { repo: `${spec.gh.owner}/${spec.gh.repo}` }));
		}
		throw e;
	}
}

/** 写主题目录并启用（theme.css 必写；manifest.json 有则写，用于记录版本） */
async function writeThemeFiles(
	app: App,
	name: string,
	css: string,
	manText: string | null,
): Promise<void> {
	const ad = app.vault.adapter;
	const dir = `${app.vault.configDir}/themes/${name}`;
	if (!(await ad.exists(dir))) await ad.mkdir(dir);
	await ad.write(`${dir}/${THEME_CSS}`, css);
	if (manText != null) await ad.write(`${dir}/${FILES[0]}`, manText);
	const cssApi = asAppInternals(app).customCss;
	// 主题启用：优先 setTheme（内部 API），缺失时退回 setCssEnabled(..., "theme")
	if (cssApi?.setTheme) cssApi.setTheme(name);
	else cssApi?.setCssEnabled?.(true, name, "theme");
}

/** 从直链安装主题，返回主题信息（目录名 / 显示名 / 版本） */
export async function installThemeFromUrl(app: App, url: string): Promise<ThemeInfo> {
	const spec = parseSourceSpec(url);
	// manifest 可选：主题仓库常常没有
	let manText: string | null = null;
	let man: Manifest | null = null;
	try {
		manText = await fetchFromUrls(
			spec.release && spec.gh
				? githubReleaseAssetUrls(spec.gh, FILES[0], spec.releaseTag)
				: [((): string => { const p = new URL(spec.root); p.pathname += FILES[0]; return p.href; })()],
			FILES[0],
			true,
		);
	} catch {
		manText = null;
	}
	if (manText) {
		try {
			man = JSON.parse(manText) as Manifest;
		} catch {
			man = null; // manifest 坏了就当没有，主题照样能装（只按内容更新）
			manText = null;
		}
	}
	const name = deriveThemeName(spec, man);
	assertValidThemeName(name);
	const css = await fetchThemeCss(spec);
	if (!css.trim()) throw new Error(t("directInstall.emptyMain"));
	await writeThemeFiles(app, name, css, manText);
	return { id: name, name: man?.name?.trim() || name, version: man?.version ?? "" };
}

/** 按跟踪表来源更新主题：无法判断版本（无 manifest）时直接重拉 theme.css */
export async function updateBetaTheme(
	app: App,
	entry: BetaPluginEntry,
): Promise<{ updated: boolean; manifest: Manifest }> {
	const spec = rebuildUpdateSpec(entry);
	let manText: string | null = null;
	let man: Manifest | null = null;
	try {
		manText = await fetchFromUrls(
			spec.release && spec.gh
				? githubReleaseAssetUrls(spec.gh, FILES[0], spec.releaseTag)
				: [((): string => { const p = new URL(spec.root); p.pathname += FILES[0]; return p.href; })()],
			FILES[0],
			true,
		);
	} catch {
		manText = null;
	}
	if (manText) {
		try {
			man = JSON.parse(manText) as Manifest;
		} catch {
			man = null;
			manText = null;
		}
	}
	const version = man?.version ?? "";
	// 双方都有版本且一致 → 已最新；否则（含无 manifest 无法判断的情况）重拉
	if (version && entry.installedVersion && version === entry.installedVersion) {
		return { updated: false, manifest: { id: entry.id, name: entry.name, version } };
	}
	const css = await fetchThemeCss(spec);
	if (!css.trim()) throw new Error(t("directInstall.emptyMain"));
	await writeThemeFiles(app, entry.id, css, manText);
	return { updated: true, manifest: { id: entry.id, name: entry.name, version } };
}

/**
 * 按跟踪表里的来源更新一个直链 Beta 插件。
 * - 远程 id 与记录不一致 → 抛错（防覆盖错插件）
 * - 版本相同 → 视为已最新，不写盘、不重载（updated=false）
 * - 版本不同 → 重新拉三件套写盘启用
 */
/**
 * 由跟踪表项重建「更新用」来源：先按记录的 rootUrl 解析，再还原 release 开关与钉选 tag。
 * 不还原 releaseTag 会导致更新退化为 latest（releaseTag 丢失 bug），故集中在此处处理。
 */
export function rebuildUpdateSpec(entry: BetaPluginEntry): SourceSpec {
	const spec = parseSourceSpec(entry.rootUrl);
	if (entry.release) spec.release = true;
	if (entry.releaseTag) spec.releaseTag = entry.releaseTag;
	return spec;
}

export async function updateBetaPlugin(
	app: App,
	entry: BetaPluginEntry,
): Promise<{ updated: boolean; manifest: Manifest }> {
	const spec = rebuildUpdateSpec(entry);
	const man = await fetchManifest(spec);
	if (man.id !== entry.id) {
		throw new Error(t("beta.idMismatch", { id: man.id, entry: entry.id }));
	}
	if (man.version === entry.installedVersion) {
		return { updated: false, manifest: man };
	}
	const m = await installFiles(app, spec, JSON.stringify(man), man);
	return { updated: true, manifest: m };
}

/** 安装成功后回传给上层的信息（用于记入直链 Beta 跟踪表） */
export interface InstalledInfo {
	id: string;
	name: string;
	version: string;
	rootUrl: string;
	kind: BetaKind;
	release: boolean;
	/** 钉选的 Release tag（release 模式且来自 /releases/tag|download/<tag> 时存在） */
	releaseTag?: string;
}

/** 直链安装模态框：输入来源 → 一键安装插件或主题 */
export class DirectInstallModal extends Modal {
	private url = "";
	private busy = false;
	private kind: BetaKind;
	/** 安装成功后回调，供上层记入直链 Beta 跟踪表 */
	private onInstalled?: (info: InstalledInfo) => void;

	constructor(app: App, kind: BetaKind = "plugin", onInstalled?: (info: InstalledInfo) => void) {
		super(app);
		this.kind = kind;
		this.onInstalled = onInstalled;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass("pt-direct-install-modal");
		const isTheme = this.kind === "theme";

		contentEl.createEl("h3", { text: isTheme ? t("beta.title.theme") : t("directInstall.title") });
		contentEl.createEl("p", {
			cls: "pt-direct-install-desc",
			text: isTheme ? t("beta.desc.theme") : t("directInstall.desc"),
		});

		new Setting(contentEl)
			.setName(t("directInstall.urlLabel"))
			.setDesc(isTheme ? t("beta.desc.theme") : t("directInstall.urlDesc"))
			.addText((text) => {
				text.setPlaceholder("owner/repo")
					.setValue(this.url)
					.onChange((v) => (this.url = v));
				text.inputEl.setCssStyles({ width: "100%" });
			})
			.addButton((btn) =>
				btn
					.setButtonText(t("directInstall.install"))
					.setCta()
					.onClick(() => void this.run(btn))
			);
	}

	private async run(btn: { buttonEl: HTMLElement; setButtonText: (s: string) => unknown; setDisabled: (b: boolean) => unknown }): Promise<void> {
		if (this.busy) return;
		this.busy = true;
		const label = btn.buttonEl.textContent || t("directInstall.install");
		btn.setButtonText(t("directInstall.installing"));
		btn.setDisabled(true);
		try {
			// 先解析来源：rootUrl/release 既要用于安装，也要原样记进跟踪表
			const spec = parseSourceSpec(this.url);
			if (this.kind === "theme") {
				const info = await installThemeFromUrl(this.app, this.url);
				this.record({
					id: info.id,
					name: info.name,
					version: info.version,
					rootUrl: spec.root.href,
					kind: "theme",
					release: spec.release,
					releaseTag: spec.releaseTag,
				});
				new Notice(t("beta.installed.theme", { name: info.name }), 6000);
			} else {
				const m = await installFromUrl(this.app, this.url);
				this.record({
					id: m.id,
					name: m.name ?? m.id,
					version: m.version,
					rootUrl: spec.root.href,
					kind: "plugin",
					release: spec.release,
					releaseTag: spec.releaseTag,
				});
				new Notice(t("directInstall.done", { name: m.name || m.id, v: m.version }), 6000);
			}
			this.close();
		} catch (e) {
			new Notice(t("directInstall.failed", { msg: e instanceof Error ? e.message : String(e) }), 8000);
		} finally {
			this.busy = false;
			btn.setButtonText(label);
			btn.setDisabled(false);
		}
	}

	/** 记入跟踪表；记录失败不应影响「已安装」的结果提示 */
	private record(info: InstalledInfo): void {
		if (!this.onInstalled) return;
		try {
			this.onInstalled(info);
		} catch {
			// 忽略：跟踪表只是便于后续更新，不是安装成功的必要条件
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

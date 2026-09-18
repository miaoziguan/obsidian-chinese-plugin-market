/**
 * 拉取插件仓库的可用版本列表（BRAT 式「固定到指定版本」用）。
 *
 * 数据源优先级：
 *   1) GitHub Releases（`/repos/{owner}/{repo}/releases?per_page=100`）——
 *      带发布日期/预发布标记，且与「按 tag 下载 Release 资产」的安装路径天然对齐；
 *   2) 兜底 GitHub Tags（`/tags?per_page=100`）——有些插件只打 tag 不发 Release。
 *
 * 说明：
 * - 走 netRequest（依赖倒置，可脱离 Obsidian 单测），非 2xx 不抛错只降级到下一来源；
 * - 结果按仓库缓存 10 分钟（force 可绕过），避免反复打开弹窗打爆 GitHub 免费限额（60/h）。
 */

import { netRequest } from "@data/net/net";
import { logger } from "@shared/logger";

/** 单个可选版本 */
export interface PluginVersion {
	/** GitHub tag 原样值（安装时作为 ref 使用，可能带 v 前缀） */
	tag: string;
	/** 展示用版本号（去掉 v 前缀） */
	version: string;
	/** 发布日期（ISO 字符串；tags 来源没有） */
	publishedAt?: string;
	/** 是否为预发布（仅 releases 来源提供） */
	prerelease?: boolean;
}

/** 版本列表缓存 TTL：10 分钟 */
const CACHE_TTL_MS = 10 * 60 * 1000;

const cache = new Map<string, { at: number; versions: PluginVersion[] }>();

/** 仅测试用：清空内存缓存 */
export function clearPluginVersionsCache(): void {
	cache.clear();
}

/** owner/name 反解 */
function parseRepo(repo: string): { owner: string; repo: string } | null {
	const cleaned = repo.replace(/^\/+|\/+$/g, "");
	const parts = cleaned.split("/");
	if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
	return { owner: parts[0], repo: parts[1] };
}

/** tag → 展示版本号（去 v/V 前缀） */
export function normalizeVersionLabel(tag: string): string {
	return tag.trim().replace(/^v/i, "");
}

/** 安全解析 JSON 文本（响应无 .json 时兜底） */
function safeParse(text: string): unknown {
	if (!text) return null;
	try {
		return JSON.parse(text) as unknown;
	} catch {
		return null;
	}
}

function asArray(json: unknown): Record<string, unknown>[] {
	return Array.isArray(json) ? (json as Record<string, unknown>[]) : [];
}

function str(v: unknown): string {
	return typeof v === "string" ? v : "";
}

/**
 * 解析 GitHub Releases 响应。
 * 跳过 draft（草稿不对外可见）；保留 prerelease（用户可能就是想装 beta）。
 */
export function parseReleaseEntries(json: unknown): PluginVersion[] {
	const out: PluginVersion[] = [];
	for (const item of asArray(json)) {
		if (item.draft === true) continue;
		const tag = str(item.tag_name).trim();
		if (!tag) continue;
		out.push({
			tag,
			version: normalizeVersionLabel(tag),
			publishedAt: str(item.published_at) || undefined,
			prerelease: item.prerelease === true,
		});
	}
	return dedupe(out);
}

/** 解析 GitHub Tags 响应 */
export function parseTagEntries(json: unknown): PluginVersion[] {
	const out: PluginVersion[] = [];
	for (const item of asArray(json)) {
		const tag = str(item.name).trim();
		if (!tag) continue;
		out.push({ tag, version: normalizeVersionLabel(tag) });
	}
	return dedupe(out);
}

/** 按 tag 去重，保持原始顺序（GitHub 默认新→旧） */
function dedupe(list: PluginVersion[]): PluginVersion[] {
	const seen = new Set<string>();
	const out: PluginVersion[] = [];
	for (const v of list) {
		if (seen.has(v.tag)) continue;
		seen.add(v.tag);
		out.push(v);
	}
	return out;
}

async function fetchUncached(parsed: { owner: string; repo: string }): Promise<PluginVersion[]> {
	const base = `https://api.github.com/repos/${parsed.owner}/${parsed.repo}`;
	const headers = { Accept: "application/vnd.github+json" };

	try {
		const r = await netRequest({ url: `${base}/releases?per_page=100`, headers });
		if (r.status >= 200 && r.status < 300) {
			const list = parseReleaseEntries(r.json ?? safeParse(r.text));
			if (list.length > 0) return list;
		}
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 拉取插件 Releases 失败：", e);
	}

	try {
		const r = await netRequest({ url: `${base}/tags?per_page=100`, headers });
		if (r.status >= 200 && r.status < 300) {
			return parseTagEntries(r.json ?? safeParse(r.text));
		}
	} catch (e: unknown) {
		logger.warn("[Chinese Plugin Market] 拉取插件 Tags 失败：", e);
	}

	return [];
}

/**
 * 拉取插件仓库的可选版本列表（新 → 旧）。
 * 网络不可用 / 仓库无 Release 与 Tag 时返回空数组，由调用方给出空态文案。
 */
export async function fetchPluginVersions(repo: string, force = false): Promise<PluginVersion[]> {
	const parsed = parseRepo(repo);
	if (!parsed) return [];
	const key = `${parsed.owner}/${parsed.repo}`;

	const hit = cache.get(key);
	if (!force && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.versions;

	const versions = await fetchUncached(parsed);
	// 空结果不写缓存：多半是限流/断网导致，下次打开应重试
	if (versions.length > 0) cache.set(key, { at: Date.now(), versions });
	return versions;
}

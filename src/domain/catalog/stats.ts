/**
 * 插件统计信息（下载量 / 更新时间）— 产品改进 #1 #6
 *
 * 数据源：obsidian-releases 仓库的 community-plugin-stats.json
 * 真实结构：`{ "<plugin-id>": { downloads: number, versions?: Record<string,number>, updated?: number } }`
 * `updated` 为最近更新时间戳（毫秒）。
 */
import { netRequest } from "@data/net/net";

/** 单个插件的统计信息 */
export interface PluginStat {
	downloads: number;
	updated?: number;
}

/** 数据源 URL（与 community-plugins.json 同目录） */
export const PLUGIN_STATS_URL =
	"https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugin-stats.json";

/**
 * 解析 stats JSON 为 Map<id, PluginStat>。
 * 容错：非法结构、缺 downloads、downloads 非数字均跳过/降级。
 */
export function parseStatsJson(json: unknown): Map<string, PluginStat> {
	const result = new Map<string, PluginStat>();
	if (!json || typeof json !== "object" || Array.isArray(json)) return result;

	const root = json as Record<string, unknown>;
	for (const [id, raw] of Object.entries(root)) {
		if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
		const entry = raw as Record<string, unknown>;
		const downloads = entry.downloads;
		if (typeof downloads !== "number" || !Number.isFinite(downloads)) continue;

		const stat: PluginStat = { downloads };
		const updated = entry.updated;
		if (typeof updated === "number" && Number.isFinite(updated)) {
			stat.updated = updated;
		}
		result.set(id, stat);
	}
	return result;
}

/** 把下载量格式化为紧凑形式：1200→"1.2k"，1200000→"1.2M" */
export function formatDownloads(n: number): string {
	if (!Number.isFinite(n) || n < 0) return "0";
	if (n < 1000) return String(Math.round(n));
	if (n < 1_000_000) return trimZero((n / 1000).toFixed(1)) + "k";
	return trimZero((n / 1_000_000).toFixed(1)) + "M";
}

function trimZero(s: string): string {
	return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** 把 ms 时间戳格式化为 "YYYY-MM"，缺失/非法返回空串 */
export function formatUpdated(ts?: number): string {
	if (ts == null || !Number.isFinite(ts)) return "";
	const d = new Date(ts);
	if (Number.isNaN(d.getTime())) return "";
	const y = d.getFullYear();
	const m = d.getMonth() + 1;
	const mm = m < 10 ? `0${m}` : String(m);
	return `${y}-${mm}`;
}

const MINUTE = 60_000;
const HOUR = 3_600_000;
const DAY = 86_400_000;

/**
 * 把 ms 时间戳格式化为相对时间（对齐竞品 "3d ago" 的可读性，中文文案）：
 *   <1 分钟 → "刚刚"；<1 小时 → "N 分钟前"；<24 小时 → "N 小时前"；
 *   <30 天 → "N 天前"；<365 天 → "N 个月前"；否则 → "N 年前"。
 * 缺失 / 非法 / 未来时间戳返回 ""（未来时间视为未知，避免 "0 分钟前" 误导）。
 */
export function formatRelativeTime(ts?: number, now: number = Date.now()): string {
	if (ts == null || !Number.isFinite(ts)) return "";
	const diff = now - ts;
	if (diff < 0) return "";
	if (diff < MINUTE) return "刚刚";
	if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
	if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
	if (diff < 30 * DAY) return `${Math.floor(diff / DAY)} 天前`;
	if (diff < 365 * DAY) return `${Math.floor(diff / (30 * DAY))} 个月前`;
	return `${Math.floor(diff / (365 * DAY))} 年前`;
}

/** 从网络拉取并解析 stats（失败向上抛，由调用方静默降级） */
export async function fetchPluginStats(url: string): Promise<Map<string, PluginStat>> {
	const response = await netRequest({ url, method: "GET" });
	return parseStatsJson(response.json);
}

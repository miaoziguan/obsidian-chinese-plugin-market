import { logger } from "@shared/logger";
import { type StoragePort } from "@data/storage/storage-port";
import { type PluginStat, parseStatsJson } from "@domain/catalog/stats";
import { type TrendSnapshot } from "@domain/recommend/trending";

/**
 * 插件持久化缓存存储层（从 ChinesePluginMarketPlugin 抽离）。
 *
 * 负责 stats / 趋势采样历史 / 插件列表三类独立缓存文件的读写，与插件主类的
 * 业务状态（translator / settings / 视图）解耦。
 * 依赖倒置：只面向 `StoragePort` 接口编程，由 app 层注入 Obsidian vault adapter 适配器，
 * 本文件不再 import "obsidian"。
 * 各缓存独立成文件，避免大对象（stats 1.6MB、trending 可达数 MB）随主 data.json
 * 防抖保存被整体重写。
 */
export class PluginStorage {
	constructor(private storage: StoragePort, private pluginId: string) {}

	private get statsCacheFilePath(): string {
		return `.obsidian/plugins/${this.pluginId}/stats-cache.json`;
	}
	private get pluginListCacheFilePath(): string {
		return `.obsidian/plugins/${this.pluginId}/plugin-list-cache.json`;
	}
	private get trendingHistoryFilePath(): string {
		return `.obsidian/plugins/${this.pluginId}/trending-history.json`;
	}

	/** 写趋势采样历史（仅在引擎实际新增采样点时调用，fire-and-forget） */
	async saveTrendingHistory(history: Record<string, TrendSnapshot[]>): Promise<void> {
		try {
			await this.storage.write(
				this.trendingHistoryFilePath,
				JSON.stringify(history)
			);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 保存趋势历史失败：", e);
		}
	}

	/** 读趋势采样历史；缺失/损坏时返回 null（引擎从零开始累积） */
	async loadTrendingHistory(): Promise<Record<string, TrendSnapshot[]> | null> {
		try {
			const adapter = this.storage;
			if (!(await adapter.exists(this.trendingHistoryFilePath))) return null;
			const parsed = JSON.parse(await adapter.read(this.trendingHistoryFilePath)) as Record<string, unknown>;
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, TrendSnapshot[]>;
			}
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取趋势历史失败，将重新累积：", e);
		}
		return null;
	}

	/** 写插件列表缓存（离线重启秒开用；独立文件，避免污染主 data.json） */
	async savePluginListCache(list: unknown[]): Promise<void> {
		try {
			await this.storage.write(
				this.pluginListCacheFilePath,
				JSON.stringify(list)
			);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 保存插件列表缓存失败：", e);
		}
	}

	/**
	 * 读插件列表缓存；兼容迁移：优先独立文件，缺失时回退读旧版 data.json 内嵌键。
	 * @param legacyData 主 data.json 落盘对象（用于首次升级后的兼容回退）
	 */
	async loadPluginListCache(legacyData?: Record<string, unknown>): Promise<unknown[] | null> {
		try {
			const adapter = this.storage;
			if (await adapter.exists(this.pluginListCacheFilePath)) {
				const parsed = JSON.parse(await adapter.read(this.pluginListCacheFilePath)) as unknown[];
				if (Array.isArray(parsed) && parsed.length > 0) return parsed;
			}
			// 旧版迁移路径：首次升级后独立文件尚未生成（复用内存权威对象，免去一次 read）
			if (Array.isArray(legacyData?.["_pluginListCache"]) && (legacyData["_pluginListCache"] as unknown[]).length > 0) {
				return legacyData["_pluginListCache"] as unknown[];
			}
		} catch {
			/* 加载失败 → 无缓存 */
		}
		return null;
	}

	/** 写 stats 缓存，带写入时间戳用于 TTL 判断（6h） */
	async saveStatsCache(map: Map<string, PluginStat>): Promise<void> {
		try {
			const adapter = this.storage;
			const obj: Record<string, PluginStat> = {};
			for (const [id, s] of map) obj[id] = s;
			await adapter.write(
				this.statsCacheFilePath,
				JSON.stringify({ savedAt: Date.now(), stats: obj })
			);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 保存 stats 缓存失败：", e);
		}
	}

	/**
	 * 读取 stats 缓存，超期（>24h）返回 null（交由视图重新拉取）。
	 */
	async loadStatsCache(): Promise<Map<string, PluginStat> | null> {
		const TTL = 6 * 60 * 60 * 1000;
		try {
			const adapter = this.storage;
			if (!(await adapter.exists(this.statsCacheFilePath))) return null;
			const text = await adapter.read(this.statsCacheFilePath);
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (!parsed || typeof parsed !== "object") return null;
			const savedAt = parsed.savedAt;
			if (typeof savedAt !== "number" || Date.now() - savedAt > TTL) return null;
			return parseStatsJson(parsed.stats);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取 stats 缓存失败：", e);
			return null;
		}
	}
}

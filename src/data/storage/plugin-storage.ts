import { logger } from "@shared/logger";
import { type StoragePort } from "@data/storage/storage-port";
import { type PluginStat, parseStatsJson } from "@domain/catalog/stats";
import { type TrendSnapshot } from "@domain/recommend/trending";
import { type TranslateResult, type DictEntry, type CoverageSnapshot } from "@domain/catalog/translator";

/** 翻译缓存持久化结构（与主 data.json 分离，独立成 translator-cache.json）。 */
export interface TranslatorPersistedData {
	cache: Record<string, TranslateResult>;
	aiDict: Record<string, DictEntry>;
	pluginInsights: Record<string, unknown>;
	compareInsights: Record<string, unknown>;
	coverageSnapshots: CoverageSnapshot[];
	myMemoryBlockedDate: string;
	seenPluginIds: string[];
	lastListFetchAt: number;
}

/** 账号/密钥等敏感配置（独立成 credentials.json，避免随主 data.json 备份/分享时泄露）。 */
export interface PluginCredentials {
	secretId: string;
	secretKey: string;
	region: string;
	aiSearchApiKey: string;
	aiSearchBaseURL: string;
	embeddingApiKey: string;
	embeddingBaseURL: string;
	selfHostedTranslators: { type: "deeplx" | "libretranslate"; baseUrl: string }[];
}

/** 主 data.json 中应抽离到 credentials.json 的敏感字段键名（用于迁移/剥离）。 */
export const CREDENTIAL_KEYS: (keyof PluginCredentials)[] = [
	"secretId", "secretKey", "region",
	"aiSearchApiKey", "aiSearchBaseURL",
	"embeddingApiKey", "embeddingBaseURL",
	"selfHostedTranslators",
];

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

	/**
	 * 独立数据文件统一落在「插件目录」下（与 stats-cache / plugin-list-cache 一致），
	 * 避免相对路径被 Obsidian DataAdapter 解析到 vault 根目录而散落、且无法被 sync.sh 同步。
	 * 旧版（v2.15.x）误用相对路径，把 translator-cache.json / favorites.json / credentials.json
	 * 写到了 vault 根；读取时优先插件目录，缺失再回退 vault 根旧位置做一次性迁移。
	 */
	private get translatorCacheFilePath(): string {
		return `.obsidian/plugins/${this.pluginId}/translator-cache.json`;
	}
	/**
	 * 随插件分发的种子译名库（构建期由作者导出的 translator-cache.json 快照）。
	 * 用户安装/更新后即便本地运行时文件为空，也能立即拿到译名，而非全英文。
	 * 与 plugin-tags.json / plugin-recommend.json 同目录（插件根），由 sync.sh 同步分发。
	 */
	private get seededTranslatorCachePath(): string {
		return "seeded-translator-cache.json";
	}
	private get favoritesFilePath(): string {
		return `.obsidian/plugins/${this.pluginId}/favorites.json`;
	}
	private get credentialsFilePath(): string {
		return `.obsidian/plugins/${this.pluginId}/credentials.json`;
	}
	/** 旧版相对路径落点（vault 根），仅用于迁移读取回退 */
	private get legacyTranslatorCachePath(): string {
		return "translator-cache.json";
	}
	private get legacyFavoritesPath(): string {
		return "favorites.json";
	}
	private get legacyCredentialsPath(): string {
		return "credentials.json";
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

	// ── 翻译缓存（高频写、体量大的派生数据，独立文件以免污染主 data.json） ──

	/**
	 * 写翻译缓存到独立文件（译名/AI 词典/洞察/覆盖率快照/MyMemory 熔断等）。
	 * 不影响主 data.json，缩小其写盘频率与损坏面。
	 */
	async saveTranslatorCache(data: TranslatorPersistedData): Promise<void> {
		try {
			const adapter = this.storage;
			const {
				cache, aiDict, pluginInsights, compareInsights,
				coverageSnapshots, myMemoryBlockedDate,
				seenPluginIds, lastListFetchAt,
			} = data;
			await adapter.write(
				this.translatorCacheFilePath,
				JSON.stringify({
					savedAt: Date.now(),
					cache, aiDict, pluginInsights, compareInsights,
					coverageSnapshots, myMemoryBlockedDate,
					seenPluginIds, lastListFetchAt,
				})
			);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 保存翻译缓存失败：", e);
		}
	}

	/**
	 * 读取翻译缓存；文件缺失/损坏返回 null（交由 translator 重建默认值）。
	 * 优先插件目录文件；旧版（v2.15.x）曾误写 vault 根相对路径，缺失时回退该旧位置。
	 */
	async loadTranslatorCache(): Promise<TranslatorPersistedData | null> {
		try {
			const adapter = this.storage;
			let text: string | null = null;
			if (await adapter.exists(this.translatorCacheFilePath)) {
				text = await adapter.read(this.translatorCacheFilePath);
			} else if (await adapter.exists(this.legacyTranslatorCachePath)) {
				// 迁移：旧版写到了 vault 根，读出来后由下次 saveTranslatorCache 落回插件目录
				text = await adapter.read(this.legacyTranslatorCachePath);
			}
			if (!text) return null;
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (!parsed || typeof parsed !== "object") return null;
			return {
				cache: (parsed.cache as Record<string, TranslateResult>) ?? {},
				aiDict: (parsed.aiDict as Record<string, DictEntry>) ?? {},
				pluginInsights: (parsed.pluginInsights as Record<string, unknown>) ?? {},
				compareInsights: (parsed.compareInsights as Record<string, unknown>) ?? {},
				coverageSnapshots: (parsed.coverageSnapshots as CoverageSnapshot[]) ?? [],
				myMemoryBlockedDate: (parsed.myMemoryBlockedDate as string) ?? "",
				seenPluginIds: (parsed.seenPluginIds as string[]) ?? [],
				lastListFetchAt: (parsed.lastListFetchAt as number) ?? 0,
			};
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取翻译缓存失败：", e);
			return null;
		}
	}

	/**
	 * 读取随插件分发的种子译名库（seeded-translator-cache.json）。
	 * 用于「新用户/本地文件为空」时立即获得基础译名，避免首屏全英文。
	 * 文件缺失/损坏返回 null（交由调用方降级为无种子）。
	 * 注：种子是只读基础库，运行时用户产生的译名写入独立 translator-cache.json，
	 * 加载时以「种子 ∪ 用户文件」合并、用户文件优先，互不覆盖。
	 */
	async loadSeededTranslatorCache(): Promise<TranslatorPersistedData | null> {
		try {
			const adapter = this.storage;
			if (!(await adapter.exists(this.seededTranslatorCachePath))) return null;
			const text = await adapter.read(this.seededTranslatorCachePath);
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (!parsed || typeof parsed !== "object") return null;
			return {
				cache: (parsed.cache as Record<string, TranslateResult>) ?? {},
				aiDict: (parsed.aiDict as Record<string, DictEntry>) ?? {},
				pluginInsights: (parsed.pluginInsights as Record<string, unknown>) ?? {},
				compareInsights: (parsed.compareInsights as Record<string, unknown>) ?? {},
				coverageSnapshots: (parsed.coverageSnapshots as CoverageSnapshot[]) ?? [],
				myMemoryBlockedDate: (parsed.myMemoryBlockedDate as string) ?? "",
				seenPluginIds: (parsed.seenPluginIds as string[]) ?? [],
				lastListFetchAt: (parsed.lastListFetchAt as number) ?? 0,
			};
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取种子译名库失败，已跳过：", e);
			return null;
		}
	}

	// ── 个人收藏（用户态，独立 favorites.json，与配置/缓存/账号解耦） ──

	/** 写用户收藏集到独立 favorites.json。 */
	async saveFavorites(favorites: string[]): Promise<void> {
		try {
			const adapter = this.storage;
			await adapter.write(
				this.favoritesFilePath,
				JSON.stringify({ savedAt: Date.now(), favorites })
			);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 保存收藏失败：", e);
		}
	}

	/**
	 * 读取 favorites.json；缺失/损坏返回 null（降级为无收藏）。
	 * @param legacyData 主 data.json 落盘对象（旧版把 favorites 内联在主 data.json，升级后首次保存即迁移）
	 */
	async loadFavorites(legacyData?: Record<string, unknown>): Promise<string[] | null> {
		try {
			const adapter = this.storage;
			if (await adapter.exists(this.favoritesFilePath)) {
				const parsed = JSON.parse(await adapter.read(this.favoritesFilePath)) as Record<string, unknown>;
				if (parsed && typeof parsed === "object" && Array.isArray(parsed.favorites)) {
					return parsed.favorites as string[];
				}
			}
			// 旧版（v2.15.x）曾把 favorites.json 写到 vault 根相对路径，回退读旧位置
			if (await adapter.exists(this.legacyFavoritesPath)) {
				const parsed = JSON.parse(await adapter.read(this.legacyFavoritesPath)) as Record<string, unknown>;
				if (parsed && typeof parsed === "object" && Array.isArray(parsed.favorites)) {
					return parsed.favorites as string[];
				}
			}
			// 旧版迁移路径：独立文件尚未生成时回退读主 data.json 内嵌键
			if (Array.isArray(legacyData?.["favorites"])) {
				return legacyData["favorites"] as string[];
			}
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取收藏失败，将重置为空：", e);
		}
		return null;
	}

	// ── 账号/密钥（敏感，独立 credentials.json，避免随主 data.json 备份泄露） ──

	/** 写敏感配置到独立 credentials.json。 */
	async saveCredentials(creds: PluginCredentials): Promise<void> {
		try {
			const adapter = this.storage;
			await adapter.write(
				this.credentialsFilePath,
				JSON.stringify({ savedAt: Date.now(), ...creds })
			);
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 保存 credentials 失败：", e);
		}
	}

	/** 读取 credentials.json；缺失/损坏返回 null（降级为未配置）。 */
	async loadCredentials(): Promise<PluginCredentials | null> {
		try {
			const adapter = this.storage;
			let text: string | null = null;
			if (await adapter.exists(this.credentialsFilePath)) {
				text = await adapter.read(this.credentialsFilePath);
			} else if (await adapter.exists(this.legacyCredentialsPath)) {
				// 旧版曾写到 vault 根，回退读旧位置
				text = await adapter.read(this.legacyCredentialsPath);
			}
			if (!text) return null;
			const parsed = JSON.parse(text) as Record<string, unknown>;
			if (!parsed || typeof parsed !== "object") return null;
			return {
				secretId: (parsed.secretId as string) ?? "",
				secretKey: (parsed.secretKey as string) ?? "",
				region: (parsed.region as string) ?? "",
				aiSearchApiKey: (parsed.aiSearchApiKey as string) ?? "",
				aiSearchBaseURL: (parsed.aiSearchBaseURL as string) ?? "",
				embeddingApiKey: (parsed.embeddingApiKey as string) ?? "",
				embeddingBaseURL: (parsed.embeddingBaseURL as string) ?? "",
				selfHostedTranslators:
					(parsed.selfHostedTranslators as PluginCredentials["selfHostedTranslators"]) ?? [],
			};
		} catch (e: unknown) {
			logger.warn("[Chinese Plugin Market] 读取 credentials 失败：", e);
			return null;
		}
	}
}

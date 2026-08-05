/**
 * 结果排序（产品改进 #5）v2。
 *
 * 维度：
 *  - relevance： 相关度（默认）。保持传入顺序。
 *  - downloads： 下载量降序。
 *  - updated：   最近更新时间降序。
 *  - name：      显示名（中文名优先）本地化升序。
 *  - published： 按清单数组下标倒序（最新上架优先）。
 *  - popular：   未安装优先 → 下载量降序 → 更新时间降序（决策价值排序）。
 *  - trending：  趋势引擎评分降序（增速优先），需提供 trendingScores。
 *  - recommended：统一推荐引擎评分降序，需提供 recommendScores。
 */

export type SortBy =
	| "relevance"
	| "downloads"
	| "updated"
	| "name"
	| "popular"
	| "published"
	| "trending"
	| "recommended";

export interface SortablePlugin {
	id: string;
	name: string;
	/** 显示名（中文译名优先），用于 name 排序；可选——未提供时由 displayNameOf 回调或回退到 name */
	displayName?: string;
	downloads?: number;
	updated?: number;
	listIndex?: number;
}

export interface SortOptions<T extends SortablePlugin = SortablePlugin> {
	installedIds?: Set<string>;
	/** "trending" 排序所需的趋势评分 (id → 0-1 score) */
	trendingScores?: Map<string, number>;
	/** "recommended" 排序所需的推荐评分 (id → 0-100 score) */
	recommendScores?: Map<string, number>;
	/** 名称排序时按需计算显示名（译名优先），避免调用方为排序额外拷贝整条插件对象 */
	displayNameOf?: (p: T) => string;
}

/**
 * 按维度排序，返回新数组（不修改入参）。稳定排序。
 */
export function sortPlugins<T extends SortablePlugin>(
	list: T[],
	sortBy: SortBy,
	options: SortOptions<T> = {}
): T[] {
	if (!list.length) return [];
	const arr = list.map((p, i) => ({ p, i }));

	const byOriginal = (a: { i: number }, b: { i: number }) => a.i - b.i;

	switch (sortBy) {
		case "downloads":
			arr.sort((a, b) => {
				const d = (b.p.downloads ?? 0) - (a.p.downloads ?? 0);
				return d !== 0 ? d : byOriginal(a, b);
			});
			break;
		case "updated":
			arr.sort((a, b) => {
				const av = a.p.updated ?? -Infinity;
				const bv = b.p.updated ?? -Infinity;
				const d = bv - av;
				return d !== 0 ? d : byOriginal(a, b);
			});
			break;
		case "published":
			arr.sort((a, b) => {
				const av = a.p.listIndex ?? -Infinity;
				const bv = b.p.listIndex ?? -Infinity;
				const d = bv - av;
				return d !== 0 ? d : byOriginal(a, b);
			});
			break;
		case "name":
			arr.sort((a, b) => {
				const da = options.displayNameOf ? options.displayNameOf(a.p) : (a.p.displayName ?? a.p.name);
				const db = options.displayNameOf ? options.displayNameOf(b.p) : (b.p.displayName ?? b.p.name);
				const d = da.localeCompare(db, "zh");
				return d !== 0 ? d : byOriginal(a, b);
			});
			break;
		case "popular":
			arr.sort((a, b) => {
				const ai = options.installedIds?.has(a.p.id) ? 1 : 0;
				const bi = options.installedIds?.has(b.p.id) ? 1 : 0;
				if (ai !== bi) return ai - bi;
				const d = (b.p.downloads ?? 0) - (a.p.downloads ?? 0);
				if (d !== 0) return d;
				const av = a.p.updated ?? -Infinity;
				const bv = b.p.updated ?? -Infinity;
				return bv - av !== 0 ? bv - av : byOriginal(a, b);
			});
			break;
		case "trending":
			arr.sort((a, b) => {
				const sa = options.trendingScores?.get(a.p.id) ?? 0;
				const sb = options.trendingScores?.get(b.p.id) ?? 0;
				const d = sb - sa;
				return d !== 0 ? d : byOriginal(a, b);
			});
			break;
		case "recommended":
			arr.sort((a, b) => {
				const sa = options.recommendScores?.get(a.p.id) ?? 0;
				const sb = options.recommendScores?.get(b.p.id) ?? 0;
				const d = sb - sa;
				return d !== 0 ? d : byOriginal(a, b);
			});
			break;
		case "relevance":
		default:
			break;
	}

	return arr.map((x) => x.p);
}

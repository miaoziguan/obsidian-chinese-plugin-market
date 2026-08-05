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
 *
 * 性能：decorate-sort-undecorate——先一趟 O(n) 预提取每个元素的排序 key
 * （Map.get / displayNameOf / 属性读取只做一次），比较器只比较已提取的 key，
 * 避免快排 O(n log n) 次比较中反复查表/回调。name 排序收益最大（原每次比较都调 displayNameOf）。
 */
export function sortPlugins<T extends SortablePlugin>(
	list: T[],
	sortBy: SortBy,
	options: SortOptions<T> = {}
): T[] {
	if (!list.length) return [];
	const byOriginal = (a: { i: number }, b: { i: number }) => a.i - b.i;

	switch (sortBy) {
		case "downloads": {
			const arr = list.map((p, i) => ({ p, i, key: p.downloads ?? 0 }));
			arr.sort((a, b) => {
				const d = b.key - a.key;
				return d !== 0 ? d : byOriginal(a, b);
			});
			return arr.map((x) => x.p);
		}
		case "updated": {
			const arr = list.map((p, i) => ({ p, i, key: p.updated ?? -Infinity }));
			arr.sort((a, b) => {
				const d = b.key - a.key;
				return d !== 0 ? d : byOriginal(a, b);
			});
			return arr.map((x) => x.p);
		}
		case "published": {
			const arr = list.map((p, i) => ({ p, i, key: p.listIndex ?? -Infinity }));
			arr.sort((a, b) => {
				const d = b.key - a.key;
				return d !== 0 ? d : byOriginal(a, b);
			});
			return arr.map((x) => x.p);
		}
		case "name": {
			const arr = list.map((p, i) => ({
				p,
				i,
				key: options.displayNameOf ? options.displayNameOf(p) : (p.displayName ?? p.name),
			}));
			arr.sort((a, b) => {
				const d = a.key.localeCompare(b.key, "zh");
				return d !== 0 ? d : byOriginal(a, b);
			});
			return arr.map((x) => x.p);
		}
		case "popular": {
			const arr = list.map((p, i) => ({
				p,
				i,
				installed: options.installedIds?.has(p.id) ? 1 : 0,
				downloads: p.downloads ?? 0,
				updated: p.updated ?? -Infinity,
			}));
			arr.sort((a, b) => {
				if (a.installed !== b.installed) return a.installed - b.installed;
				const d = b.downloads - a.downloads;
				if (d !== 0) return d;
				const u = b.updated - a.updated;
				return u !== 0 ? u : byOriginal(a, b);
			});
			return arr.map((x) => x.p);
		}
		case "trending": {
			const arr = list.map((p, i) => ({ p, i, key: options.trendingScores?.get(p.id) ?? 0 }));
			arr.sort((a, b) => {
				const d = b.key - a.key;
				return d !== 0 ? d : byOriginal(a, b);
			});
			return arr.map((x) => x.p);
		}
		case "recommended": {
			const arr = list.map((p, i) => ({ p, i, key: options.recommendScores?.get(p.id) ?? 0 }));
			arr.sort((a, b) => {
				const d = b.key - a.key;
				return d !== 0 ? d : byOriginal(a, b);
			});
			return arr.map((x) => x.p);
		}
		case "relevance":
		default:
			return list.slice();
	}
}

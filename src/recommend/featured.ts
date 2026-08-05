/**
 * Featured（官方推荐区）纯生产逻辑。
 *
 * P2-3：从 view-featured.ts 拆离——视图层只负责渲染与缓存，
 * 「展示哪些插件」的决策（引擎评分排序 → MMR 多样性重排 → 策划清单回退）
 * 收敛到推荐域，参数注入、零 DOM、可独立单测。
 */

import { DiversityReranker, type TaggedPlugin } from "./diversity";

/** Featured 区展示数量（引擎模式） */
export const ENGINE_FEATURED_COUNT = 4;
/** MMR 多样性重排的候选池大小 */
export const DIVERSITY_CANDIDATE_POOL = 20;

export interface FeaturedInput {
	/** 全量插件（仅需 id） */
	plugins: Array<{ id: string }>;
	/** 引擎评分（id → 0-100），无则回退策划清单 */
	recommendScores: Map<string, number> | null;
	/** 已安装插件 id 集合（引擎模式下过滤） */
	installedIds: Set<string>;
	/** 静态策划清单（plugin-recommend.json）id 集合 */
	curatedIds: Set<string>;
	/** 全量标签数据（id → {category, tags}），null 时跳过 MMR 直接按评分 */
	allTags: Record<string, { category: string; tags: string[] }> | null;
}

/**
 * 决定 Featured 区展示哪些插件。
 * 优先使用推荐引擎（多维度评分 + MMR 多样性），不可用时回退到策划清单。
 */
export function computeFeaturedIds(input: FeaturedInput): { ids: string[]; engineDriven: boolean } {
	const { plugins, recommendScores, curatedIds } = input;

	// 引擎模式：recommendScores 已在 recomputeSmartSignalsIfNeeded 中计算
	if (recommendScores && recommendScores.size > 0) {
		const ids = computeEngineFeatured(input);
		// 至少需要 2 个插件才启用引擎模式，不足时回退到策划清单
		if (ids.length >= 2) return { ids: ids.slice(0, ENGINE_FEATURED_COUNT), engineDriven: true };
	}

	// 回退：静态策划清单（plugin-recommend.json）
	if (curatedIds.size > 0) {
		const recPlugins = plugins.filter((p) => curatedIds.has(p.id));
		return { ids: recPlugins.map((p) => p.id).slice(0, 3), engineDriven: false };
	}

	return { ids: [], engineDriven: false };
}

/** 引擎驱动的 Featured 生产：评分排序 → MMR 多样性重排 → 过滤已安装 */
function computeEngineFeatured(input: FeaturedInput): string[] {
	const { plugins, recommendScores, installedIds, allTags } = input;

	const scored = plugins
		.map((p) => ({ id: p.id, score: recommendScores!.get(p.id) ?? 0 }))
		.filter((x) => x.score > 0)
		.sort((a, b) => b.score - a.score);

	if (scored.length === 0) return [];

	// MMR 多样性重排：防止 Featured 区全是一个分类的插件
	if (allTags) {
		// 仅对候选池（Top N）建标签索引即可：selectDiverse 只会从中挑选，
		// 避免对全量 scored（数千）建索引带来的不必要开销。
		const pool = scored.slice(0, DIVERSITY_CANDIDATE_POOL);
		const reranker = buildDiversityReranker(pool, allTags);
		const diverse = reranker.selectDiverse(pool, {
			topK: ENGINE_FEATURED_COUNT,
			lambda: 0.7,
			maxConsecutiveCategory: 1,
		});
		return diverse.filter((id) => !installedIds.has(id));
	}

	// 无标签数据：直接按评分降序，过滤已安装
	return scored
		.filter((x) => !installedIds.has(x.id))
		.map((x) => x.id)
		.slice(0, ENGINE_FEATURED_COUNT);
}

/** 构建 MMR 多样性重排器所需的标签输入 */
function buildDiversityReranker(
	scored: Array<{ id: string; score: number }>,
	allTags: Record<string, { category: string; tags: string[] }>,
): DiversityReranker {
	const tagged: TaggedPlugin[] = [];
	for (const { id } of scored) {
		const tag = allTags[id];
		tagged.push({
			id,
			category: tag?.category ?? "",
			tags: tag?.tags ?? [],
		});
	}
	return new DiversityReranker(tagged);
}

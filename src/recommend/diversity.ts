/**
 * 多样性重排序（Diversity Re-ranker）
 *
 * 问题：纯按评分排序会导致单一类别（如 template/toolbar）霸榜前 N 名。
 *   用户看到的可能是 20 个主题插件，而非多样化品类。
 *
 * 解法：MMR（Maximal Marginal Relevance）简化版：
 *   MMR(d, Q) = λ * rel(d) - (1-λ) * maxSim(d, selected)
 *   其中 rel(d) 为推荐引擎打分，maxSim(d, selected) 为当前插件与已选中插件的最大类别重叠度。
 *
 * 使用：
 *   const reRanker = new DiversityReranker(tags, categoryMap);
 *   const diverse = reRanker.selectDiverse(scored, { topK: 30, lambda: 0.7 });
 */

import type { PluginTag } from "../plugin-tags";

/** 多样性重排器的输入结构（PluginTag + 插件 id） */
export interface TaggedPlugin extends PluginTag {
	id: string;
}

// ───────── 配置 ─────────

export interface DiversityConfig {
	/** 相关性 vs 多样性的平衡参数 (0=纯多样性, 1=纯相关性) */
	lambda: number;
	/** 返回的多样化结果数量 */
	topK: number;
	/** 同类别最多允许连续出现的次数 */
	maxConsecutiveCategory: number;
}

export const DEFAULT_DIVERSITY_CONFIG: DiversityConfig = {
	lambda: 0.75,
	topK: 30,
	maxConsecutiveCategory: 2,
};

export interface ScoredPlugin {
	id: string;
	score: number;
}

// ───────── 核心 ─────────

export class DiversityReranker {
	/** pluginId → category */
	private categoryMap: Map<string, string>;
	/** pluginId → tags[] */
	private tagMap: Map<string, string[]>;

	constructor(
		tags: TaggedPlugin[],
		categoryMap?: Map<string, string>
	) {
		this.categoryMap = categoryMap ?? new Map();

		// 建立查表索引
		this.tagMap = new Map();
		for (const t of tags) {
			this.tagMap.set(t.id, t.tags ?? []);
			if (!this.categoryMap.has(t.id) && t.category) {
				this.categoryMap.set(t.id, t.category);
			}
		}
	}

	/**
	 * MMR 多样性选择。
	 *
	 * @param scored 已按推荐分排好序的插件列表（降序）
	 * @param config 多样性配置
	 * @returns 重排序后的插件 id 列表
	 */
	selectDiverse(
		scored: ScoredPlugin[],
		config: Partial<DiversityConfig> = {}
	): string[] {
		const cfg = { ...DEFAULT_DIVERSITY_CONFIG, ...config };
		if (scored.length === 0) return [];

		// 已选择的插件 id 集合
		const selected = new Set<string>();
		// 最终结果（保持顺序）
		const result: string[] = [];

		// 第一步：选择最高分
		const top = scored[0];
		selected.add(top.id);
		result.push(top.id);

		// 按同类别连续出现计数。
		// 修复：首项类别曾未计入历史，导致同类别实际可连续出现
		// maxConsecutiveCategory + 1 次（首项对连续控制"隐身"）。
		const lastCategories: string[] = [this.categoryMap.get(top.id) ?? ""];

		// MMR 迭代
		for (let round = 1; round < Math.min(cfg.topK, scored.length); round++) {
			let best: ScoredPlugin | null = null;
			let bestMMR = -Infinity;

			for (const item of scored) {
				if (selected.has(item.id)) continue;

				// 计算与已选插件中最大相似度
				const maxSim = this.maxSimilarity(item.id, selected);
				const mmr = cfg.lambda * item.score - (1 - cfg.lambda) * maxSim;

				// 同类别连续控制：若此插件类别与最近 maxConsecutiveCategory 个一致，额外惩罚
				const penaltyCat = this.consecutiveCategoryPenalty(item.id, lastCategories, cfg.maxConsecutiveCategory);

				const finalMMR = mmr - penaltyCat;

				if (finalMMR > bestMMR) {
					bestMMR = finalMMR;
					best = item;
				}
			}

			if (!best) break;

			selected.add(best.id);
			result.push(best.id);

			// 更新最近类别历史
			const cat = this.categoryMap.get(best.id) ?? "";
			lastCategories.push(cat);
			if (lastCategories.length > cfg.maxConsecutiveCategory) {
				lastCategories.shift();
			}
		}

		return result;
	}

	// ───────── 私有方法 ─────────

	/**
	 * 计算 itemId 与已选集合中任意插件的最大类别/标签相似度。
	 *
	 * 相似度定义：
	 *   - category 完全相同：1.0
	 *   - tag 交集大小 / union 大小（Jaccard）
	 *   - 取上述最大值
	 */
	private maxSimilarity(itemId: string, selected: Set<string>): number {
		const itemCat = this.categoryMap.get(itemId) ?? "";
		const itemTags = new Set(this.tagMap.get(itemId) ?? []);

		let maxSim = 0;
		for (const selId of selected) {
			const selCat = this.categoryMap.get(selId) ?? "";

			// 类别完全相同，直接返回 1（最高相似度）
			if (itemCat && selCat && itemCat === selCat) {
				return 1;
			}

			// Jaccard 标签相似度
			const selTags = new Set(this.tagMap.get(selId) ?? []);
			if (itemTags.size === 0 && selTags.size === 0) continue;

			const intersect = new Set([...itemTags].filter((t) => selTags.has(t)));
			const union = new Set([...itemTags, ...selTags]);
			const jaccard = intersect.size / union.size;

			maxSim = Math.max(maxSim, jaccard);
		}

		return maxSim;
	}

	/**
	 * 如果 item 的类别与最近 N 个已选插件类别完全相同，施加惩罚。
	 * 防止同一类别连续出现超过 maxConsecutive 次。
	 */
	private consecutiveCategoryPenalty(
		itemId: string,
		lastCategories: string[],
		maxConsecutive: number
	): number {
		const cat = this.categoryMap.get(itemId) ?? "";
		if (!cat) return 0;

		const recent = lastCategories.slice(-maxConsecutive);
		if (recent.length >= maxConsecutive && recent.every((c) => c === cat)) {
			return 1.0; // 强惩罚，等价于打了同类别后分数直接减半（在 0-100 评分空间里很高）
		}
		return 0;
	}
}

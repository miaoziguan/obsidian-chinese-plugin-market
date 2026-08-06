/**
 * 相似插件推荐引擎（增强版 v2）。
 *
 * v2 改进：
 *   - 中文分词从单字升级为 bi-gram（大幅提升语义相关性）
 *   - 引入倒排索引（InvertedIndex），tag/category 查表从 O(n*m) 降至 O(1)
 *   - 得分归一化：对「描述关键词重叠」得分做 TF-IDF 风格稀释
 *
 * 策略：基于分类/标签/描述的混合评分，完全不依赖真实用户行为数据。
 */

import type { PluginTag } from "@domain/catalog/plugin-tags";

// ───────── 导出类型 ─────────

/** 结构化推荐信号（用于「相似推荐」卡片上可扫描的 chips） */
export interface SimilarSignals {
	/** 同分类（若有） */
	category?: string;
	/** 共享标签数量 */
	sharedTags: number;
	/** 共享的具体标签名（用于折叠概要中展示具体标签预览） */
	sharedTagNames: string[];
	/** 描述关键词有重叠 */
	descSimilar: boolean;
}

export interface SimilarCandidate {
	id: string;
	name: string;
	translatedName: string;
	reason: string;
	/** 相似度得分（已按相关度排序，越大越相关），用于强度条 */
	score: number;
	/** 结构化推荐理由信号，用于可扫描的 chips */
	signals: SimilarSignals;
	/** 下载量（用于推荐卡片微信号） */
	downloads?: number;
}

// ───────── 倒排索引（Inverted Index） ─────────

/**
 * 倒排索引：从「类别/标签/关键词」→ 拥有该属性的插件 ID 集合。
 *
 * 为什么需要它：
 *   原 computeSimilar 每次调用都要遍历全量插件（O(n*m)），
 *   n = 所有插件数（~3000），m = 标签查表次数。
 *   用倒排索引后，查询受影响的候选集直接通过 set 交集定位，
 *   约 O(k) 其中 k = 共享分类或标签的插件数（通常 << n）。
 */
export class InvertedIndex {
	/** category → 拥有该分类的插件 id 集合 */
	private byCategory = new Map<string, Set<string>>();
	/** tag → 拥有该标签的插件 id 集合 */
	private byTag = new Map<string, Set<string>>();

	/**
	 * 从 PluginTag 数组构建倒排索引。
	 * 在所有插件和标签数据加载后调用一次。
	 */
	build(tags: (PluginTag & { id: string })[]): void {
		this.byCategory.clear();
		this.byTag.clear();

		for (const entry of tags) {
			// 类别
			if (entry.category) {
				let s = this.byCategory.get(entry.category);
				if (!s) {
					s = new Set();
					this.byCategory.set(entry.category, s);
				}
				s.add(entry.id);
			}

			// 标签
			if (entry.tags) {
				for (const tag of entry.tags) {
					let s = this.byTag.get(tag);
					if (!s) {
						s = new Set();
						this.byTag.set(tag, s);
					}
					s.add(entry.id);
				}
			}
		}
	}

	/**
	 * 获取与 sourceId 共享 category 或 tag 的候选插件 id 集合。
	 * @returns 候选集（不含 sourceId 自身），未命中返回空集
	 */
	getCandidates(sourceId: string, sourceTag: PluginTag | null): Set<string> {
		const candidates = new Set<string>();

		if (!sourceTag) return candidates;

		// 同分类插件
		if (sourceTag.category) {
			const same = this.byCategory.get(sourceTag.category);
			if (same) {
				for (const id of same) {
					if (id !== sourceId) candidates.add(id);
				}
			}
		}

		// 共享标签插件
		if (sourceTag.tags) {
			for (const tag of sourceTag.tags) {
				const shared = this.byTag.get(tag);
				if (shared) {
					for (const id of shared) {
						if (id !== sourceId) candidates.add(id);
					}
				}
			}
		}

		return candidates;
	}
}

// ───────── 增强分词 ─────────

/**
 * 中英文混合 bi-gram 分词器。
 *
 * 改进点：
 *   - 中文：双字 bi-gram 滑动窗口（"看板任务管理" → ["看板", "板任", "任务", "务管", "管理"]）
 *     比单字有更强的语义区分度
 *   - 英文：按空格拆分，过滤停用词（a/the/is 等）
 *   - 统一 lower case
 */
function tokenizeBigram(text: string): string[] {
	const trimmed = text.trim();
	if (!trimmed) return [];

	const tokens: string[] = [];

	// 按标点分割片段
	const segments = trimmed.split(/[\]\s,，。；;、!！?？·[()（）""''""'']+/);

	for (const seg of segments) {
		if (!seg) continue;

		if (/^[\w\d\-.]+$/.test(seg)) {
			// 英文部分：过滤短词和停用词
			const lower = seg.toLowerCase();
			if (lower.length >= 3 && !EN_STOP_WORDS.has(lower)) {
				tokens.push(lower);
			}
		} else {
			// 中文 + 中英混合部分
			// 先提取连续的汉字序列
			const hanSeq = seg.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
			for (const hs of hanSeq) {
				if (hs.length >= 2) {
					// bi-gram 滑动窗口
					for (let i = 0; i < hs.length - 1; i++) {
						tokens.push(hs.slice(i, i + 2));
					}
				} else {
					// 单字直接保留
					tokens.push(hs);
				}
			}
		}
	}

	return tokens;
}

/** 英文高频停用词（对推荐无区分度） */
const EN_STOP_WORDS = new Set([
	"the", "a", "an", "is", "are", "was", "were", "be", "been",
	"in", "on", "at", "to", "for", "of", "with", "and", "or",
	"it", "its", "this", "that", "you", "your", "can", "will",
	"not", "no", "has", "have", "had", "do", "does", "did",
	"from", "by", "as", "but", "all", "so", "we", "our",
]);

// ───────── 传统分词（保留兼容，用于降级场景） ─────────

function tokenize(text: string): string[] {
	return tokenizeBigram(text);
}

// ───────── 核心评分 ─────────

interface ScoredItem {
	p: { id: string; name: string; description: string; downloads?: number };
	candidateTag: PluginTag | null;
	score: number;
	descSimilar: boolean;
}

/**
 * 计算两个插件的相似度得分（性能版）。
 *
 * 加权策略：
 *   - 同分类 +4（最强信号，对推荐信任度最高）
 *   - 共享标签 +2 per tag（中等信号）
 *   - 描述关键词重叠：TF-IDF 风格稀释后的分数
 *
 * 性能：source 侧的分词/标签 Set 由调用方预计算一次传入
 * （旧实现每个候选都重新 tokenize(sourceDesc) + new Set(sourceTag.tags)，
 *  热门分类上千候选时一次打开阻塞主线程数百 ms）。
 */
function scoreSimilarity(
	sourceTag: PluginTag | null,
	candidateTag: PluginTag | null,
	sourceTagSet: Set<string> | null,
	sourceTokenSet: Set<string>,
	sourceTokensLen: number,
	candidateDesc: string
): { score: number; descSimilar: boolean } {
	let score = 0;
	let descSimilar = false;

	// 同分类 +4
	if (sourceTag?.category && candidateTag?.category && sourceTag.category === candidateTag.category) {
		score += 4;
	}

	// 共享标签 +2 per tag
	if (sourceTagSet && candidateTag?.tags) {
		for (const t of candidateTag.tags) {
			if (sourceTagSet.has(t)) score += 2;
		}
	}

	// 描述关键词重叠（TF-IDF 稀释版）
	const candidateTokens = tokenize(candidateDesc);

	if (sourceTokensLen > 0 && candidateTokens.length > 0) {
		// 单趟同时统计交集/并集的 distinct 计数。
		// 修复：交集曾按「含重复」计数而并集按 distinct 计数，口径不一致，
		// 重复词多的候选 Jaccard 可超过 1，描述重叠分数被系统性放大。
		let overlap = 0; // |A ∩ B|（distinct）
		const candidateSeen = new Set<string>();
		let distinctNotInSource = 0; // |B \ A|（distinct）
		for (const t of candidateTokens) {
			if (candidateSeen.has(t)) continue;
			candidateSeen.add(t);
			if (sourceTokenSet.has(t)) overlap++;
			else distinctNotInSource++;
		}

		// TF-IDF 风格稀释：用 Jaccard 相似度替代原始计数
		// Jaccard = |A ∩ B| / |A ∪ B|
		const unionSize = sourceTokenSet.size + distinctNotInSource;
		if (unionSize > 0) {
			const jaccard = overlap / unionSize;
			// 描述重叠的权重较低（描述噪声高），用 2 倍 Jaccard
			score += jaccard * 2;
		}
		descSimilar = overlap > 0;
	}

	return { score, descSimilar };
}

// ───────── 理由生成 ─────────

/** 从 source/candidate 标签 + 描述重叠标志，提炼结构化推荐信号 */
function makeSignals(
	sourceTag: PluginTag | null,
	candidateTag: PluginTag | null,
	descSimilar: boolean
): SimilarSignals {
	const sig: SimilarSignals = { sharedTags: 0, sharedTagNames: [], descSimilar };

	if (sourceTag?.category && candidateTag?.category && sourceTag.category === candidateTag.category) {
		sig.category = sourceTag.category;
	}

	if (sourceTag?.tags && candidateTag?.tags) {
		const shared = sourceTag.tags.filter((t) => candidateTag.tags.includes(t));
		sig.sharedTags = shared.length;
		sig.sharedTagNames = shared.sort();
	}

	return sig;
}

/** 把结构化信号拼成一句可读理由（兼容旧 reason 文本用途） */
function makeReason(signals: SimilarSignals): string {
	const parts: string[] = [];

	if (signals.category) parts.push(`同分类：${signals.category}`);
	// 展示具体共享标签名（前 2 个），避免同分类下所有候选理由完全相同
	if (signals.sharedTags > 0 && signals.sharedTagNames.length > 0) {
		const preview = signals.sharedTagNames.slice(0, 2).join("、");
		parts.push(`标签：${signals.sharedTags}${preview !== String(signals.sharedTags) ? `（${preview}）` : ""}`);
	}
	if (signals.descSimilar) parts.push("描述相关");

	return parts.length > 0 ? parts.join(" · ") : "功能相似";
}

// ───────── 公开 API ─────────

/**
 * 计算指定插件的相似推荐列表。
 *
 * @param sourceId 当前查看的插件 ID
 * @param sourceDesc 当前插件的英文描述
 * @param allPlugins 全量插件列表（至少需要 {id, name, description} 字段）
 * @param tagService 分类标签查询器
 * @param translatedNames 已翻译名称映射（id → translatedName）
 * @param topN 返回前 N 个
 * @param invertedIndex 可选倒排索引（不传则退化为全量扫描，兼容性保证）
 */
export function computeSimilar(
	sourceId: string,
	sourceDesc: string,
	allPlugins: Array<{ id: string; name: string; description: string; downloads?: number }>,
	tagService: { getTag: (id: string) => PluginTag | null },
	translatedNames: Record<string, string>,
	topN = 5,
	invertedIndex?: InvertedIndex
): SimilarCandidate[] {
	const sourceTag = tagService.getTag(sourceId);

	let candidates: Array<{ id: string; name: string; description: string; downloads?: number }>;

	if (invertedIndex) {
		// 快速路径：倒排索引定位候选集
		const candidateIds = invertedIndex.getCandidates(sourceId, sourceTag);
		if (candidateIds.size === 0) {
			return [];
		}
		// 构建 id → 插件对象的快速映射
		const idToPlugin = new Map(allPlugins.map((p) => [p.id, p]));
		candidates = [...candidateIds]
			.map((id) => idToPlugin.get(id))
			.filter((p): p is NonNullable<typeof p> => p != null);
	} else {
		// 降级路径：全量扫描（向后兼容）
		candidates = allPlugins.filter((p) => p.id !== sourceId);
	}

	// source 侧只算一次（旧实现每个候选重复 tokenize + new Set，是打开详情页的主要卡点）
	const sourceTokens = tokenize(sourceDesc);
	const sourceTokenSet = new Set(sourceTokens);
	const sourceTagSet = sourceTag?.tags ? new Set(sourceTag.tags) : null;

	// 打分 + 排序 + TopN
	const scored: ScoredItem[] = [];
	for (const p of candidates) {
		const candidateTag = tagService.getTag(p.id);
		const { score, descSimilar } = scoreSimilarity(sourceTag, candidateTag, sourceTagSet, sourceTokenSet, sourceTokens.length, p.description);
		if (score > 0) {
			scored.push({ p, candidateTag, score, descSimilar });
		}
	}

	scored.sort((a, b) => b.score - a.score);
	const top = scored.slice(0, topN);

	return top.map(({ p, candidateTag, score, descSimilar }) => {
		const signals = makeSignals(sourceTag, candidateTag, descSimilar);
		return {
			id: p.id,
			name: p.name,
			translatedName: translatedNames[p.id] || p.name,
			reason: makeReason(signals),
			score,
			signals,
			downloads: p.downloads,
		};
	});
}

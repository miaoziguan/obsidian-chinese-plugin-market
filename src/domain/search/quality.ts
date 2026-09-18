/**
 * 排序质量因子（补丁 B）：recency × popularity
 *
 * 动机（search-engine v2_2 差距对标 ③）：RRF 融合分只看三路召回的相关性名次，
 * 两个相关度相当的插件——弃坑 4 年的和上周刚更新的、2000 下载的和 200 万下载的——
 * 排序纯凭词面运气。stats 数据（downloads/updated，来自 community-plugin-stats.json）
 * 此前只在卡片 UI 展示，排序完全没消费。本模块把「还在维护的、用的人多的」
 * 变成平局区的裁决信号。
 *
 * 设计红线：
 * - **质量因子只做 tie-break，不许喧宾夺主**。乘性带宽 [0.85, 1.15]，在 RRF(k=60)
 *   相邻名次分差（≈1.6%）下约等于移动 6-8 个名次：平局区内能翻盘，
 *   相关度差距大的翻不动——热门永远压不过相关。
 * - **缺失一律中性 1.0**：没有 stats 数据的插件（新上架/抓取失败）不受罚也不获益。
 * - 与 search-engine `recency_factor`（SearchEngine.cc，无下限 exp(-age/365)）的差异是
 *   **有意温和化**：文档检索里陈旧≈失效，可以狠压；插件市场 2 年未更新但能用的
 *   插件大量存在，不配当过期文档处理，故加 0.85 下限 + 730d 时间常数。
 * - LLM 精排不消费本因子（保持纯相关性）；AI 模式下因子只影响候选池的入选与截断顺序。
 *
 * 不触碰任何缓存签名：因子按查询现算（O(N) 单遍，7700 条 <1ms），
 * 不进 bm25IndexSig、不进向量 fieldsHash——零 re-embed、零索引重建。
 */

// ───────── 调参常量（集中于此；待评测集落地后统一校准，勿在别处散落魔数） ─────────

/**
 * recency 指数衰减的时间常数（天）。注意语义：exp(-age/τ)，age=τ 时因子=e⁻¹≈0.37，
 * 但会被下限钳住——实际触底点在 age = -ln(0.85)·τ ≈ 119 天。
 * 即 recency 实为「近 ~4 个月内维护过」的渐变加成（0-119d 区间 1.0→0.85），
 * 更老的插件一律钉在下限、彼此不再区分（弃坑 2 年 == 弃坑 4 年，可接受：
 * 二者对用户都是「不活跃」）。调大 τ 会拉长渐变区间，等 ④ 评测定夺。
 */
const RECENCY_TAU_DAYS = 730;
/** recency 下限：再老最多降 15%，保证「老而名字精确命中」的插件不被沉底 */
const RECENCY_FLOOR = 0.85;
/** popularity 对数加成幅度：下载量 = 全表最大值时因子 = 1 + 该值 */
const POPULARITY_GAIN = 0.15;

const MS_PER_DAY = 86400000;

/** 质量因子所需的最小插件字段（PluginInfo 的结构子集，保持本模块零依赖） */
export interface QualityInput {
	id: string;
	downloads?: number;
	updated?: number;
}

/**
 * 新鲜度因子：exp(-ageDays/τ)，钳到 [RECENCY_FLOOR, 1.0]。
 * 缺失/非法/未来时间戳（时钟漂移、stats 脏数据）一律中性 1.0——
 * 未来时间戳若按负 age 算会得 exp(正数)>1 的隐性加成，必须显式挡掉
 * （search-engine recency_factor 对 age≤0 同样返回 1.0）。
 */
export function recencyFactor(updated: number | undefined, now = Date.now()): number {
	if (typeof updated !== "number" || !Number.isFinite(updated) || updated <= 0) return 1.0;
	const ageDays = (now - updated) / MS_PER_DAY;
	if (ageDays <= 0) return 1.0;
	return Math.max(RECENCY_FLOOR, Math.exp(-ageDays / RECENCY_TAU_DAYS));
}

/**
 * 热度因子：1 + GAIN·log10(1+dl)/log10(1+maxDl)，值域 [1.0, 1+GAIN]。
 * 对数刻度压制「富者愈富」：下载量差 1000 倍的两个插件，因子差不到
 * GAIN·(3/log10(maxDl))——头部插件的加成收敛，新插件主要靠 recency 竞争。
 * dl 缺失/非正、maxDl 非正（全表都没有 stats，防 log10(1)=0 除零）→ 中性 1.0；
 * dl > maxDl（传入列表与 maxDl 计算来源不一致的防御）→ 比值钳到 1。
 */
export function popularityFactor(downloads: number | undefined, maxDownloads: number): number {
	if (typeof downloads !== "number" || !Number.isFinite(downloads) || downloads <= 0) return 1.0;
	if (!Number.isFinite(maxDownloads) || maxDownloads <= 0) return 1.0;
	const denom = Math.log10(1 + maxDownloads);
	const ratio = Math.min(1, Math.log10(1 + downloads) / denom);
	return 1 + POPULARITY_GAIN * ratio;
}

/** 单插件质量因子 = recency × popularity；插件缺失（fused 里有 id 但列表查不到）→ 中性 1.0 */
export function qualityFactor(p: QualityInput | undefined, maxDownloads: number, now = Date.now()): number {
	if (!p) return 1.0;
	return recencyFactor(p.updated, now) * popularityFactor(p.downloads, maxDownloads);
}

/**
 * 对 RRF 融合分逐 id 乘质量因子，返回**新 Map**（纯函数，不改入参）。
 * 插在 rrfFuse 之后、topNFused 之前：既影响候选池截断（AI 模式），
 * 也直接塑造最终排序（本地语义模式，无 LLM 精排，是它的主战场）。
 * maxDownloads 就地单遍求出（O(N)），不依赖外部预计算。
 */
export function applyQualityFactors(
	fused: Map<string, number>,
	plugins: QualityInput[],
	now = Date.now()
): Map<string, number> {
	let maxDl = 0;
	const byId = new Map<string, QualityInput>();
	for (const p of plugins) {
		byId.set(p.id, p);
		if (typeof p.downloads === "number" && Number.isFinite(p.downloads) && p.downloads > maxDl) {
			maxDl = p.downloads;
		}
	}
	const out = new Map<string, number>();
	for (const [id, score] of fused) {
		out.set(id, score * qualityFactor(byId.get(id), maxDl, now));
	}
	return out;
}

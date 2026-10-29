/**
 * 轻量 CJK 感知 BM25（借鉴 vault-curate 的 cjkTokenize + bm25）。
 *
 * 为什么替代「简单关键词重叠」：中文无空格，简单重叠需要精确整词匹配，对词边界
 * 歧义/同义/变体不鲁棒。BM25 用 CJK n-gram 分词 + IDF：
 *   - IDF 天然降权「插件」「工具」等高频词（内置停用词效果）；
 *   - n-gram 让任意连续 2-3 字可命中（容忍词边界/切分歧义；bigram 兜 2 字 query
 *     打长 run 的盲区——旧纯 trigram 在「门禁」×「门禁系统管理工具」恒漏，
 *     ④ harness 实测 short 桶 Recall@10 0.40→0.58）；
 *   - 文档长度归一化避免长 description 天然占优。
 *
 * 本模块只提供「分词 + 打分原语」（纯函数，已单测）。倒排索引由调用方
 * （ai.ts 的 Bm25Index）按插件列表预构建并跨多次搜索复用，召回时只对命中
 * query term 的文档累加分数 —— 不在此模块建索引，是为了让打分原语保持
 * 无状态、可独立测试。
 */

const CJK_RE = /[㐀-鿿豈-﫿]/;
const ASCII_WORD_RE = /[a-zA-Z0-9_-]/;

/**
 * 分词器版本指纹：进 bm25IndexSig——分词策略变更（n-gram 组合/换 Intl 等）必须 bump，
 * 令 BM25 索引缓存失效重建（P-0055 同族：索引语义变了缓存必须跟着失效）。
 */
export const BM25_TOKENIZER_VERSION = "cjk-intl-bi23-v1";

// Intl.Segmenter 词层（零依赖零资产：ICU 内置词典）。类型用结构化最小接口 + any 构造，
// 避免 tsconfig lib 未含 ES2022 Intl 类型时编译失败；运行时特性探测兜底老环境。
interface SegmentLike {
	segment(text: string): Iterable<{ segment: string; isWordLike?: boolean }>;
}
const IntlRecord: Record<string, unknown> =
	typeof Intl !== "undefined" ? Intl : {};
const SegmenterCtor = IntlRecord.Segmenter as
	| (new (locale: string, opts: { granularity: string }) => SegmentLike)
	| undefined;
const intlSegmenter: SegmentLike | null =
	typeof SegmenterCtor === "function" ? new SegmenterCtor("zh-Hans", { granularity: "word" }) : null;

/** ICU 词典词（isWordLike 过滤 + 小写）；无词层环境返回空数组。 */
export function segmentWords(text: string): string[] {
	if (!intlSegmenter || !text) return [];
	const out: string[] = [];
	for (const s of intlSegmenter.segment(text)) if (s.isWordLike) out.push(s.segment.toLowerCase());
	return out;
}

function isCJK(ch: string): boolean {
	return CJK_RE.test(ch);
}
function isAsciiWord(ch: string): boolean {
	return ASCII_WORD_RE.test(ch);
}
function isHighSurrogate(ch: string): boolean {
	const code = ch.charCodeAt(0);
	return code >= 0xd800 && code <= 0xdbff;
}

/** CJK 三元组 + ASCII 词 分词（借鉴 vault-curate）：返回空格分隔的 token 串。 */
export function tokenizeCJK(text: string): string {
	if (!text) return "";
	const tokens: string[] = [];
	const n = text.length;
	let i = 0;
	while (i < n) {
		const ch = text[i];
		if (isCJK(ch)) {
			let end = i;
			while (end < n && isCJK(text[end])) end++;
			const run = text.slice(i, end);
			if (run.length <= 3) {
				tokens.push(run);
			} else {
				// bigram+trigram（④ harness 2026-09-18 裁决采纳：short 桶 Recall@10 0.40→0.58、
				// MRR +0.04、general 桶代价 -0.02）：bigram 让 2 字 query 命中长 run
				// （「门禁」×「门禁系统管理工具」，旧纯 trigram 恒漏），trigram 保留邻接精度；
				// 成本 = 索引 token +55%（418k→648k 实测）。gram 顺序 [2,3] 与 harness
				// ngramTok([2,3]) 同构（parity 基线）。
				for (let s = 0; s <= run.length - 2; s++) tokens.push(run.slice(s, s + 2));
				for (let s = 0; s <= run.length - 3; s++) tokens.push(run.slice(s, s + 3));
			}
			i = end;
		} else if (isAsciiWord(ch)) {
			let end = i;
			while (end < n && isAsciiWord(text[end])) end++;
			tokens.push(text.slice(i, end).toLowerCase());
			i = end;
		} else if (isHighSurrogate(ch) && i + 1 < n) {
			tokens.push(text.slice(i, i + 2));
			i += 2;
		} else {
			i++;
		}
	}
	return tokens.join(" ");
}

/** 文本 → BM25 token 数组 = Intl.Segmenter 词层 ∪ CJK n-gram 层。
 * 词层（2026-09-20 用户裁决采纳，harness 实测 oov 桶 R@10 0.42→0.64、脑图首金 #14→#3）：
 * ICU 词典词让 3 字 run 等 n-gram 盲区（run≤3 不产 bigram）获得子词命中；
 * 代价 = 头部短 query 竞争者变多（日历首金 #1→#4 等，部分系评测窄 gold 放大），
 * MRR 0.630→0.572——已批准的取舍，基线记录在案。
 * 环境无 Intl.Segmenter（老 WebView）时词层为空、退化为纯 n-gram，
 * 由 bm25IndexSig 的可用性指纹区分（索引语义不同不可互用）。 */
export function tokenizeForBM25(text: string): string[] {
	if (!text) return [];
	const s = tokenizeCJK(text);
	const grams = s ? s.split(" ").filter((t) => t.length > 0) : [];
	return [...segmentWords(text), ...grams];
}

/** BM25 调参常量：k1 控制词频饱和速度，b 控制文档长度归一化强度。 */
export const BM25_K1 = 1.5;
export const BM25_B = 0.75;

/**
 * 单个 term 的 IDF（BM25+ 变体：末尾 +1 保证恒 ≥ 0，避免 df > N/2 时出现负分）。
 * 只依赖 (df, N)、与文档无关 —— 抽出来供倒排召回按 term 预计算一次，
 * 而不是放在文档循环里重复 Math.log。
 */
export function bm25Idf(dfVal: number, N: number): number {
	return Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1);
}

/**
 * 长度归一分母：相对全库平均长度归一。avgdl <= 0 时退化为 1（无惩罚），
 * 避免除零得到 NaN。
 */
export function bm25LenNorm(docLen: number, avgdl: number, b = BM25_B): number {
	return avgdl > 0 ? 1 - b + b * (docLen / avgdl) : 1;
}

/**
 * 单个 term 对总分的贡献（不含 query 侧权重）：tf 经 k1 饱和、再除以长度归一分母。
 * 倒排召回按 posting 累加时与 bm25Score 共用同一公式，避免两处取值漂移。
 */
export function bm25TermWeight(tf: number, lenNorm: number, k1 = BM25_K1): number {
	return (tf * (k1 + 1)) / (tf + k1 * lenNorm);
}

/**
 * 轻量 BM25 打分：query 与单条文档的相似度。
 *
 * ⚠️ 生产路径不走这里 —— 线上召回用 ai.ts 的倒排索引（bm25RecallScores），
 * 逐条遍历全库 + 每条重建 tf Map 会慢约 40~65x（随语料与查询分布波动，跑
 * scripts/bench-search-perf.mjs 实验 1 可复现）。本函数是**参考实现**：
 * ai.test.ts 用它作为对照，验证倒排路径的分数与逐条打分逐位一致。勿当死代码删除。
 *
 * @param avgdl 全库平均文档长度（token 数）。用于 BM25 长度归一化，
 *   使长 description 不会被恒久压低（vault-curate 同款标准 BM25 写法）。
 *   调用方在算 df 的全库遍历里顺便累加 token 数即可，成本可忽略。 */
export function bm25Score(
	queryTokens: string[],
	docTokens: string[],
	df: Map<string, number>,
	N: number,
	avgdl: number,
	k1 = BM25_K1,
	b = BM25_B,
	precomputedQtf?: Map<string, number>
): number {
	if (queryTokens.length === 0 || docTokens.length === 0) return 0;
	const docLen = docTokens.length;

	// query term 出现次数（叠词加权）。qtf 只依赖 query，不随文档变——
	// 批量打分时由调用方预计算一次传入（precomputedQtf），避免每文档重建。
	const qtf = precomputedQtf ?? (() => {
		const m = new Map<string, number>();
		for (const t of queryTokens) m.set(t, (m.get(t) ?? 0) + 1);
		return m;
	})();

	// 文档 term 频率
	const tf = new Map<string, number>();
	for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);

	const lenNorm = bm25LenNorm(docLen, avgdl, b);

	let score = 0;
	for (const [term, qtfCount] of qtf) {
		const tfn = tf.get(term) ?? 0;
		if (tfn === 0) continue;
		score += qtfCount * bm25Idf(df.get(term) ?? 0, N) * bm25TermWeight(tfn, lenNorm, k1);
	}
	return score;
}

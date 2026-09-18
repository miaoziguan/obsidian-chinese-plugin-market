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
 * 本实现不预构建倒排索引（插件列表每次刷新，场景是搜索时对当前几千条算分），
 * 输出 BM25 分（供 RRF 融合只看排名）。
 */

const CJK_RE = /[㐀-鿿豈-﫿]/;
const ASCII_WORD_RE = /[a-zA-Z0-9_-]/;

/**
 * 分词器版本指纹：进 bm25IndexSig——分词策略变更（n-gram 组合/换 Intl 等）必须 bump，
 * 令 BM25 索引缓存失效重建（P-0055 同族：索引语义变了缓存必须跟着失效）。
 */
export const BM25_TOKENIZER_VERSION = "cjk-bi23-v1";

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

/** 文本 → BM25 token 数组。 */
export function tokenizeForBM25(text: string): string[] {
	if (!text) return [];
	const s = tokenizeCJK(text);
	if (!s) return [];
	return s.split(" ").filter((t) => t.length > 0);
}

/** 轻量 BM25 打分：query 与单条文档的相似度（不预构建倒排，搜索时算）。
 * @param avgdl 全库平均文档长度（token 数）。用于 BM25 长度归一化，
 *   使长 description 不会被恒久压低（vault-curate 同款标准 BM25 写法）。
 *   调用方在算 df 的全库遍历里顺便累加 token 数即可，成本可忽略。 */
export function bm25Score(
	queryTokens: string[],
	docTokens: string[],
	df: Map<string, number>,
	N: number,
	avgdl: number,
	k1 = 1.5,
	b = 0.75,
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

	// 长度归一分母：相对全库平均长度的归一（avgdl 为 0 时退化为无惩罚，避免 NaN）
	const lenNorm = avgdl > 0 ? 1 - b + b * (docLen / avgdl) : 1;

	let score = 0;
	for (const [term, qtfCount] of qtf) {
		const tfn = tf.get(term) ?? 0;
		if (tfn === 0) continue;
		const dfVal = df.get(term) ?? 0;
		const idf = Math.log((N - dfVal + 0.5) / (dfVal + 0.5) + 1); // BM25+，恒 ≥0
		const denom = tfn + k1 * lenNorm;
		score += qtfCount * idf * ((tfn * (k1 + 1)) / denom);
	}
	return score;
}

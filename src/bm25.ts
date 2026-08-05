/**
 * 轻量 CJK 感知 BM25（借鉴 vault-curate 的 cjkTokenize + bm25）。
 *
 * 为什么替代「简单关键词重叠」：中文无空格，简单重叠需要精确整词匹配，对词边界
 * 歧义/同义/变体不鲁棒。BM25 用 CJK 三元组分词 + IDF：
 *   - IDF 天然降权「插件」「工具」等高频词（内置停用词效果）；
 *   - 三元组让任意连续 3 字可命中（容忍词边界/切分歧义）；
 *   - 文档长度归一化避免长 description 天然占优。
 *
 * 本实现不预构建倒排索引（插件列表每次刷新，场景是搜索时对当前几千条算分），
 * 输出 BM25 分（供 RRF 融合只看排名）。
 */

const CJK_RE = /[㐀-鿿豈-﫿]/;
const ASCII_WORD_RE = /[a-zA-Z0-9_-]/;

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
				for (let s = 0; s <= run.length - 3; s++) {
					tokens.push(run.slice(s, s + 3));
				}
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
	b = 0.75
): number {
	if (queryTokens.length === 0 || docTokens.length === 0) return 0;
	const docLen = docTokens.length;

	// query term 出现次数（叠词加权）
	const qtf = new Map<string, number>();
	for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);

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

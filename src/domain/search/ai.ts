/**
 * AI 搜索 + 对比管线
 *
 * 从 Translator God Object 中抽出，独立管理整个 AI 管线：
 * - 向量语义召回（embedding）
 * - LLM 分批召回（兜底）
 * - LLM 精排
 * - AI 插件对比
 *
 * 所有 LLM 调用统一走 LLMClient，不再耦合 Translator 状态。
 */

import { parseJSON, parseRecallCandidates, fuzzyTitleScores, rrfFuse, topNFused, isLocalBaseUrl } from "@shared/utils";
import { computeIndexFingerprints } from "@shared/fingerprint";
import { logger } from "@shared/logger";
import { tokenizeForBM25, bm25Idf, bm25LenNorm, bm25TermWeight } from "@domain/search/bm25";
import { applyQualityFactors } from "@domain/search/quality";
import {
	parseQueryIntent,
	pureNegativeCandidateIds,
	rerankSearchCandidates,
	type SearchCandidateText,
	type SearchMatchDiagnostics,
	type SearchMatchDiagnosticsSnapshot,
} from "@domain/search/query-intent";
import { t2sForEmbed } from "@translation/lexicon/t2s";
import { expandQuery } from "@translation/lexicon/synonyms";
import {
	createEmbeddingProvider,
	buildVectorIndex,
	vectorRecallScores,
	embeddingIndexKey,
	type EmbeddingProvider,
	type VectorIndex,
} from "@semantic/embedding";
import type {
	AISearchConfig,
	AISearchResult,
	AISearchCandidate,
} from "@domain/catalog/translator";
import type { CompareItem } from "@domain/compare/plugin-insight";
import type { PluginTagService } from "@domain/catalog/plugin-tags";
import { LLMClient } from "@translation/api/api";
import {
	SearchTiming,
	formatSearchTiming,
	localPhaseMs,
	PHASE,
	type SearchTimingSnapshot,
} from "@domain/search/search-timing";

// ───────── 常量 ─────────

/** AI 搜索：本地关键词召回 / LLM 召回每批的候选上限 */
const RECALL_CAP = 100;
/** 向量语义召回的候选上限（宽召回，让精排有更多选择） */
const VECTOR_RECALL_CAP = 300;
/** 向量∪关键词并集截到「候选池」上限（RRF 融合后展示/进 LLM 精排的候选数）。
 *  从 150 调大到 300：本地语义不经 LLM，宽召回提升召回率；AI 模式精排只看前 30（RANK_TOP_N），
 *  候选多但精排不慢，还提升多样性（对齐 vault-curate「先宽召回再 trim」）。 */
const CANDIDATE_POOL_CAP = 300;
/**
 * 单条召回路径进入 RRF 前的截断上限。
 *
 * 这是**有界近似**，不是无损截断 —— 别当成恒等变换：
 * RRF 贡献为 w/(60+rank+1)，丢掉 rank>500 的名次，等于把该文档的融合分最多压低
 * w/561（≈0.0018）。它仍可能凭**其它**召回路径进入候选池（例如在向量路 rank≤300
 * 的贡献可达 1/61），只是少了一点权重 —— 所以「rank>500 的文档不可能进候选池」
 * 这个说法是错的，不能拿来当证明。
 *
 * 为什么仍然采用：候选池只取融合分前 300，而本路径保留的 rank ≤ 299 的 300 条文档
 * 各自融合分已 ≥ 1/360（≈0.0028）。因此截断只会影响「恰好落在第 300 名边界 0.0018
 * 以内」的近并列 —— 最多让边界附近两条文档换位，不会让明显相关的文档消失。
 * 换来的是不必把全量命中都物化出来再排序。
 */
const RECALL_PATH_CAP = 500;
/**
 * 「本地阶段偏慢」告警阈值（ms）。
 *
 * 口径是 localPhaseMs —— **只统计我们自己的代码**：关键词召回 / 标题模糊 / RRF 融合。
 * 已排除 EXTERNAL_PHASES（LLM 精排、LLM 兜底召回、query 编码、向量索引），它们受网络
 * 往返或模型推理主导，正常也能到秒级甚至数十秒；用它们做阈值会持续误报，最终训练出
 * 「忽略告警」的习惯。
 *
 * 6000 条插件规模下这三个本地阶段实测约 1.5~3ms，超过 400ms 说明确实出现了非预期退化
 * （如 BM25 退化为全量遍历、某条召回路径异常），值得一条 warn 而非淹没在 debug 里。
 *
 * 注：向量索引「每次都重建」不靠本阈值发现 —— 那是外部成本（embedding 调用）而非
 * 我们代码变慢，由 finishTiming 里的「连续重建」告警 + `索引重建` 计数器负责。
 */
const SLOW_LOCAL_MS = 400;
/** AI 搜索：每批最大插件数 */
const BATCH_SIZE = 3000;
/** 计时计数器名：本次搜索是否重建了向量索引（1/0） */
const COUNTER_INDEX_REBUILT = "索引重建";

type SearchPlugin = {
	id: string;
	name: string;
	description: string;
	nameZh?: string;
	descZh?: string;
	downloads?: number;
	updated?: number;
};
/**
 * LLM 精排固定处理前 N 条候选（本地召回已给粗序，仅前 30 条进 LLM）。
 * 理由字段已设为「始终要求生成」，最大值靠 RANK_TOP_N 控制，低于 30 会报错。
 */
const RANK_TOP_N = 30;
/** 向量召回最低相似度阈值（0-1），低于此值的命中不纳入候选 */
const VECTOR_MIN_SCORE = 0.3;

/** 判断插件是否被 LLM 判定为无关。
 *  只列「最小充分集」：更长的变体（"无关系"/"无关联"）含 "无关"、"没关系" 含 "没关"，
 *  已被子串匹配覆盖，单列只会让列表出现看似不同的重复项。 */
const IRRELEVANT_KEYWORDS = ["无关", "不相关", "没关"];

/**
 * 预先构建的 BM25 倒排索引（只依赖插件列表，与 query 无关，可跨多次搜索复用）。
 *
 * 为什么是倒排而非「文档 token 表 + 逐条打分」：后者每次查询都要遍历全库、
 * 且 bm25Score 内部会为每条文档重建一次 tf Map（6000 条即 6000 次 Map 分配）。
 * 倒排把词频在构建期算好、并让召回只触碰「含 query term」的文档。
 * 实测（跑 scripts/bench-search-perf.mjs 实验 1 可复现）：6000 条语料下比旧实现
 * 快约 40~65x，随语料长度与查询分布波动。其中降幅的大头是「不再为每条文档分配
 * Map」（约 88%），而非算法本身。
 */
export interface Bm25Index {
	/** docIdx → 插件 id。docIdx 即插件在列表中的位置，同时用作同分时的稳定 tie-break */
	ids: string[];
	/** docIdx → 文档 token 数（长度归一化用，避免召回时再数一遍） */
	docLen: number[];
	/** docIdx → 预计算的 BM25 长度归一化分母，查询热路径直接读取 */
	docLenNorm: number[];
	/** term → 倒排表：命中该 term 的 docIdx 与对应词频 */
	postings: Map<string, { idx: number[]; tf: number[] }>;
	/** term → 文档频率（出现在多少个文档中） */
	df: Map<string, number>;
	N: number;
	avgdl: number;
	/** 失效签名：全部 id/name/description 的内容指纹，任一字段变化即重建 */
	sig: string;
}

/**
 * 构建 BM25 倒排索引：对全量插件列表做简体转换 + CJK 分词 + 倒排表/df 统计。
 * 标题场 = `name nameZh`，正文场 = `description descZh`（译文自此参与关键词路——
 * 此前 BM25 只吃英文原文，中文 query 全靠同义词词典兜）。
 * 该结果只依赖插件列表本身，与 query 无关，故可缓存跨多次搜索复用
 * （连续输入触发多次 AI 搜索时避免对 6000 条反复分词，省数百 ms）。
 *
 * @param sig 由调用方（getBm25Index）算好传入，避免这里重复计算内容指纹。
 */
export function buildBm25Index(
	allPlugins: { id: string; name: string; description: string; nameZh?: string; descZh?: string }[],
	sig: string
): Bm25Index {
	const ids: string[] = [];
	const docLen: number[] = [];
	const postings = new Map<string, { idx: number[]; tf: number[] }>();
	const df = new Map<string, number>();
	let totalLen = 0;

	for (let di = 0; di < allPlugins.length; di++) {
		const p = allPlugins[di];
		ids.push(p.id);
		const tokens = tokenizeForBM25(
			t2sForEmbed(`${p.name} ${p.nameZh ?? ""} ${p.description} ${p.descZh ?? ""}`)
		);
		docLen.push(tokens.length);
		totalLen += tokens.length;

		// 单文档词频只在建索引时算一次（替代旧实现「每次查询 × 每条文档」重建 Map）
		const localTf = new Map<string, number>();
		for (const t of tokens) localTf.set(t, (localTf.get(t) ?? 0) + 1);
		for (const [term, tf] of localTf) {
			let pl = postings.get(term);
			if (!pl) {
				pl = { idx: [], tf: [] };
				postings.set(term, pl);
			}
			pl.idx.push(di);
			pl.tf.push(tf);
			df.set(term, (df.get(term) ?? 0) + 1);
		}
	}

	const N = allPlugins.length;
	const avgdl = N > 0 ? totalLen / N : 0;
	const docLenNorm = docLen.map((len) => bm25LenNorm(len, avgdl));
	return { ids, docLen, docLenNorm, postings, df, N, avgdl, sig };
}

/**
 * CJK 三元组 BM25 关键词召回（倒排索引版）。
 *
 * 只对「命中至少一个 query term」的文档累加分数，而非遍历全库 —— 复杂度从
 * O(文档数 × query 词数) 降到 O(命中 posting 数)。query 与文档都转简体（t2s）
 * 以保证与向量路同 token 空间；BM25 分数供 RRF 融合（只看排名）。
 *
 * @param topK 只保留前 topK 条（按 score 降序、同分按插件列表序）。RRF 只看名次，
 *   rank 500 之后对融合分的贡献已可忽略（见 RECALL_PATH_CAP），无需把全量命中
 *   都物化出来再交给下游排序。
 */
export function bm25RecallScores(
	query: string,
	index: Bm25Index,
	topK = Number.MAX_SAFE_INTEGER
): Map<string, number> {
	// 同义词扩展：中文口语 → 英文别名（如"思维导图"→"mind map"），再 t2s 统一简体
	const expanded = expandQuery(query.trim());
	const q = t2sForEmbed(expanded);
	const queryTokens = tokenizeForBM25(q);
	if (queryTokens.length === 0) return new Map();

	// query term 频次（叠词加权）。只依赖 query，与文档无关，故算一次。
	const qtf = new Map<string, number>();
	for (const t of queryTokens) qtf.set(t, (qtf.get(t) ?? 0) + 1);

	const { postings, df, N, ids, docLenNorm } = index;
	const acc = new Map<number, number>(); // docIdx → 累计分
	for (const [term, qtfCount] of qtf) {
		const pl = postings.get(term);
		if (!pl) continue;
		// idf 只依赖 (term, df, N)：按 term 算一次，而不是放进文档循环里重复 Math.log
		const w = qtfCount * bm25Idf(df.get(term) ?? 0, N);
		const pIdx = pl.idx;
		const pTf = pl.tf;
		for (let k = 0; k < pIdx.length; k++) {
			const d = pIdx[k];
			acc.set(d, (acc.get(d) ?? 0) + w * bm25TermWeight(pTf[k], docLenNorm[d]));
		}
	}

	if (topK <= 0 || acc.size === 0) return new Map();

	// 有界最小堆只保留前 topK 个候选，避免命中大量 posting 时把整个累加表
	// 物化并排序。堆顶是当前 topK 中最差的候选：分数更低者更差，同分时 docIdx 更大者更差。
	const limit = Math.min(topK, acc.size);
	const heap: Array<[number, number]> = [];
	const isWorse = (a: [number, number], b: [number, number]): boolean =>
		a[1] < b[1] || (a[1] === b[1] && a[0] > b[0]);
	const swap = (a: number, b: number) => {
		const t = heap[a];
		heap[a] = heap[b];
		heap[b] = t;
	};
	const siftUp = (i: number) => {
		while (i > 0) {
			const p = (i - 1) >> 1;
			if (!isWorse(heap[i], heap[p])) break;
			swap(i, p);
			i = p;
		}
	};
	const siftDown = (i: number) => {
		for (;;) {
			const l = i * 2 + 1;
			if (l >= heap.length) return;
			const r = l + 1;
			const child = r < heap.length && isWorse(heap[r], heap[l]) ? r : l;
			if (!isWorse(heap[child], heap[i])) return;
			swap(i, child);
			i = child;
		}
	};
	for (const [d, score] of acc) {
		const candidate: [number, number] = [d, score];
		if (heap.length < limit) {
			heap.push(candidate);
			siftUp(heap.length - 1);
		} else if (isWorse(heap[0], candidate)) {
			heap[0] = candidate;
			siftDown(0);
		}
	}
	heap.sort((a, b) => b[1] - a[1] || a[0] - b[0]);

	const out = new Map<string, number>();
	for (const [d, s] of heap) {
		if (s > 0) out.set(ids[d], s);
	}
	return out;
}

// ───────── AISearcher ─────────

export class AISearcher {
	private llm: LLMClient;
	private tagService: PluginTagService;
	private aiConfig: AISearchConfig;

	/** 插件标签数据（id → {category, tags}），在 setPluginTags() 时更新 */
	private pluginTags: Record<string, { category: string; tags: string[] }> = {};

	/** 向量索引缓存（跨多次搜索复用，内容不变则零重建） */
	private vectorIndex: VectorIndex | null = null;

	/** BM25 索引缓存（跨多次搜索复用，列表不变则零重建，省去全量分词） */
	private bm25Cache: Bm25Index | null = null;

	/**
	 * 最近一次搜索的分段计时快照（诊断用）。
	 * null 表示本次会话尚未搜索过。供设置页 / 调试入口读取，回答「这次搜索慢在哪一步」。
	 */
	private lastSearchTiming: SearchTimingSnapshot | null = null;

	/** 最近一次搜索的召回/意图命中证据，供设置页搜索诊断面板读取。 */
	private lastMatchDiagnostics: SearchMatchDiagnosticsSnapshot | null = null;

	/**
	 * 上一次搜索是否重建了向量索引。
	 * 用于识别「每次都重建」这类退化 —— 它不会体现在 localPhaseMs 里（向量索引属外部
	 * 成本），但连续重建意味着缓存完全没复用上，是实打实的性能问题。
	 */
	private lastSearchRebuilt = false;

	constructor(
		aiConfig: AISearchConfig,
		llm: LLMClient,
		tagService: PluginTagService,
	) {
		this.aiConfig = aiConfig;
		this.llm = llm;
		this.tagService = tagService;
	}

	/** 更新配置 */
	updateConfig(aiConfig: AISearchConfig) {
		this.aiConfig = aiConfig;
		this.llm.updateConfig({
			baseURL: aiConfig.baseURL,
			apiKey: aiConfig.apiKey,
			model: aiConfig.model,
		});
	}

	/**
	 * 更新插件标签数据（id → {category, tags}）。
	 *
	 * 调用时机是**分类标签文件加载完成时**（Translator.setPluginTags ← plugin.loadPluginTags），
	 * 不是插件列表变化时——标签来自独立的 plugin-tags.json，与列表刷新无关。
	 * （旧注释写成「allPlugins 变化时调用」，与实现不符，做 BM25 失效判定时容易被误导。）
	 *
	 * 标签变化会影响向量索引（category/tags 是 embedding 输入的一部分），该失效已由
	 * shared/fingerprint 的 fields 指纹自动覆盖，无需在此手动清缓存。
	 */
	setPluginTags(tags: Record<string, { category: string; tags: string[] }>) {
		this.pluginTags = tags;
	}

	/** 获取当前向量索引（供外部持久化/查看） */
	getVectorIndex(): VectorIndex | null { return this.vectorIndex; }

	/** 从持久化恢复向量索引 */
	setVectorIndex(vi: VectorIndex | null) { this.vectorIndex = vi; }

	/** 最近一次搜索的分段计时快照（尚未搜索过时为 null）。返回拷贝，调用方改动不回写内部状态。 */
	getLastSearchTiming(): SearchTimingSnapshot | null {
		const s = this.lastSearchTiming;
		if (!s) return null;
		return {
			phases: s.phases.map((p) => ({ name: p.name, ms: p.ms })),
			totalMs: s.totalMs,
			counters: { ...s.counters },
			at: s.at,
		};
	}

	/**
	 * 最近一次搜索的匹配证据（尚未搜索过，或没有本地候选时为 null）。
	 * 返回深拷贝，设置页渲染或测试修改结果都不会污染搜索结果缓存。
	 */
	getLastMatchDiagnostics(): SearchMatchDiagnosticsSnapshot | null {
		const s = this.lastMatchDiagnostics;
		if (!s) return null;
		return {
			query: s.query,
			mode: s.mode,
			rankedIds: [...s.rankedIds],
			labels: { ...s.labels },
			diagnostics: this.cloneMatchDiagnostics(s.diagnostics),
			at: s.at,
		};
	}

	private cloneMatchDiagnostics(
		diagnostics: Record<string, SearchMatchDiagnostics>,
	): Record<string, SearchMatchDiagnostics> {
		return Object.fromEntries(
			Object.entries(diagnostics).map(([id, d]) => [id, {
				...d,
				matchedTerms: [...d.matchedTerms],
				phraseMatches: [...d.phraseMatches],
				intentMatches: [...d.intentMatches],
				negativeMatches: [...d.negativeMatches],
			}])
		);
	}

	private saveMatchDiagnostics(
		query: string,
		mode: "ai" | "local",
		rankedIds: string[],
		allPlugins: SearchPlugin[],
		diagnostics: Record<string, SearchMatchDiagnostics>,
	): void {
		const byId = new Map(allPlugins.map((p) => [p.id, p]));
		const labels: Record<string, string> = {};
		for (const id of Object.keys(diagnostics)) {
			const plugin = byId.get(id);
			if (!plugin) continue;
			const translated = plugin.nameZh?.trim();
			labels[id] = translated ? `${translated} · ${plugin.name}` : plugin.name;
		}
		this.lastMatchDiagnostics = {
			query,
			mode,
			rankedIds: [...rankedIds],
			labels,
			diagnostics: this.cloneMatchDiagnostics(diagnostics),
			at: Date.now(),
		};
	}

	/**
	 * 计时收尾：存快照、输出单行结构化摘要，并在本地阶段偏慢时额外告警。
	 *
	 * 用 localPhaseMs（只统计我们自己的代码：关键词召回 / 标题模糊 / RRF 融合）而非总耗时：
	 * LLM 精排受服务端影响，正常也能到秒级；embedding 走 API 时 query 编码同样是一次
	 * HTTP 往返。用它们做阈值只会持续误报，最终训练出「忽略告警」的习惯。
	 */
	private finishTiming(timing: SearchTiming, label: string): void {
		const snap = timing.finish();
		this.lastSearchTiming = snap;
		logger.debug(formatSearchTiming(snap, label));

		const localMs = localPhaseMs(snap);
		if (localMs > SLOW_LOCAL_MS) {
			logger.warn(
				`[Chinese Plugin Market] 本地检索阶段偏慢：${localMs.toFixed(0)}ms > 阈值 ${SLOW_LOCAL_MS}ms（仅统计关键词召回/标题模糊/RRF，不含 LLM 与 embedding 往返）· ` +
					snap.phases.map((p) => `${p.name}=${p.ms.toFixed(1)}ms`).join(" · ")
			);
		}

		// 连续两次都重建向量索引 → 缓存完全没复用上。向量索引属外部成本（embedding 调用），
		// 不计入 localPhaseMs，故单独盯这一条 —— 它正是「模型 key 不一致」那类 bug 的表现。
		const rebuilt = snap.counters[COUNTER_INDEX_REBUILT] === 1;
		if (rebuilt && this.lastSearchRebuilt) {
			logger.warn(
				`[Chinese Plugin Market] 连续两次搜索都重建了向量索引 —— 索引未复用上。` +
					`请检查 embedding 模型 / 分类体系版本是否每次都变化（见 shared/fingerprint.ts 的失效签名）。`
			);
		}
		this.lastSearchRebuilt = rebuilt;
	}

	/**
	 * 获取（或惰性构建并缓存）BM25 倒排索引。
	 * 用内容指纹作失效签名：内容变化才重建，否则直接复用上一次的分词/倒排/df 统计结果，
	 * 连续输入触发多次 AI 搜索时省去重复的全库分词开销。
	 * （原先用「列表长度 + 首尾 id」判失效，无法察觉中间插件的描述变更。）
	 *
	 * @param precomputedSig 调用方若已在同一次遍历里算过指纹（见 search/localSearch 的
	 *   computeIndexFingerprints 调用）可直接传入，省掉这里的第二次全库遍历。
	 */
	getBm25Index(
		allPlugins: { id: string; name: string; description: string; nameZh?: string; descZh?: string }[],
		precomputedSig?: string
	): Bm25Index {
		const sig = precomputedSig ?? computeIndexFingerprints(allPlugins).bm25;
		if (this.bm25Cache && this.bm25Cache.sig === sig) return this.bm25Cache;
		this.bm25Cache = buildBm25Index(allPlugins, sig);
		return this.bm25Cache;
	}

	// ════════════════════════════════════════════
	// 公开 API
	// ════════════════════════════════════════════

	/**
	 * AI 语义搜索：混合召回链（向量语义 ∪ 本地关键词 → LLM 兜底） → LLM 精排。
	 */
	async search(
		query: string,
		allPlugins: SearchPlugin[],
		showReason = false,
		onPhase?: (phase: string, detail: string) => void,
		filterCategories?: string[],
	): Promise<AISearchResult> {
		// 匹配证据只描述当前这次搜索；即使参数校验失败，也不应在设置页继续展示上一次成功搜索。
		this.lastMatchDiagnostics = null;
		if (!this.aiConfig.apiKey && !isLocalBaseUrl(this.aiConfig.baseURL))
			throw new Error("NO_API_KEY");
		if (!allPlugins.length) throw new Error("无插件数据，请先加载列表");

		// 整条管线用 finally 收尾：即使中途抛错（无结果 / LLM 失败）也要留下耗时构成，
		// 「失败发生在哪一步」本身就是排查的关键信息。
		const timing = SearchTiming.start();
		try {
			// ── 召回：混合召回链（向量语义 RRF 融合 本地关键词 → LLM 兜底）──
			let merged: AISearchCandidate[] = [];
			const intent = parseQueryIntent(query);
			// 纯否定 query 没有正向召回词：跳过向量/BM25/标题路，改用中性质量分
			// 形成候选池，并硬排除命中否定词的插件，避免「不要导出」反而召回导出插件。
			const recallQuery = intent.isPureNegative ? "" : intent.recallQuery || query;
			let matchDiagnostics: Record<string, SearchMatchDiagnostics> = {};

			const embCfg = this.aiConfig.embedding;
			const useVector = embCfg && embCfg.source !== "keyword";

			// 两个索引的失效签名单趟算出（见 shared/fingerprint.ts；实测约 1.7~1.9x，实验 6）。
			// 分类/标签经访问器从 pluginTags 直接取，不构造中间对象——否则每次搜索要分配
			// 6000 个临时对象，正是刚在 BM25 上修掉的那类反模式。
			const fingerprints = computeIndexFingerprints(allPlugins, (p) => this.pluginTags[p.id]);

			// 向量召回（带分数，供 RRF 融合）
			let vectorScores: Map<string, number> | null = null;
			if (useVector && recallQuery) {
				try {
					// 不要在这里再包一层 measure：vectorRecallScores 内部已用 measure 记
					// 「向量索引」「query 编码+余弦」。外层再包一层会让 localPhaseMs 把整段
					// 向量耗时算两遍（曾导致慢查询告警在开启向量搜索时虚报）。
					vectorScores = await this.vectorRecallScores(
						recallQuery,
						allPlugins,
						embCfg,
						timing,
						onPhase,
						filterCategories,
						fingerprints.fields,
					);
				} catch (e: unknown) {
					logger.warn("[Chinese Plugin Market] 向量召回失败，降级到纯关键词：", e);
					vectorScores = null;
				}
			}

			// 关键词召回（CJK 三元组 BM25 + 同义词 + t2s，对齐本地语义模式）
			onPhase?.("本地召回", "正在本地粗筛候选…");
			const localScores = await timing.measure(PHASE.keyword, () =>
				recallQuery
					? bm25RecallScores(recallQuery, this.getBm25Index(allPlugins, fingerprints.bm25), RECALL_PATH_CAP)
					: new Map<string, number>()
			);

			// 标题模糊匹配（第三路）：兜住「用户只记得名字大概」的场景
			// 用 t2sForEmbed(query) 与召回路同 token 空间（繁体 query 也能命中简体标题）
			const fuzzyScores = await timing.measure(PHASE.fuzzy, () =>
				recallQuery ? fuzzyTitleScores(t2sForEmbed(recallQuery), allPlugins) : new Map<string, number>()
			);

			// RRF 融合：向量 + 关键词 + 标题模糊 三路名次融合（异构分数量纲不同，RRF 只看名次，
			// 比「并集取前 N」更稳；多路都命中的候选自然靠前，减少 LLM 精排负担）。
			const fusedIds = await timing.measure(PHASE.rrf, () => {
				const baseFused = intent.isPureNegative
					? new Map(pureNegativeCandidateIds(intent, allPlugins).map((id) => [id, 1]))
					: vectorScores && vectorScores.size > 0
						? rrfFuse([vectorScores, localScores, fuzzyScores], [1.0, 1.0, 0.5])
						: rrfFuse([localScores, fuzzyScores], [1.0, 0.5]);
				const fused = intent.isPureNegative ? applyQualityFactors(baseFused, allPlugins) : baseFused;
				const pool = topNFused(fused, CANDIDATE_POOL_CAP).map((x) => x.id);
				const reranked = rerankSearchCandidates({
					intent,
					ids: pool,
					plugins: allPlugins as SearchCandidateText[],
					fusedScores: fused,
					keywordScores: localScores,
					vectorScores,
					titleScores: fuzzyScores,
					limit: CANDIDATE_POOL_CAP,
				});
				matchDiagnostics = reranked.diagnostics;
				return reranked.ids;
			});

			const idToPlugin = new Map(allPlugins.map((p) => [p.id, p]));
			const union: AISearchCandidate[] = [];
			for (const id of fusedIds) {
				const p = idToPlugin.get(id);
				if (p) {
					const tag = this.pluginTags[id];
					union.push({ id: p.id, name: p.name, description: p.description, category: tag?.category });
				}
			}
			merged = union;

			timing.count("插件数", allPlugins.length);
			timing.count("向量命中", vectorScores?.size ?? 0);
			timing.count("关键词命中", localScores.size);
			timing.count("标题命中", fuzzyScores.size);

			// LLM 兜底召回
			if (merged.length === 0 && !intent.isPureNegative) {
				merged = await timing.measure(PHASE.llmFallback, () =>
					this.recallAllBatches(query, allPlugins, onPhase)
				);
			}
			timing.count("候选池", merged.length);

			if (merged.length === 0) {
				throw new Error(
					intent.isPureNegative
						? "纯否定查询没有可返回的插件，请补充要搜索的功能"
						: "未找到相关插件，请尝试更换搜索词"
				);
			}

			const exp = {
				...this.buildExplainability(intent.recallQuery, vectorScores, localScores, fuzzyScores),
				matchDiagnostics,
			};

			let result: AISearchResult;
			if (merged.length < 2) {
				// 候选太少，直接用原始 description 做精排
				if (merged.length === 1) {
					const full = allPlugins.find((p) => p.id === merged[0].id);
					if (full) merged[0].description = full.description;
				}
				result = await timing.measure(PHASE.llmRank, () =>
					this.rankTopOrFallback(query, merged, showReason, () =>
						onPhase?.("精排", `共 ${merged.length} 条候选`)
					, exp)
				);
			} else {
				// 补齐 description
				const idToDesc = new Map<string, string>();
				for (const p of allPlugins) idToDesc.set(p.id, p.description);
				for (const c of merged) {
					c.description = idToDesc.get(c.id) || c.description || "";
				}
				onPhase?.("精排", `共 ${merged.length} 条候选`);
				result = await timing.measure(PHASE.llmRank, () =>
					this.rankTopOrFallback(query, merged, showReason, undefined, exp)
				);
			}

			// 精排结果以计数器呈现（原先用两条 logger.debug 表达同一信息）
			timing.count("精排降级", result.rankFallback ? 1 : 0);
			timing.count("结果数", result.rankedIds.length);
			this.saveMatchDiagnostics(query, "ai", result.rankedIds, allPlugins, matchDiagnostics);
			return result;
		} finally {
			this.finishTiming(timing, `AI 搜索 query="${query}"`);
		}
	}

	/**
	 * 本地语义搜索：只跑混合召回 + RRF 融合排序，**不做 LLM 精排**。
	 *
	 * 定位（吸取 vault-curate 经验）：提供「离线、免 API Key、零 token」的语义搜索。
	 * 用本地 embedding（向量）+ 关键词 + 标题模糊三路 RRF 融合，直接按融合分排序返回，
	 * 不依赖 LLM。向量路不可用时自动退化为「关键词 + 标题模糊」两路融合。
	 */
	async localSearch(
		query: string,
		allPlugins: SearchPlugin[],
		filterCategories?: string[],
	): Promise<AISearchResult> {
		// 匹配证据只描述当前这次搜索；即使参数校验失败，也不应在设置页继续展示上一次成功搜索。
		this.lastMatchDiagnostics = null;
		if (!allPlugins.length) throw new Error("无插件数据，请先加载列表");

		const timing = SearchTiming.start();
		try {
			const embCfg = this.aiConfig.embedding;
			const useVector = embCfg && embCfg.source !== "keyword";
			const intent = parseQueryIntent(query);
			const recallQuery = intent.isPureNegative ? "" : intent.recallQuery || query;
			let matchDiagnostics: Record<string, SearchMatchDiagnostics> = {};

			// 与 search() 同理：单趟算出两个索引的失效签名
			const fingerprints = computeIndexFingerprints(allPlugins, (p) => this.pluginTags[p.id]);

			// 向量召回（带分数）
			let vectorScores: Map<string, number> | null = null;
			if (useVector && recallQuery) {
				try {
					// 同 search()：不在此再包一层 measure，避免向量耗时被 localPhaseMs 双计
					vectorScores = await this.vectorRecallScores(
						recallQuery,
						allPlugins,
						embCfg,
						timing,
						undefined,
						filterCategories,
						fingerprints.fields,
					);
				} catch (e: unknown) {
					logger.warn("[Chinese Plugin Market] 本地语义：向量召回失败，降级关键词+标题：", e);
					vectorScores = null;
				}
			}

			// 关键词召回（CJK 三元组 BM25，替代简单重叠）+ 标题模糊
			const localScores = await timing.measure(PHASE.keyword, () =>
				recallQuery
					? bm25RecallScores(recallQuery, this.getBm25Index(allPlugins, fingerprints.bm25), RECALL_PATH_CAP)
					: new Map<string, number>()
			);
			const fuzzyScores = await timing.measure(PHASE.fuzzy, () =>
				recallQuery ? fuzzyTitleScores(t2sForEmbed(recallQuery), allPlugins) : new Map<string, number>()
			);

			// RRF 融合（与 AI 模式召回一致；向量不可用时退化为关键词+标题）
			const fusedIds = await timing.measure(PHASE.rrf, () => {
				const rrf = intent.isPureNegative
					? new Map(pureNegativeCandidateIds(intent, allPlugins).map((id) => [id, 1]))
					: vectorScores && vectorScores.size > 0
						? rrfFuse([vectorScores, localScores, fuzzyScores], [1.0, 1.0, 0.5])
						: rrfFuse([localScores, fuzzyScores], [1.0, 0.5]);
				// 质量因子在此直接塑造最终排序（本地模式无 LLM 精排，是它的主战场）
				const fused = applyQualityFactors(rrf, allPlugins);
				const pool = topNFused(fused, CANDIDATE_POOL_CAP).map((x) => x.id);
				const reranked = rerankSearchCandidates({
					intent,
					ids: pool,
					plugins: allPlugins as SearchCandidateText[],
					fusedScores: fused,
					keywordScores: localScores,
					vectorScores,
					titleScores: fuzzyScores,
					limit: CANDIDATE_POOL_CAP,
				});
				matchDiagnostics = reranked.diagnostics;
				return reranked.ids;
			});

			timing.count("插件数", allPlugins.length);
			timing.count("向量命中", vectorScores?.size ?? 0);
			timing.count("关键词命中", localScores.size);
			timing.count("标题命中", fuzzyScores.size);
			timing.count("结果数", fusedIds.length);
			if (fusedIds.length === 0 && intent.isPureNegative) {
				throw new Error("纯否定查询没有可返回的插件，请补充要搜索的功能");
			}

			const exp = {
				...this.buildExplainability(intent.recallQuery, vectorScores, localScores, fuzzyScores),
				matchDiagnostics,
			};
			const result = { rankedIds: fusedIds, rankFallback: true, ...exp };
			this.saveMatchDiagnostics(query, "local", result.rankedIds, allPlugins, matchDiagnostics);
			return result;
		} finally {
			this.finishTiming(timing, `本地语义 query="${query}"`);
		}
	}

	/** AI 深度对比（基于真实信号：commands / 依赖 / 标签 / README，不单靠描述） */
	async compare(items: CompareItem[]): Promise<string | null> {
		if (!this.aiConfig?.apiKey && !isLocalBaseUrl(this.aiConfig.baseURL)) return null;
		const system =
			"你是 Obsidian 插件选品顾问。用户正在对比若干功能相近的插件，需要你基于给出的" +
			"市场元数据与仓库真实信号，输出结构化的中文对比分析。只输出 Markdown 正文（不要代码块包裹、不要任何前后解释），" +
			"并使用二级标题严格分节。";
		const list = items
			.map((it, i) => {
				const lines = [
					`### 插件${i + 1}：${it.name}`,
					`- 简介：${it.description || "无"}`,
					`- 功能标签：${it.tags.join("、") || "无"}`,
					`- 实际命令（代码注册，最可信）：${it.commands.join("、") || "无"}`,
					`- 依赖（技术栈 / 联动对象）：${it.dependencies.join("、") || "无"}`,
				];
				if (it.readme) lines.push(`- README 片段（可能过时，仅补充）：${it.readme}`);
				return lines.join("\n");
			})
			.join("\n\n");
		const user =
			`请对比以下插件：\n\n${list}\n\n` +
			"请严格按以下结构输出（中文）：\n" +
			"## 共同功能\n（这些插件都具备的核心能力。优先采信「实际命令」的交集，而非只看标签/描述；" +
			"若命令高度重叠但描述不同，说明本质同类）\n" +
			"## 各自独有\n（分别说明每个插件相对其他插件真正独有的能力——以实际命令与依赖为准，避免被营销描述带偏）\n" +
			"## 选品建议\n（针对不同使用场景/工作流，给出该选哪个的实操建议；若功能高度重叠，给出该如何取舍的判据）";
		try {
			return await this.llm.call(system, user, 4000, false);
		} catch (e: unknown) {
			logger.warn(`[Chinese Plugin Market] AI 对比失败:`, e);
			throw e;
		}
	}

	// ════════════════════════════════════════════
	// 向量召回
	// ════════════════════════════════════════════

	/**
	 * 向量召回（带分数版）：构建/复用向量索引后召回，返回 `Map<插件id, 余弦相似度>`。
	 * 供 search() 做 RRF 融合。任何失败（索引构建、embed、召回）抛错，由上层降级。
	 */
	private async vectorRecallScores(
		query: string,
		allPlugins: SearchPlugin[],
		embCfg: NonNullable<AISearchConfig["embedding"]>,
		timing: SearchTiming,
		onPhase?: (phase: string, detail: string) => void,
		filterCategories?: string[],
		precomputedFieldsHash?: string,
	): Promise<Map<string, number> | null> {
		const provider: EmbeddingProvider = createEmbeddingProvider({
			source: embCfg.source,
			baseURL: embCfg.baseURL,
			apiKey: embCfg.apiKey,
			model: embCfg.model,
			localModel: embCfg.localModel,
			localWasmPaths: embCfg.localWasmPaths,
			localRemoteHost: embCfg.localRemoteHost,
		});

		// 索引的 model key：本地模式用 localModel（bge），API 模式用 model。
		// 关键修复：此前一律用 embCfg.model（API 默认 text-embedding-3-small），
		// 与 buildLocalIndex 用 localModel（bge）建的索引 model 不一致 → 每次搜索都
		// needBuild=true → 全量重建 embed 几千条 → 慢。现统一为实际所用模型的 key，
		// 使重启后加载的 SQLite 索引能正确复用（needBuild=false）。
		//
		// 索引身份还必须包含「embedding 供应商」：同名模型在不同服务商（或不同自建网关）
		// 之间并不共享向量空间。只比模型名会让「换了 baseURL 但模型名没变」的用户
		// 直接复用旧空间索引 → 余弦打分全是假的，且不报错、不重建，极难排查。
		// 安全约束：apiKey 绝不可进入 key（该 key 会写进 SQLite meta 并出现在日志里）。
		// 必须与 plugin.buildLocalIndex 用同一套 key 规则（见 embeddingIndexKey），
		// 否则两条路径会各自认为索引过期 → 每次搜索都全量重建。
		const indexModel = embeddingIndexKey({
			source: embCfg.source,
			baseURL: embCfg.baseURL,
			model: embCfg.model,
			localModel: embCfg.localModel,
		});

		const indexPlugins = allPlugins.map((p) => {
			const tag = this.pluginTags[p.id];
			return {
				id: p.id,
				name: p.name,
				description: p.description,
				category: tag?.category,
				tags: tag?.tags,
				nameZh: p.nameZh,
				descZh: p.descZh,
			};
		});

		const partialUsable = this.vectorIndex?.partial === true && this.vectorIndex.model === indexModel;
		const nullIdx = !this.vectorIndex;
		const modelMismatch = !partialUsable && this.vectorIndex?.model !== indexModel;
		const lenMismatch = !partialUsable && this.vectorIndex?.ids.length !== allPlugins.length;
		const schemaMismatch = !partialUsable && this.vectorIndex?.categorySchemaVersion !== this.tagService.getSchemaVersion();
		const needBuild = nullIdx || modelMismatch || lenMismatch || schemaMismatch;

		if (needBuild) {
			// 诊断：把四个复用判定条件摊开，重启后仍全量重建时可直接看出是哪一个不满足
			// （常见：模型 key 两侧不一致 → modelMismatch；或落盘索引未恢复 → nullIdx）。
			logger.debug(
				`[Chinese Plugin Market] 向量索引需重建：null=${nullIdx} · model=${modelMismatch}(落盘=${this.vectorIndex?.model}≠计算=${indexModel}) · len=${lenMismatch}(${this.vectorIndex?.ids.length}/${allPlugins.length}) · schema=${schemaMismatch}(${this.vectorIndex?.categorySchemaVersion}≠${this.tagService.getSchemaVersion()})`
			);
		}

		onPhase?.("向量召回", needBuild ? "正在构建向量索引…" : "正在计算语义相似度…");

		// 索引构建与 query 编码分开计时：两者成本量级完全不同（重建要 embed 数千条，
		// 复用只需 embed 一次 query），混在一起会把「索引没复用上」这类问题掩盖掉。
		const prevIndex = this.vectorIndex;
		// 后台增量构建会发布 partial 索引供搜索使用。它由唯一的后台构建任务
		// 持续补齐，搜索不能把它当成普通旧索引再次 build，否则会并发全量 embed。
		const built = partialUsable
			? prevIndex!
			: await timing.measure(PHASE.vectorIndex, () =>
					buildVectorIndex(
						provider,
						indexPlugins,
						indexModel,
						prevIndex,
						this.tagService.getSchemaVersion(),
						precomputedFieldsHash,
					)
			  );
		if (built !== prevIndex) this.vectorIndex = built;
		// 用引用是否变化判断「真的重建了」——needBuild 只是快速判定，buildVectorIndex
		// 内部还会因内容指纹变化而重建，两者不等价。
		const rebuilt = built !== prevIndex;
		timing.count(COUNTER_INDEX_REBUILT, rebuilt ? 1 : 0);
		if (rebuilt) {
			// 重建是低频事件（列表/模型/分类体系变化才发生）。只在真的重建时记一条明细，
			// 用于回答「这次为什么重建」——替代原先每次搜索都打印的 needBuild 分支探针。
			logger.debug(
				`[Chinese Plugin Market] 向量索引已重建：needBuild=${needBuild} · 模型=${indexModel} · 插件数=${allPlugins.length}`
			);
		}

		// query 侧 t2s（trad 修复 2026-09-20）：向量索引 doc 侧本就简体，繁体 query 不归一
		// 则跨文字匹配弱于简体同词（trad 桶首金 #6 vs 简体 #1 的根因之一）；doc 侧不动=零 re-embed
		const anchoredQuery = filterCategories?.length
			? `分类：${filterCategories.join(" / ")}\n${t2sForEmbed(query)}`
			: t2sForEmbed(query);

		// 分类过滤必须进入 top-K 选择本身：如果先取全局 top-K 再删除其它分类，
		// 选中分类中排在全局第 K+1 的相关插件会被永久丢弃。
		const allowedIndices = filterCategories?.length
			? new Set(
				built.ids.reduce<number[]>((indices, id, index) => {
					if (filterCategories.includes(this.pluginTags[id]?.category ?? "")) indices.push(index);
					return indices;
				}, [])
			  )
			: undefined;
		const scored = await timing.measure(PHASE.queryEncode, () =>
			vectorRecallScores(
				provider,
				anchoredQuery,
				built,
				VECTOR_RECALL_CAP,
				VECTOR_MIN_SCORE,
				allowedIndices,
			)
		);
		if (!scored) return null;
		// 保留一个结果层兜底：第三方/测试 provider 可能忽略 allowedIndices，
		// 但正常实现已经在 top-K 前完成候选裁剪。
		if (filterCategories?.length) {
			for (const id of Array.from(scored.keys())) {
				if (!filterCategories.includes(this.pluginTags[id]?.category ?? "")) scored.delete(id);
			}
		}
		return scored;
	}

	// ════════════════════════════════════════════
	// LLM 分批召回（兜底）
	// ════════════════════════════════════════════

	private async recallAllBatches(
		query: string,
		allPlugins: { id: string; name: string; description: string }[],
		onPhase?: (phase: string, detail: string) => void,
	): Promise<AISearchCandidate[]> {
		const totalBatches = Math.ceil(allPlugins.length / BATCH_SIZE);
		const batchPromises: Promise<AISearchCandidate[]>[] = [];
		for (let b = 0; b < totalBatches; b++) {
			const batchPlugins = allPlugins.slice(b * BATCH_SIZE, (b + 1) * BATCH_SIZE);
			batchPromises.push(this.recallBatch(query, batchPlugins, b + 1, totalBatches, onPhase));
		}

		const settled = await Promise.allSettled(batchPromises);
		const batchResults: AISearchCandidate[] = [];
		let firstReason: unknown = null;
		let failedCount = 0;
		for (const r of settled) {
			if (r.status === "fulfilled") {
				for (const c of r.value) batchResults.push(c);
			} else {
				failedCount++;
				if (firstReason == null) firstReason = r.reason;
			}
		}

		if (batchResults.length === 0) {
			logger.error(`[Chinese Plugin Market] AI 搜索：${failedCount}/${settled.length} 批召回全部失败`);
			settled.forEach((r, i) => {
				if (r.status === "rejected") logger.error(`  - 第 ${i + 1} 批:`, r.reason);
			});
			const reasonMsg =
				firstReason instanceof Error ? firstReason.message : firstReason ? String(firstReason) : "";
			const hint = reasonMsg ? `\n首批失败原因：${reasonMsg}` : "";
			throw new Error(`所有批次召回均失败，请检查 API 配置与网络（${failedCount}/${settled.length} 批失败）${hint}`);
		}

		const seen = new Set<string>();
		const merged: AISearchCandidate[] = [];
		for (const c of batchResults) {
			if (!seen.has(c.id)) { seen.add(c.id); merged.push(c); }
		}
		return merged;
	}

	private async recallBatch(
		query: string,
		batchPlugins: { id: string; name: string; description: string }[],
		batchNum: number,
		totalBatches: number,
		onPhase?: (phase: string, detail: string) => void,
	): Promise<AISearchCandidate[]> {
		const lines = batchPlugins.map((p, i) => `[${i}] ${p.id} | ${p.name}`).join("\n");

		const system = `你是 Obsidian 插件搜索召回助手。从候选列表中选出与用户搜索意图相关的【所有】插件（只要相关就选入，不限于固定数量）。
最多不超过 ${RECALL_CAP} 个，若相关插件少于此数则全部选入。
严格只输出 JSON 对象，不要任何解释、思考、前后缀或 Markdown 代码块标记。`;

		const user = `用户搜索意图: "${query}"

候选插件（共 ${batchPlugins.length} 条，仅含 ID 与名称）:
${lines}

从上述候选中选出【所有相关】的插件（相关即选入，最多 ${RECALL_CAP} 个，不够则选全部），返回其索引数组。

返回格式（必须且只能是这一个 JSON 对象，不要其他内容）:
{"indices": [3, 0, 7, 1, ...]}`;

		onPhase?.("召回", `第 ${batchNum}/${totalBatches} 批（${batchPlugins.length} 条）`);

		const content = await this.llm.call(system, user, 8192);
		const parsed = parseJSON(content);
		const results = parseRecallCandidates(parsed, batchPlugins);
		return results.slice(0, RECALL_CAP);
	}

	// ════════════════════════════════════════════
	// LLM 精排
	// ════════════════════════════════════════════

	private async rankTop(
		query: string,
		candidates: AISearchCandidate[],
		showReason: boolean,
		onPhase?: () => void,
		signals?: Record<string, string[]>,
	): Promise<AISearchResult> {
		const rankSubset = candidates.slice(0, RANK_TOP_N);

		const candidateLines = rankSubset.map((c, i) =>
			`[${i}] ID: ${c.id} | 名称: ${c.name} | 分类: ${c.category ?? "未知"} | 描述: ${c.description.slice(0, 120)}`
		).join("\n");

		const system = `你是 Obsidian 插件搜索排序助手。根据用户搜索意图，对候选插件按相关性排序。
严格只输出 JSON 对象，直接以 { 开头，不要任何解释、思考、前后缀或 Markdown 代码块标记。`;

		const user = `用户搜索意图: "${query}"

候选插件列表（共 ${rankSubset.length} 条）:
${candidateLines}

请按相关性从高到低排序，返回排序后的索引数组。并为每个插件生成简短排序理由（不超过20字）。

返回格式（必须且只能是这一个 JSON 对象，直接以 { 开头，不要其他内容）:
{
  "ranking": [3, 0, 7, 1, ...],
  "reasons": {
    "plugin-id": "一句话理由（若明显不相关，请写「无关：xxx」）"
  }
}

注意：ranking 必须包含全部 ${rankSubset.length} 个候选的索引（0~${rankSubset.length - 1}），reasons 的 key 用插件 ID。`;

		onPhase?.();

		const content = await this.llm.call(system, user, 8192);
		const parsed = parseJSON(content);

		if (!Array.isArray(parsed.ranking) || parsed.ranking.length === 0) {
			throw new Error("精排返回 ranking 无效");
		}

		const reasonsMap: Record<string, string> = {};
		if (parsed.reasons && typeof parsed.reasons === "object") {
			for (const [id, reason] of Object.entries(parsed.reasons as Record<string, unknown>)) {
				if (typeof reason === "string" && reason.trim()) {
					reasonsMap[id] = reason.trim();
				}
			}
		}

		const isIrrelevant = (id: string) => {
			const r = reasonsMap[id];
			if (!r) return false;
			return IRRELEVANT_KEYWORDS.some((kw) => r.includes(kw));
		};

		const rankedIds: string[] = [];
		const seen = new Set<string>();
		for (const raw of parsed.ranking as unknown[]) {
			const id = rankSubset[Number(raw)]?.id;
			if (id && !seen.has(id) && !isIrrelevant(id)) {
				rankedIds.push(id);
				seen.add(id);
			}
		}
		// 兜底：LLM 常只返回部分 ranking 索引，将未排序（且非 irrelevant）的候选补到末尾，
		// 避免结果不完整（否则这些插件会从最终召回集中消失，用户搜不到）。
		for (const c of rankSubset) {
			if (!seen.has(c.id) && !isIrrelevant(c.id)) {
				rankedIds.push(c.id);
				seen.add(c.id);
			}
		}

		if (rankedIds.length === 0) throw new Error("精排结果为空");

		const result: AISearchResult = { rankedIds };
		// reasons 仅保留最终进入结果的候选，排除被 irrelevant 过滤掉的（避免下游误显示）
		if (showReason) {
			const finalIds = new Set(rankedIds);
			const filteredReasons: Record<string, string> = {};
			for (const [id, reason] of Object.entries(reasonsMap)) {
				if (finalIds.has(id)) filteredReasons[id] = reason;
			}
			result.reasons = filteredReasons;
		}
		// 排序可解释性：经 LLM 精排保留（给了理由）的插件补 llm 信号
		if (signals) {
			for (const id of Object.keys(reasonsMap)) {
				if (rankedIds.includes(id)) (signals[id] ??= []).push("llm");
			}
		}
		return result;
	}

	/**
	 * 精排（带本地降级）：优先 LLM 语义精排；LLM 不可达（超时/服务不可用/
	 * 配额）时不再整条失败，而是直接返回混合召回的自然顺序（向量∪关键词），
	 * 保证 AI 搜索「永远可用」，仅退化为相关度排序质量。
	 *
	 * 这是 AI 搜索机制的关键健壮性修复：此前 LLM 一失败整条链路抛错、整体降级
	 * 到常规关键词搜索，表现为「AI 搜索用不了」。
	 */
	private async rankTopOrFallback(
		query: string,
		candidates: AISearchCandidate[],
		showReason: boolean,
		onPhase?: () => void,
		extra?: Partial<AISearchResult>,
	): Promise<AISearchResult> {
		try {
			const r = await this.rankTop(query, candidates, showReason, onPhase, extra?.signals);
			// 成功/降级由调用方的计时计数器呈现（精排降级=0/1），此处不再单独打日志
			return { ...r, ...extra };
		} catch (e: unknown) {
			logger.warn(
				"[Chinese Plugin Market] AI 精排失败，降级到本地召回排序（向量∪关键词）：",
				e
			);
			// 混合召回顺序：向量命中的语义相关项在前，关键词命中补在后，
			// 本身就是合理的「相关度降序」，无需任何网络调用。
			return { rankedIds: candidates.map((c) => c.id), rankFallback: true, ...extra };
		}
	}

	/**
	 * 构建排序可解释性数据：高亮词 + 每插件命中的召回信号。
	 * - highlightTerms：query 的 BM25 分词 + 同义词扩展（小写），供卡片高亮匹配片段。
	 * - signals：每个插件命中的召回路（vector/keyword/title），经 LLM 精排保留的再补 llm。
	 * 卡片据此在名称/描述高亮、并展示「为什么排在这」的信号徽标。
	 */
	private buildExplainability(
		query: string,
		vectorScores: Map<string, number> | null,
		localScores: Map<string, number>,
		fuzzyScores: Map<string, number>,
		llmIds?: Set<string>,
	): { highlightTerms: string[]; signals: Record<string, string[]> } {
		// 高亮词：query 分词（CJK bigram+trigram + ASCII 词）+ 同义词扩展；query 侧 t2s 与召回路一致（繁体 query 高亮简体描述）
		const baseTokens = tokenizeForBM25(t2sForEmbed(query)).map((t) => t.toLowerCase());
		const expanded = expandQuery(query).toLowerCase();
		const synonymTokens = tokenizeForBM25(expanded).map((t) => t.toLowerCase());
		const termSet = new Set<string>([...baseTokens, ...synonymTokens].filter((t) => t.length > 1));
		const highlightTerms = Array.from(termSet);

		// 信号：逐插件判定命中了哪些召回路
		const signals: Record<string, string[]> = {};
		const mark = (id: string, sig: string) => {
			(signals[id] ??= []).push(sig);
		};
		for (const id of vectorScores?.keys() ?? []) mark(id, "vector");
		for (const id of localScores.keys()) mark(id, "keyword");
		for (const id of fuzzyScores.keys()) mark(id, "title");
		if (llmIds) for (const id of llmIds) mark(id, "llm");
		return { highlightTerms, signals };
	}
}

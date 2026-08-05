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

import { parseJSON, parseRecallCandidates, fuzzyTitleScores, rrfFuse, topNFused, type RecallCandidate } from "../utils";
import { tokenizeForBM25, bm25Score } from "../bm25";
import { t2sForEmbed } from "../t2s";
import { expandQuery } from "../synonyms";
import {
	createEmbeddingProvider,
	buildVectorIndex,
	vectorRecallScores,
	type EmbeddingProvider,
	type VectorIndex,
} from "../embedding";
import type {
	AISearchConfig,
	AISearchResult,
	AISearchCandidate,
} from "../translator";
import type { CompareItem } from "../plugin-insight";
import type { PluginTagService } from "../plugin-tags";
import { LLMClient } from "../translate/api";

// ───────── 常量 ─────────

/** AI 搜索：本地关键词召回 / LLM 召回每批的候选上限 */
const RECALL_CAP = 100;
/** 向量语义召回的候选上限（宽召回，让精排有更多选择） */
const VECTOR_RECALL_CAP = 300;
/** 向量∪关键词并集截到「候选池」上限（RRF 融合后展示/进 LLM 精排的候选数）。
 *  从 150 调大到 300：本地语义不经 LLM，宽召回提升召回率；AI 模式精排只看前 30（RANK_TOP_N），
 *  候选多但精排不慢，还提升多样性（对齐 vault-curate「先宽召回再 trim」）。 */
const CANDIDATE_POOL_CAP = 300;
/** AI 搜索：每批最大插件数 */
const BATCH_SIZE = 3000;
/**
 * LLM 精排固定处理前 N 条候选（本地召回已给粗序，仅前 30 条进 LLM）。
 * 理由字段已设为「始终要求生成」，最大值靠 RANK_TOP_N 控制，低于 30 会报错。
 */
const RANK_TOP_N = 30;
/** 向量召回最低相似度阈值（0-1），低于此值的命中不纳入候选 */
const VECTOR_MIN_SCORE = 0.3;

/** 判断插件是否被 LLM 判定为无关 */
const IRRELEVANT_KEYWORDS = ["无关", "不相关", "无关联", "不相关", "没关", "无关系"];

/** 预先构建的 BM25 倒排/词频索引（只依赖插件列表，与 query 无关，可跨多次搜索复用） */
interface Bm25Index {
	docTokensById: Map<string, string[]>;
	df: Map<string, number>;
	N: number;
	avgdl: number;
	/** 失效签名：列表长度 + 首尾 id，任一变化即重建 */
	sig: string;
}

/**
 * 构建 BM25 索引：对全量插件列表做简体转换 + CJK 分词 + 文档频率 df 统计。
 * 该结果只依赖插件列表本身，与 query 无关，故可缓存跨多次搜索复用
 * （连续输入触发多次 AI 搜索时避免对 6000 条反复分词，省数百 ms）。
 */
function buildBm25Index(
	allPlugins: { id: string; name: string; description: string }[]
): Bm25Index {
	const docTokensById = new Map<string, string[]>();
	const df = new Map<string, number>();
	let totalLen = 0;
	for (const p of allPlugins) {
		const text = t2sForEmbed(`${p.name} ${p.description}`);
		const tokens = tokenizeForBM25(text);
		docTokensById.set(p.id, tokens);
		totalLen += tokens.length;
		const seen = new Set(tokens);
		for (const t of seen) df.set(t, (df.get(t) ?? 0) + 1);
	}
	const N = allPlugins.length;
	const avgdl = N > 0 ? totalLen / N : 0;
	const sig =
		N + ":" + (allPlugins[0]?.id ?? "") + ":" + (allPlugins[N - 1]?.id ?? "");
	return { docTokensById, df, N, avgdl, sig };
}

/**
 * CJK 三元组 BM25 关键词召回：对当前插件列表算 BM25 分，返回 Map<id, score>。
 * query 与文档都转简体（t2s）以保证与向量路同 token 空间；BM25 分数供 RRF 融合（只看排名）。
 * index 由调用方缓存复用（见 AISearcher.getBm25Index），避免列表不变时重复分词。
 */
function bm25RecallScores(
	query: string,
	index: Bm25Index
): Map<string, number> {
	const out = new Map<string, number>();
	// 同义词扩展：中文口语 → 英文别名（如"思维导图"→"mind map"），再 t2s 统一简体
	const expanded = expandQuery(query.trim());
	const q = t2sForEmbed(expanded);
	const queryTokens = tokenizeForBM25(q);
	if (queryTokens.length === 0) return out;

	const { docTokensById, df, N, avgdl } = index;
	for (const [id, docTokens] of docTokensById) {
		const score = bm25Score(queryTokens, docTokens, df, N, avgdl);
		if (score > 0) out.set(id, score);
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

	/** 更新插件标签数据（allPlugins 变化时调用） */
	setPluginTags(tags: Record<string, { category: string; tags: string[] }>) {
		this.pluginTags = tags;
	}

	/** 获取当前向量索引（供外部持久化/查看） */
	getVectorIndex(): VectorIndex | null { return this.vectorIndex; }

	/** 从持久化恢复向量索引 */
	setVectorIndex(vi: VectorIndex | null) { this.vectorIndex = vi; }

	/**
	 * 获取（或惰性构建并缓存）BM25 索引。
	 * 用「列表长度 + 首尾 id」作失效签名：列表内容变化才重建，否则直接复用上一次的
	 * 全量分词与 df 统计结果，连续输入触发多次 AI 搜索时省去重复的全库分词开销。
	 */
	getBm25Index(
		allPlugins: { id: string; name: string; description: string }[]
	): Bm25Index {
		const sig =
			allPlugins.length + ":" +
			(allPlugins[0]?.id ?? "") + ":" +
			(allPlugins[allPlugins.length - 1]?.id ?? "");
		if (this.bm25Cache && this.bm25Cache.sig === sig) return this.bm25Cache;
		this.bm25Cache = buildBm25Index(allPlugins);
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
		allPlugins: { id: string; name: string; description: string }[],
		showReason = false,
		onPhase?: (phase: string, detail: string) => void,
		filterCategories?: string[],
	): Promise<AISearchResult> {
		if (!this.aiConfig.apiKey) throw new Error("未配置 API Key");
		if (!allPlugins.length) throw new Error("无插件数据，请先加载列表");
		const tStart = Date.now();

		// ── 召回：混合召回链（向量语义 RRF 融合 本地关键词 → LLM 兜底）──
		let merged: AISearchCandidate[] = [];

		const embCfg = this.aiConfig.embedding;
		const useVector = embCfg && embCfg.source !== "keyword";

		// 向量召回（带分数，供 RRF 融合）
		let vectorScores: Map<string, number> | null = null;
		if (useVector) {
			try {
				vectorScores = await this.vectorRecallScores(query, allPlugins, embCfg!, onPhase, filterCategories);
			} catch (e) {
				console.warn("[Chinese Plugin Market] 向量召回失败，降级到纯关键词：", e);
				vectorScores = null;
			}
		}

		// 关键词召回（CJK 三元组 BM25 + 同义词 + t2s，对齐本地语义模式）
		onPhase?.("本地召回", "正在本地粗筛候选…");
		const localScores = bm25RecallScores(query, this.getBm25Index(allPlugins));

		// 标题模糊匹配（第三路）：兜住「用户只记得名字大概」的场景
		const fuzzyScores = fuzzyTitleScores(query, allPlugins as RecallCandidate[]);

		// RRF 融合：向量 + 关键词 + 标题模糊 三路名次融合（异构分数量纲不同，RRF 只看名次，
		// 比「并集取前 N」更稳；多路都命中的候选自然靠前，减少 LLM 精排负担）。
		let fusedIds: string[];
		if (vectorScores && vectorScores.size > 0) {
			// 向量路可用：三路融合（模糊权重低一些，作 tie-break）
			const fused = rrfFuse([vectorScores, localScores, fuzzyScores], [1.0, 1.0, 0.5]);
			fusedIds = topNFused(fused, CANDIDATE_POOL_CAP).map((x) => x.id);
		} else {
			// 向量路不可用：关键词 + 标题模糊 两路融合
			const fused = rrfFuse([localScores, fuzzyScores], [1.0, 0.5]);
			fusedIds = topNFused(fused, CANDIDATE_POOL_CAP).map((x) => x.id);
		}

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
		console.debug(
			`[Chinese Plugin Market] AI 搜索召回：query="${query}" · 向量命中=${vectorScores?.size ?? 0} · ` +
				`关键词命中=${localScores.size} · 标题模糊命中=${fuzzyScores.size} · ` +
				`RRF 融合后候选=${merged.length}（${Date.now() - tStart}ms）`
		);

		// LLM 兜底召回
		if (merged.length === 0) {
			merged = await this.recallAllBatches(query, allPlugins, onPhase);
		}

		if (merged.length === 0) {
			throw new Error("未找到相关插件，请尝试更换搜索词");
		}

		if (merged.length < 2) {
			// 候选太少，直接用原始 description 做精排
			if (merged.length === 1) {
				const full = allPlugins.find((p) => p.id === merged[0].id);
				if (full) merged[0].description = full.description;
			}
			return this.rankTopOrFallback(query, merged, showReason, () =>
				onPhase?.("精排", `共 ${merged.length} 条候选`)
			);
		}

		// 补齐 description
		const idToDesc = new Map<string, string>();
		for (const p of allPlugins) idToDesc.set(p.id, p.description);
		for (const c of merged) {
			c.description = idToDesc.get(c.id) || c.description || "";
		}

		onPhase?.("精排", `共 ${merged.length} 条候选`);
		return this.rankTopOrFallback(query, merged, showReason);
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
		allPlugins: { id: string; name: string; description: string }[],
		filterCategories?: string[],
	): Promise<AISearchResult> {
		if (!allPlugins.length) throw new Error("无插件数据，请先加载列表");
		const tStart = Date.now();

		const embCfg = this.aiConfig.embedding;
		const useVector = embCfg && embCfg.source !== "keyword";

		// 向量召回（带分数）
		let vectorScores: Map<string, number> | null = null;
		if (useVector) {
			try {
				vectorScores = await this.vectorRecallScores(query, allPlugins, embCfg!, undefined, filterCategories);
			} catch (e) {
				console.warn("[Chinese Plugin Market] 本地语义：向量召回失败，降级关键词+标题：", e);
				vectorScores = null;
			}
		}

		// 关键词召回（CJK 三元组 BM25，替代简单重叠）+ 标题模糊
		const localScores = bm25RecallScores(query, this.getBm25Index(allPlugins));
		const fuzzyScores = fuzzyTitleScores(query, allPlugins as RecallCandidate[]);

		// RRF 融合（与 AI 模式召回一致；向量不可用时退化为关键词+标题）
		let fusedIds: string[];
		if (vectorScores && vectorScores.size > 0) {
			fusedIds = topNFused(
				rrfFuse([vectorScores, localScores, fuzzyScores], [1.0, 1.0, 0.5]),
				CANDIDATE_POOL_CAP
			).map((x) => x.id);
		} else {
			fusedIds = topNFused(
				rrfFuse([localScores, fuzzyScores], [1.0, 0.5]),
				CANDIDATE_POOL_CAP
			).map((x) => x.id);
		}

		console.debug(
			`[Chinese Plugin Market] 本地语义搜索：query="${query}" · 向量命中=${vectorScores?.size ?? 0} · ` +
				`关键词命中=${localScores.size} · 标题模糊命中=${fuzzyScores.size} · ` +
				`融合后=${fusedIds.length}（${Date.now() - tStart}ms）`
		);

		return { rankedIds: fusedIds, rankFallback: true };
	}

	/** AI 深度对比（基于真实信号：commands / 依赖 / 标签 / README，不单靠描述） */
	async compare(items: CompareItem[]): Promise<string | null> {
		if (!this.aiConfig?.apiKey) return null;
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
		} catch (e) {
			console.warn(`[Chinese Plugin Market] AI 对比失败:`, e);
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
		allPlugins: { id: string; name: string; description: string }[],
		embCfg: NonNullable<AISearchConfig["embedding"]>,
		onPhase?: (phase: string, detail: string) => void,
		filterCategories?: string[],
	): Promise<Map<string, number> | null> {
		const provider: EmbeddingProvider = createEmbeddingProvider({
			source: embCfg.source,
			baseURL: embCfg.baseURL,
			apiKey: embCfg.apiKey,
			model: embCfg.model,
			localModel: embCfg.localModel,
			localWasmPaths: embCfg.localWasmPaths,
		});

		// 索引的 model key：本地模式用 localModel（bge），API 模式用 model。
		// 关键修复：此前一律用 embCfg.model（API 默认 text-embedding-3-small），
		// 与 buildLocalIndex 用 localModel（bge）建的索引 model 不一致 → 每次搜索都
		// needBuild=true → 全量重建 embed 几千条 → 慢。现统一为实际所用模型的 key，
		// 使重启后加载的 SQLite 索引能正确复用（needBuild=false）。
		const indexModel = embCfg.source === "local" ? embCfg.localModel : embCfg.model;

		const indexPlugins = allPlugins.map((p) => {
			const tag = this.pluginTags[p.id];
			return { id: p.id, name: p.name, description: p.description, category: tag?.category, tags: tag?.tags };
		});

		const needBuild =
			!this.vectorIndex ||
			this.vectorIndex.model !== indexModel ||
			this.vectorIndex.ids.length !== allPlugins.length ||
			this.vectorIndex.categorySchemaVersion !== this.tagService.getSchemaVersion();

		// 探针：打印 needBuild 各判定分支，便于定位「每次搜索都重建」的根因
		console.debug(
			`[Chinese Plugin Market] 探针：needBuild 判定 → ` +
				`vectorIndex空=${!this.vectorIndex} · model(${this.vectorIndex?.model}≠${indexModel})=${this.vectorIndex?.model !== indexModel} · ` +
				`ids长度(${this.vectorIndex?.ids.length}≠${allPlugins.length})=${this.vectorIndex?.ids.length !== allPlugins.length} · ` +
				`schema(${this.vectorIndex?.categorySchemaVersion}≠${this.tagService.getSchemaVersion()})=${this.vectorIndex?.categorySchemaVersion !== this.tagService.getSchemaVersion()}`
		);

		onPhase?.("向量召回", needBuild ? "正在构建向量索引…" : "正在计算语义相似度…");

		const tBuild = Date.now();
		this.vectorIndex = await buildVectorIndex(
			provider,
			indexPlugins,
			indexModel!,
			this.vectorIndex,
			this.tagService.getSchemaVersion(),
		);
		const buildMs = Date.now() - tBuild;

		const anchoredQuery = filterCategories?.length
			? `分类：${filterCategories.join(" / ")}\n${query}`
			: query;

		const tRecall = Date.now();
		const scored = await vectorRecallScores(provider, anchoredQuery, this.vectorIndex, VECTOR_RECALL_CAP, VECTOR_MIN_SCORE);
		const recallMs = Date.now() - tRecall;
		console.debug(
			`[Chinese Plugin Market] 向量召回性能：needBuild=${needBuild} · 索引构建/复用=${buildMs}ms · query embed+余弦=${recallMs}ms · 插件数=${allPlugins.length}`
		);
		if (!scored) return null;

		// filterCategories 过滤：向量召回阶段先按分类裁剪（与旧行为一致）
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
			console.error(`[Chinese Plugin Market] AI 搜索：${failedCount}/${settled.length} 批召回全部失败`);
			settled.forEach((r, i) => {
				if (r.status === "rejected") console.error(`  - 第 ${i + 1} 批:`, r.reason);
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
	): Promise<AISearchResult> {
		try {
			const r = await this.rankTop(query, candidates, showReason, onPhase);
			console.debug(
				`[Chinese Plugin Market] AI 精排完成：候选=${candidates.length} → 命中=${r.rankedIds.length}（LLM 精排成功）`
			);
			return r;
		} catch (e) {
			console.warn(
				"[Chinese Plugin Market] AI 精排失败，降级到本地召回排序（向量∪关键词）：",
				e
			);
			// 混合召回顺序：向量命中的语义相关项在前，关键词命中补在后，
			// 本身就是合理的「相关度降序」，无需任何网络调用。
			console.debug(
				`[Chinese Plugin Market] AI 精排降级：候选=${candidates.length} → 回退本地召回序`
			);
			return { rankedIds: candidates.map((c) => c.id), rankFallback: true };
		}
	}
}

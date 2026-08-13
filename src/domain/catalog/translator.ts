/**
 * 插件翻译市场核心
 *
 * 编排器：负责翻译管线（5 层 fallback）、缓存/词典/反馈状态管理、标签索引委派。
 * AI 搜索/对比/LLM/覆盖率/API 客户端已拆至独立模块：
 * - src/translate/api.ts   (MyMemory / Tencent / LLM / AI 翻译客户端)
 * - src/search/ai.ts       (AI 搜索 + 对比管线)
 * - src/coverage.ts        (覆盖率追踪)
 */

import { mapWithConcurrency } from "@shared/utils";
import { logger } from "@shared/logger";
import { type TencentApiConfig } from "@translation/api/tencent-signer";
import {
	MyMemoryClient,
	TencentClient,
	GoogleClient,
	LLMClient,
	callAITranslate,
} from "@translation/api/api";
import { buildSelfHostedTranslators, type SelfHostedTranslator } from "@translation/api/self-hosted";
import { TransmartClient } from "@translation/api/transmart";
import { AISearcher } from "@domain/search/ai";
import { CoverageTracker } from "@domain/catalog/coverage";
import { PluginTagService, type PluginTag } from "@domain/catalog/plugin-tags";
import { type TMEntry } from "@translation/memory/translation-memory";
import { TMDirtyTracker } from "@translation/memory/tm-dirty";
import type { CompareItem } from "@domain/compare/plugin-insight";
import { InsightCache, type InsightEntry } from "@data/storage/insight-cache";
import { AiAssetStore, type DictEntry } from "@data/storage/ai-asset-store";

// 向后兼容：原 InsightEntry / INSIGHT_SCHEMA_VERSION 在 insight-cache 中定义，
// DictEntry 在 ai-asset-store 中定义，此处 re-export 以兼容历史 import 来源。
export { InsightCache, type InsightEntry } from "@data/storage/insight-cache";
export { AiAssetStore, type DictEntry } from "@data/storage/ai-asset-store";
export const INSIGHT_SCHEMA_VERSION = 2;

/** AI 译文投入 TM 晋升队列时的默认置信度（TranslateResult 当前未携带 confidence 字段） */
const AI_SUGGEST_CONFIDENCE = 0.8;

// AI 配置空值兜底（与 DEFAULT_SETTINGS 保持一致；不直接 import translator-view 以免循环依赖）
const DEFAULT_AI_BASE_URL = "https://api.deepseek.com";
const DEFAULT_AI_MODEL = "deepseek-chat";

// ──────── 插件信息类型（被 40+ 文件引用，必须在 translator.ts 定义以保证兼容） ────────
export interface PluginInfo {
	id: string;
	name: string;
	description: string;
	author: string;
	/** 已安装插件本地 manifest 声明的本地化语言（如 ["zh-CN","en"]）；仅已安装插件有，远程清单无此字段 */
	languages?: string[];
	repo?: string;
	/** 下载量（来自 community-plugin-stats.json） */
	downloads?: number;
	/** 最近更新时间戳（ms，来自 stats） */
	updated?: number;
	/** 社区插件清单中的原始下标（越大越新） */
	listIndex?: number;
}



// ──────── 类型定义 ────────

export interface TranslateResult {
	translatedName: string;
	translatedDesc: string;
	/** 翻译来源标记 */
	source: "custom" | "bulk" | "online" | "ai" | "original";
	/** online 来源的具体供应商（用于 TM 入队置信度分层；旧缓存无此字段按未知处理） */
	provider?: "tencent" | "mymemory" | "google" | "deeplx" | "libretranslate" | "macos" | "tencent-transmart";
}

export interface AISearchConfig {
	baseURL: string;
	apiKey: string;
	model: string;
	embedding?: {
		source: "api" | "local" | "keyword";
		baseURL?: string;
		apiKey?: string;
		model?: string;
		localModel?: string;
		/** 本地 WASM 路径（settings 文本框原样透传的字符串；当前无消费方，保留供本地嵌入实现使用） */
		localWasmPaths?: string;
	};
}

export interface AISearchCandidate {
	id: string;
	name: string;
	description: string;
	category?: string;
	tags?: string[];
}

export interface AISearchResult {
	rankedIds: string[];
	mergedFromBatchRecall?: boolean;
	batchRecallFailed?: boolean;
	batchRecallAllFailed?: boolean;
	/** LLM 精排失败、已降级到本地召回排序（向量∪关键词混合序）时为 true */
	rankFallback?: boolean;
	reasons?: Record<string, string>;
	/** 命中高亮词（query 分词 + 同义词扩展，小写），供卡片在名称/描述中高亮匹配片段 */
	highlightTerms?: string[];
	/**
	 * 排序可解释性：每个插件命中的召回信号（可解释「为什么排在这」）。
	 * 取值为下列信号的子集：vector=向量语义命中 / keyword=关键词 BM25 命中 /
	 * title=标题模糊命中 / llm=经 AI 精排保留（LLM 认为相关）。
	 */
	signals?: Record<string, string[]>;
}

export interface CoverageSnapshot {
	version: string;
	date: string;
	coverage: number;
	total: number;
	covered: number;
	bulkHits: number;
	cacheHits: number;
}

export interface CoverageTrend {
	current: CoverageSnapshot;
	prev?: CoverageSnapshot;
	deltaPct: number;
}

export interface CoverageStat {
	coverage: number;
	total: number;
	covered: number;
	bulkHits: number;
	cacheHits: number;
}

export interface TranslatorConfig {
	apiConfig: TencentApiConfig | null;
	aiConfig: AISearchConfig | null;
	useMyMemory: boolean;
	/** 腾讯翻译（免费）通道（transmart.qq.com/api/imt，零配置） */
	useTransmart: boolean;
}

// ──────── 主类 ────────

export class Translator {
	// ── 状态管理 ──
	cache: Record<string, TranslateResult> = {};
	/** 进行中的翻译 Promise（按插件 id 去重）：并发场景下同一插件只真正翻译一次，
	 *  其余调用复用同一次结果，避免重复烧 token / 重复打 API。完成或失败后自动移除。 */
	private inFlight = new Map<string, Promise<TranslateResult>>();
	/** 个人 AI 固化资产存储（与 volatile `cache` 分离，clearCache 不清，跨会话保留） */
	readonly aiAssetStore = new AiAssetStore();

	/**
	 * 兼容层：历史代码/测试直接访问 `translator.aiDict[pid]`（读/写元素、Object.keys、整体赋值）。
	 * getter 返回 store 内部对象的实时引用（元素写入会直接落入 store）；
	 * setter 走 load 以整体替换。新增代码请改用 aiAssetStore API。
	 */
	get aiDict(): Record<string, DictEntry> {
		return this.aiAssetStore.raw();
	}
	set aiDict(v: Record<string, DictEntry>) {
		this.aiAssetStore.load({ aiDict: v });
	}
	/** 插件功能洞察 + 深度对比缓存（AI 生成概述的持久化缓存，已抽至 InsightCache） */
	readonly insightCache = new InsightCache();

	/** 已采纳（approved）TM 索引：镜像 vault 笔记，用于快速判定与避免重复入队 */
	tmApproved: Record<string, TMEntry> = {};
	/** TM 脏标记跟踪器（P2-1 已下沉至 translate/tm-dirty.ts）：自上次 flush 以来新增/更新/移除的 TM 条目 */
	readonly tmDirtyTracker = new TMDirtyTracker();

	// 配置
	apiConfig: TencentApiConfig | null = null;
	aiConfig: AISearchConfig | null = null;
	translatorConfig: TranslatorConfig = { apiConfig: null, aiConfig: null, useMyMemory: true, useTransmart: true };

	// 标签服务
	tagService: PluginTagService;
	pluginTags: Record<string, PluginTag> = {};
	private _pluginsRev = 0;

	// ── 组合模块 ──
	readonly myMemory: MyMemoryClient;
	readonly tencentClient: TencentClient;
	readonly googleClient: GoogleClient;
	readonly transmartClient: TransmartClient;
	readonly llm: LLMClient;
	readonly aiSearcher: AISearcher;
	readonly coverage: CoverageTracker;
	/** 自托管翻译源（DeepLX / LibreTranslate），按质量序；空数组=未配置 */
	selfHosted: SelfHostedTranslator[] = [];

	constructor(tagService?: PluginTagService) {
		this.tagService = tagService ?? new PluginTagService();

		// 初始化组合模块
		this.myMemory = new MyMemoryClient();
		this.tencentClient = new TencentClient();
		this.googleClient = new GoogleClient();
		this.transmartClient = new TransmartClient();
		this.llm = new LLMClient({
			baseURL: "",
			apiKey: "",
			model: "",
			temperature: 0.3,
		});
		this.aiSearcher = new AISearcher(
			{ baseURL: "", apiKey: "", model: "" },
			this.llm,
			this.tagService,
		);
		this.coverage = new CoverageTracker();

		// 初次配置同步
		this.syncConfig();
	}

	// ══════════════════════════════════════════════════
	// 配置同步
	// ══════════════════════════════════════════════════

	setApiConfig(config: TencentApiConfig | null) {
		this.apiConfig = config;
		if (config) this.tencentClient.setConfig(config);
		this.translatorConfig.apiConfig = config;
	}

	setUseMyMemory(enabled: boolean) {
		this.myMemory.setEnabled(enabled);
		this.translatorConfig.useMyMemory = enabled;
	}

	setUseTransmart(enabled: boolean) {
		this.transmartClient.setEnabled(enabled);
		this.translatorConfig.useTransmart = enabled;
	}

	setAIConfig(config: AISearchConfig | null) {
		// 设置页允许保存空 baseURL/model（仅 trim 无校验），此处集中兜底默认值，
		// 避免以空 baseURL/model 发起必败请求。
		const normalized = config
			? {
					...config,
					baseURL: config.baseURL?.trim() || DEFAULT_AI_BASE_URL,
					model: config.model?.trim() || DEFAULT_AI_MODEL,
			  }
			: null;
		this.aiConfig = normalized;
		this.translatorConfig.aiConfig = normalized;
		if (normalized) {
			this.llm.updateConfig({
				baseURL: normalized.baseURL,
				apiKey: normalized.apiKey,
				model: normalized.model,
			});
			this.aiSearcher.updateConfig(normalized);
		}
	}

	/** 从设置列表重建自托管翻译源（按质量序）；空列表清空，行为完全不变 */
	setSelfHostedTranslators(list: { type: "deeplx" | "libretranslate"; baseUrl: string }[] | undefined) {
		this.selfHosted = buildSelfHostedTranslators(list);
	}

	private syncConfig() {
		if (this.apiConfig) this.tencentClient.setConfig(this.apiConfig);
		if (this.aiConfig) {
			this.llm.updateConfig({
				baseURL: this.aiConfig.baseURL,
				apiKey: this.aiConfig.apiKey,
				model: this.aiConfig.model,
			});
			this.aiSearcher.updateConfig(this.aiConfig);
		}
	}

	// ══════════════════════════════════════════════════
	// 标签管理
	// ══════════════════════════════════════════════════

	setPluginTags(parsed: Record<string, PluginTag>, schemaVersion?: string) {
		this.tagService.load(parsed, schemaVersion);
		this.pluginTags = parsed;

		// 同步给 AISearcher（需要 category + tags 的完整数据结构）
		const aiTags: Record<string, { category: string; tags: string[] }> = {};
		for (const [id, tag] of Object.entries(parsed)) {
			aiTags[id] = { category: tag.category || "", tags: tag.tags ?? [] };
		}
		this.aiSearcher.setPluginTags(aiTags);

		this._pluginsRev++;
	}

	getPluginTag(id: string): PluginTag | undefined {
		return this.pluginTags[id];
	}

	getAllPluginTags(): Record<string, PluginTag> {
		return this.pluginTags;
	}

	pluginsRev(): number {
		return this._pluginsRev;
	}

	/** 分类体系版本号（向后兼容旧 API） */
	getCategorySchemaVersion(): string | undefined {
		return this.tagService.getSchemaVersion();
	}

	// ══════════════════════════════════════════════════
	// 数据持久化
	// ══════════════════════════════════════════════════

	/**
	 * 从持久化恢复数据。
	 * 兼容旧版本结构：data.pluginTags 已废弃，请通过 loadData + pluginTags 回调恢复。
	 */
	loadData(raw: {
		cache?: Record<string, TranslateResult>;
		aiDict?: Record<string, DictEntry>;
		tmQueue?: Record<string, TMEntry>;
		tmApproved?: Record<string, TMEntry>;
		pluginInsights?: Record<string, InsightEntry>;
		compareInsights?: Record<string, InsightEntry>;
		apiConfig?: TencentApiConfig | null;
		aiConfig?: AISearchConfig | null;
		useMyMemory?: boolean;
		myMemoryBlockedDate?: string | null;
		coverageSnapshots?: CoverageSnapshot[];
	}) {
		if (raw.cache) this.cache = raw.cache;
		if (raw.aiDict) this.aiDict = raw.aiDict;
		// 性能：tmApproved 不再持久化（vault 笔记是权威，启动时由 scanVaultTM 重建），
		// 故不再从 data.json 反序列化，避免首个重启后解析已废弃的 1.2MB 冗余。
		// 洞察缓存：只接纳当前 schema 版本；旧版（含最初 string 格式）一律丢弃重算
		this.insightCache.load({
			pluginInsights: raw.pluginInsights,
			compareInsights: raw.compareInsights,
		});
		if (raw.apiConfig) this.setApiConfig(raw.apiConfig);
		if (raw.aiConfig) this.setAIConfig(raw.aiConfig);
		if (raw.useMyMemory !== undefined) this.setUseMyMemory(raw.useMyMemory);
		if (raw.myMemoryBlockedDate) this.myMemory.restoreBlockedDate(raw.myMemoryBlockedDate);
		if (raw.coverageSnapshots) this.coverage.load(raw.coverageSnapshots);
	}

	/** 导出可持久化数据 */
		getData(): {
		cache: Record<string, TranslateResult>;
		aiDict: Record<string, DictEntry>;
		pluginInsights: Record<string, InsightEntry>;
		compareInsights: Record<string, InsightEntry>;
		apiConfig: TencentApiConfig | null;
		aiConfig: AISearchConfig | null;
		useMyMemory: boolean;
		myMemoryBlockedDate: string | null;
		coverageSnapshots: CoverageSnapshot[];
	} {
		const insights = this.insightCache.toJSON();
		const aiAssets = this.aiAssetStore.toJSON();
		return {
			cache: this.cache,
			aiDict: aiAssets.aiDict,
			pluginInsights: insights.pluginInsights,
			compareInsights: insights.compareInsights,
			apiConfig: this.apiConfig,
			aiConfig: this.aiConfig,
			useMyMemory: this.translatorConfig.useMyMemory,
			myMemoryBlockedDate: this.myMemory.getBlockedDate(),
			coverageSnapshots: this.coverage.snapshot(),
		};
	}

	// ══════════════════════════════════════════════════
	// 覆盖率追踪（委托给 CoverageTracker）
	// ══════════════════════════════════════════════════

	/** 记录一次覆盖率快照 */
	recordCoverage(stat: CoverageStat, version: string) {
		if (version == null || version === "") return;
		const date = new Date().toISOString().slice(0, 10);
		const snapshots = this.coverage.snapshot(); // 副本：可安全原地改写
		const snap = {
			version, date,
			coverage: stat.coverage, total: stat.total,
			covered: stat.covered, bulkHits: stat.bulkHits, cacheHits: stat.cacheHits,
		};
		const idx = snapshots.findIndex(s => s.version === version);
		if (idx >= 0) {
			// 同版本更新：替换旧条目
			snapshots[idx] = snap;
		} else {
			// 新增：插入并保持 12 条上限
			snapshots.unshift(snap);
		}
		this.coverage.load(snapshots.slice(0, 12));
	}

	getCoverageTrend(): CoverageTrend | null {
		const snapshots = this.coverage.snapshot();
		if (snapshots.length === 0) return null;
		const current = snapshots[0];
		const prev = snapshots.length > 1 ? snapshots[1] : undefined;
		const deltaPct = prev ? Math.round((current.coverage - prev.coverage) * 100) / 100 : 0;
		return { current, prev, deltaPct };
	}

	/** 判断插件是否有任何历史落盘译文（cache 非 original / TM 已采纳 / AI 固化资产）。
	 *  供 isTranslated（"从未翻译"筛选）使用，排除所有已有译文的插件。 */
	// eslint-disable-next-line @typescript-eslint/no-unused-vars -- plugin 保留以兼容调用方签名（PERF-8 后判定不再依赖 name/description）
	hasAnyTranslation(id: string, _plugin: PluginInfo): boolean {
		// cache 命中且非 original 兜底
		if (this.cache[id] && this.cache[id].source !== "original") return true;
		// TM 已采纳可信层。PERF-8：只需布尔存在性，用 hasTMApproved 而非 lookupTMApproved，
		// 避免每次判定都为 O(N) 渲染循环里的 5617 个插件新分配一个 TranslateResult 对象。
		if (this.hasTMApproved(id)) return true;
		// AI 固化资产
		if (this.aiAssetStore.get(id)) return true;
		return false;
	}

	/** 是否存在 TM 已采纳译名（仅布尔判定，不构造 TranslateResult，供高频存在性检查用）。 */
	private hasTMApproved(id: string): boolean {
		return id in this.tmApproved;
	}

	// ══════════════════════════════════════════════════
	// 插件功能洞察（AI 基于仓库 manifest 元数据生成，缓存复用）
	// ══════════════════════════════════════════════════

	getInsight(pid: string): string | undefined {
		return this.insightCache.getInsight(pid);
	}

	setInsight(pid: string, text: string) {
		this.insightCache.setInsight(pid, text);
	}

	// ══════════════════════════════════════════════════
	// 翻译缓存
	// ══════════════════════════════════════════════════

	/**
	 * 仅清除 volatile 缓存。
	 * 注意：`aiDict`（个人 AI 固化资产）不受影响，
	 * 用户清缓存不会丢失已固化的 AI 译文。
	 */
	clearCache() {
		this.cache = {};
	}

	/** 清除个人 AI 固化资产（不影响 cache） */
	clearAIDict() {
		this.aiAssetStore.clear();
	}

	getAIDictSize(): number {
		return this.aiAssetStore.size();
	}

	// ══════════════════════════════════════════════════
	// 翻译记忆库（TM）：晋升队列（human-in-the-loop）
	// ══════════════════════════════════════════════════

	/**
	 * online 供应商（MyMemory / Tencent / Google / 自托管 / 腾讯翻译免费）译文入队置信度分层：
	 * 腾讯 0.6；DeepLX（自托管，质量≈DeepL）0.55；腾讯翻译（免费）0.55；Google 非官方接口 0.5；
	 * LibreTranslate（自托管开源）0.48；MyMemory 社区记忆库噪声较大 0.4；
	 * 旧缓存无 provider 字段时按未知处理，0.5。
	 */
	private onlineConfidence(
		provider?: "tencent" | "mymemory" | "google" | "deeplx" | "libretranslate" | "macos" | "tencent-transmart"
	): number {
		if (provider === "tencent") return 0.6;
		if (provider === "deeplx") return 0.55;
		if (provider === "tencent-transmart") return 0.55;
		if (provider === "macos") return 0.52;
		if (provider === "google") return 0.5;
		if (provider === "libretranslate") return 0.48;
		if (provider === "mymemory") return 0.4;
		return 0.5;
	}

	/**
	 * 把 cache 中一条 online 来源的译文直接落库为已采纳。
	 * 仅对 `source === "online"` 的缓存条目生效；非 online、无缓存、已采纳均返回 false。
	 * 置信度按 provider 分层，统一以 `source: "online"` 处理。翻译均直接落库，无需审核。
	 */
	enqueueOnlineTM(pluginId: string): boolean {
		const c = this.cache[pluginId];
		if (!c || c.source !== "online") return false;
		if (this.tmApproved[pluginId]) return false;
		const confidence = this.onlineConfidence(c.provider);
		this.tmApproved[pluginId] = {
			id: pluginId,
			name: c.translatedName,
			description: c.translatedDesc,
			source: "online",
			status: "approved",
			confidence,
			created: Date.now(),
			promoted: Date.now(),
		};
		this.tmDirtyTracker.markDirty(pluginId);
		return true;
	}

	/**
	 * 把「按需系统翻译」（macOS 快捷指令）得到的名称+描述落库沉淀：
	 * - 写入 cache，本会话/下次打开直接命中复用；
	 * - 写入 tmApproved（可信层）并标记脏，由 plugin flushTMVault 写 vault 笔记，
	 *   重启后依然可用、可随 Sync 同步。
	 * 返回是否已落库（已有更可信/更新的 TM 时跳过，避免覆盖人工校正）。
	 */
	persistSystemTranslation(pluginId: string, translatedName: string, translatedDesc: string): boolean {
		// 不覆盖已存在的人工校正（human）—— 这是最高可信层，永远保留
		const existing = this.tmApproved[pluginId];
		if (existing && existing.source === "human") return false;
		const result: TranslateResult = {
			translatedName,
			translatedDesc,
			source: "online",
			provider: "macos",
		};
		this.cache[pluginId] = result;
		if (existing && existing.status === "approved") {
			// 已有非 human 的 approved 条目（如之前系统翻译 / AI / 在线译文）：
			// 「再点一次」语义是「用新译文替换之前的」，直接更新，不再标记待校正。
			existing.name = translatedName;
			existing.description = translatedDesc;
			existing.source = "online";
			existing.promoted = Date.now();
			this.tmDirtyTracker.markDirty(pluginId);
			return true;
		}
		this.tmApproved[pluginId] = {
			id: pluginId,
			name: translatedName,
			description: translatedDesc,
			source: "online",
			status: "approved",
			confidence: this.onlineConfidence("macos"),
			created: Date.now(),
			promoted: Date.now(),
		};
		this.tmDirtyTracker.markDirty(pluginId);
		return true;
	}

	/** 从已采纳索引中移除（vault 笔记由调用方负责删除）。 */
	removeTMApproved(pluginId: string): void {
		delete this.tmApproved[pluginId];
	}

	getTMApprovedCount(): number {
		return Object.keys(this.tmApproved).length;
	}

	isTMApproved(pluginId: string): boolean {
		return !!this.tmApproved[pluginId];
	}

	/** 取走脏标记集合（取后清空，供 plugin flush 写 vault 笔记） */
	takeTMDirty(): string[] {
		return this.tmDirtyTracker.takeDirty();
	}

	/** 仅查看脏标记（不清空），供 flush 时逐条写成功后再清除 */
	peekTMDirty(): string[] {
		return this.tmDirtyTracker.peekDirty();
	}

	/** 单条清除脏标记（写 vault 笔记成功后调用） */
	clearTMDirty(id: string): void {
		this.tmDirtyTracker.clearDirty(id);
	}

	/** 重新标记脏（写 vault 笔记失败、需下次 flush 重试时调用） */
	markTMDirty(id: string): void {
		this.tmDirtyTracker.markDirty(id);
	}

	/** 取走移除标记集合（取后清空，供 plugin flush 删 vault 笔记） */
	takeTMRemoved(): string[] {
		return this.tmDirtyTracker.takeRemoved();
	}

	/** 仅查看移除标记（不清空） */
	peekTMRemoved(): string[] {
		return this.tmDirtyTracker.peekRemoved();
	}

	/** 单条清除移除标记（删 vault 笔记成功后调用） */
	clearTMRemoved(id: string): void {
		this.tmDirtyTracker.clearRemoved(id);
	}

	/**
	 * 翻译命中优先读 TM 已采纳层（可信层）。
	 * tmApproved 是 人工校正(human) + 已采纳 AI + 已接纳 bulk 的并集，
	 * 作为统一可信层在 cache 之后优先命中；系统翻译采纳后直接落库，无需审核标记。
	 * source 映射：human→custom, bulk→bulk, ai→ai。
	 */
	/** 查询 TM 已采纳层（tmApproved），命中返回映射后的 TranslateResult，否则 null。供翻译管线与对比视图复用。 */
	lookupTMApproved(
		id: string,
		fallbackName: string,
		fallbackDesc: string,
	): TranslateResult | null {
		const e = this.tmApproved[id];
		if (!e) return null;
		const source: TranslateResult["source"] =
			e.source === "human" ? "custom" : e.source;
		return {
			translatedName: e.name || fallbackName,
			translatedDesc: e.description || fallbackDesc,
			source,
		};
	}

	/**
	 * 把一次成功的 AI 译文固化成个人资产。
	 * 与 volatile `cache` 分离：写入 `aiDict`，`clearCache()` 不会清除它，
	 * 跨会话保留；后续命中时跳过在线 AI（省 token）。
	 * AI 译文直接晋升为 approved 并标记脏，由 flushTMVault 写 vault 笔记，
	 * 重启后立即可用、可随 Sync 同步（用户已通过「一键翻译」显式信任 AI 结果）。
	 */
	private solidifyAI(pluginId: string, r: TranslateResult) {
		this.aiAssetStore.set(pluginId, {
			name: r.translatedName,
			description: r.translatedDesc,
			source: "ai",
		});
		// 直接采纳：写入 tmApproved（approved）并标记脏 → flushTMVault 写盘。
		if (this.tmApproved[pluginId]) return;
		this.tmApproved[pluginId] = {
			id: pluginId,
			name: r.translatedName,
			description: r.translatedDesc,
			source: "ai",
			status: "approved",
			confidence: AI_SUGGEST_CONFIDENCE,
			created: Date.now(),
			promoted: Date.now(),
		};
		this.tmDirtyTracker.markDirty(pluginId);
	}

	// ══════════════════════════════════════════════════
	// 翻译管线（核心编排，保留在 Translator）
	// ══════════════════════════════════════════════════

	/**
	 * 翻译单个插件（fallback 链）：
	 * layer 1 - 缓存（cache）
	 * layer 2 - TM 已采纳可信层（tmApproved，含 vault 沉淀的批量/AI/人工译文）
	 * layer 3 - 个人 AI 固化资产（aiDict，clearCache 不清）
	 * layer 4 - AI 翻译（callAITranslate → LLM，成功即固化进 layer 3）
	 * layer 5 - Google 非官方免费接口（零配置，质量优于 MyMemory）
	 * layer 6 - 腾讯翻译（免费）（transmart.qq.com，零配置、无配额）
	 * layer 7 - MyMemory 免费 API
	 * layer 8 - 腾讯云翻译（需 secretId+secretKey）
	 * 兜底   - 原文返回（source="original"）
	 */
	async translatePlugin(plugin: PluginInfo, opts?: { skipAI?: boolean }): Promise<TranslateResult> {
		// 第一层：缓存（original 兜底不算命中，允许后续重试真正翻译，
		// 与 translateBatchIncremental / translateSubset 的跳过条件一致）
		if (this.cache[plugin.id] && this.cache[plugin.id].source !== "original") {
			return this.cache[plugin.id];
		}

		// 并发去重：若同一插件正在翻译中，直接复用这一次的结果，避免重复打 API / 烧 token。
		// 必须在「进入在线翻译前」拦截——否则批量并发 worker 与懒翻译可能同时命中同一插件。
		const existing = this.inFlight.get(plugin.id);
		if (existing) return existing;

		const run = this.translatePluginOnce(plugin, opts);
		this.inFlight.set(plugin.id, run);
		try {
			return await run;
		} finally {
			this.inFlight.delete(plugin.id);
		}
	}

	/** translatePlugin 的实际工作体（被并发去重层包裹，同一 id 同一时刻只执行一次） */
	private async translatePluginOnce(plugin: PluginInfo, opts?: { skipAI?: boolean }): Promise<TranslateResult> {

		// 第二层：TM 已采纳可信层（与 translateBatch/translateSubset 统一优先级，
		// 之前漏查会导致单条翻译错过 vault 沉淀的 5617 条译文）
		const tmHit = this.lookupTMApproved(plugin.id, plugin.name, plugin.description);
		if (tmHit) {
			this.cache[plugin.id] = tmHit;
			return tmHit;
		}

		// 第三层（固化）：个人 AI 资产（clearCache 不清，避免重复烧 token）
		const aiEntry = this.aiAssetStore.get(plugin.id);
		if (aiEntry) {
			const result: TranslateResult = {
				translatedName: aiEntry.name || plugin.name,
				translatedDesc: aiEntry.description || plugin.description,
				source: "ai",
			};
			this.cache[plugin.id] = result;
			return result;
		}

		// 第四层：AI 翻译（LLM）。skipAI 时跳过（本地语义模式懒翻译，避免触发 LLM 超时/烧 token）
		if (this.aiConfig?.apiKey && !opts?.skipAI) {
			const aiResult = await callAITranslate(this.llm, plugin);
			if (aiResult) {
				this.solidifyAI(plugin.id, aiResult);
				this.cache[plugin.id] = aiResult;
				return aiResult;
			}
		}

		// 第四层（可选）：自托管翻译源（DeepLX / LibreTranslate，质量优先、零成本、数据不出本机）
		// 按设置里的质量序遍历；任一可用且返回有效译文即用，否则继续下层。
		for (const client of this.selfHosted) {
			if (!client.isAvailable()) continue;
			const shResult = await client.translate(plugin);
			if (shResult) {
				this.cache[plugin.id] = shResult;
				this.enqueueOnlineTM(plugin.id);
				return shResult;
			}
		}

		// 第五层：腾讯翻译（免费）（transmart.qq.com/api/imt，零配置、无配额）。
		// useTransmart 关闭时 isAvailable() 返回 false，本层直接跳过。
		const transmartResult = await this.transmartClient.translate(plugin);
		if (transmartResult) {
			this.cache[plugin.id] = transmartResult;
			this.enqueueOnlineTM(plugin.id);
			return transmartResult;
		}

		// 第六层：Google 非官方翻译接口（零配置免费，质量优于 MyMemory 社区库）
		const googleResult = await this.googleClient.translate(plugin);
		if (googleResult) {
			this.cache[plugin.id] = googleResult;
			// 自动机翻译文也投入审核队列（与 AI 翻译一致），供后续人工审核/采纳
			this.enqueueOnlineTM(plugin.id);
			return googleResult;
		}

		// 第七层：MyMemory 免费 API
		const myResult = await this.myMemory.translate(plugin);
		if (myResult) {
			this.cache[plugin.id] = myResult;
			// 自动机翻译文也投入审核队列（与 AI 翻译一致），供后续人工审核/采纳
			this.enqueueOnlineTM(plugin.id);
			return myResult;
		}

		// 第八层：腾讯云翻译（熔断器开路期间跳过，走原文兜底）
		// 与批量路径一致，必须 secretId+secretKey 齐备才调用（只填 ID 时空 Key 签名必败且会误开熔断）
		if (this.apiConfig?.secretId && this.apiConfig?.secretKey && this.tencentClient.isAvailable()) {
			try {
				const [translatedName, translatedDesc] = await Promise.all([
					this.tencentClient.translate(plugin.name),
					this.tencentClient.translate(plugin.description),
				]);
				const result: TranslateResult = { translatedName, translatedDesc, source: "online", provider: "tencent" };
				this.cache[plugin.id] = result;
				// 自动机翻译文投入审核队列（与 AI 翻译一致）
				this.enqueueOnlineTM(plugin.id);
				return result;
			} catch (e: unknown) {
				this.logTencentError(plugin.id, e);
			}
		}

		// 兜底：返回原文
		const result: TranslateResult = {
			translatedName: plugin.name,
			translatedDesc: plugin.description,
			source: "original",
		};
		this.cache[plugin.id] = result;
		return result;
	}

	/**
	 * 批量翻译插件列表（内部在线阶段使用并发=3，缓存/词典命中的仍顺序产出以保持进度准确）。
	 */
	async translateBatch(
		plugins: PluginInfo[],
		onProgress?: (done: number, total: number) => void
	): Promise<Record<string, TranslateResult>> {
		const results: Record<string, TranslateResult> = {};
		const total = plugins.length;
		let done = 0;

		const bump = () => {
			done++;
			onProgress?.(done, total);
		};

		const needOnline: PluginInfo[] = [];
		for (const plugin of plugins) {
			// original 兜底不算缓存命中：否则一次失败后会话内永不重试
			if (this.cache[plugin.id] && this.cache[plugin.id].source !== "original") {
				results[plugin.id] = this.cache[plugin.id];
				bump();
		} else {
			const tmHit = this.lookupTMApproved(plugin.id, plugin.name, plugin.description);
			if (tmHit) {
				results[plugin.id] = tmHit;
				this.cache[plugin.id] = tmHit;
				bump();
		} else if (this.aiAssetStore.get(plugin.id)) {
				const entry = this.aiAssetStore.get(plugin.id)!;
					results[plugin.id] = {
						translatedName: entry.name || plugin.name,
						translatedDesc: entry.description || plugin.description,
						source: "ai",
					};
					this.cache[plugin.id] = results[plugin.id];
					bump();
				} else {
					needOnline.push(plugin);
				}
		}
	}

	if (needOnline.length > 0) {
			// 并发=4（PERF-4）：此路径仅供「AI 智能混合翻译」（translateBatchIncremental）调用，
			// 用户已配置 LLM key，主走 LLM（DeepSeek 等端点 rate limit 远高于 MyMemory 免费层），
			// 2 并发对 LLM 过于保守，数千条待译时耗时数十分钟级。提到 4 可缩批量耗时约一半。
			// MyMemory 由熔断器兜底：一旦触发 429/超时即开路降级到腾讯/Google，不会因并发提高而
			// 持续打爆配额。单插件内 name+desc 双段在 provider 内部已并行，故 4 并发 ≈ 8 QPS 上限。
			const CONCURRENCY = 4;
			let idx = 0;
			const translateOne = async (): Promise<void> => {
				while (idx < needOnline.length) {
					const i = idx++;
					const plugin = needOnline[i];
					// 复用 translatePlugin：其内部有并发去重（inFlight），同一插件在
					// 批量并发 worker 与懒翻译并发时只真正翻译一次，且优先级链与单条一致。
					const r = await this.translatePlugin(plugin);
					results[plugin.id] = r;
					this.cache[plugin.id] = r;
					bump();
				}
			};

			// 启动并发 worker
			const workers = Math.min(CONCURRENCY, needOnline.length);
			await Promise.all(Array.from({ length: workers }, () => translateOne()));
		}

		return results;
	}

	/**
	 * 增量翻译（预计算 + diff）：
	 * 离线词典与缓存命中的结果同步合并，零网络、零逐条 await；
	 * 仅对「既无缓存、又无离线词典命中」的新插件发起在线翻译。
	 */
	async translateBatchIncremental(
		plugins: PluginInfo[],
		onProgress?: (done: number, total: number) => void
	): Promise<Record<string, TranslateResult>> {
		const results: Record<string, TranslateResult> = {};
		const needOnline: PluginInfo[] = [];

		for (const plugin of plugins) {
			if (this.cache[plugin.id] && this.cache[plugin.id].source !== "original") {
				results[plugin.id] = this.cache[plugin.id];
				continue;
			}
			needOnline.push(plugin);
		}

		const onlineCount = needOnline.length;
		const onlineResults = await this.translateBatch(needOnline, (done) => {
			onProgress?.(done, onlineCount);
		});
		for (const plugin of needOnline) {
			results[plugin.id] = onlineResults[plugin.id] ?? {
				translatedName: plugin.name,
				translatedDesc: plugin.description,
				source: "original",
			};
		}

		return results;
	}

	/**
	 * 懒翻译第一步（产品改进 #9）：同步合并离线命中（cache/tmApproved/aiDict），
	 * 未命中给 original 兜底用于即时渲染但不写缓存，待 translateSubset 真正翻译。
	 * @returns results - 即时渲染用的翻译结果；pending - 待在线翻译的插件
	 */
	mergeOffline(plugins: PluginInfo[]): {
		results: Record<string, TranslateResult>;
		pending: PluginInfo[];
	} {
		const results: Record<string, TranslateResult> = {};
		const pending: PluginInfo[] = [];
		for (const plugin of plugins) {
			if (this.cache[plugin.id]) {
				let entry = this.cache[plugin.id];
				// 清洗脏数据：历史遗留缓存可能存在 source="original" 但译名非原文的情况
				// （如旧版兜底逻辑或数据迁移遗留），将其提升为 bulk 以正确计入「已翻译」。
				if (entry.source === "original" && entry.translatedName !== plugin.name) {
					entry = { ...entry, source: "bulk" };
					this.cache[plugin.id] = entry; // 就地修正，下次持久化后脏数据消失
				}
				results[plugin.id] = entry;
				if (entry.source === "original") pending.push(plugin);
				continue;
			}
			// 翻译记忆库已采纳层（可信层）
			const tmHit = this.lookupTMApproved(plugin.id, plugin.name, plugin.description);
			if (tmHit) {
				results[plugin.id] = tmHit;
				this.cache[plugin.id] = tmHit;
				continue;
			}
			// 个人 AI 固化资产（clearCache 不清，即时渲染即用，无需重新烧 token）
			const aiEntry = this.aiAssetStore.get(plugin.id);
			if (aiEntry) {
				const r: TranslateResult = {
					translatedName: aiEntry.name || plugin.name,
					translatedDesc: aiEntry.description || plugin.description,
					source: "ai",
				};
				results[plugin.id] = r;
				this.cache[plugin.id] = r;
				continue;
			}
			// 未命中：先给 original 兜底用于即时渲染，但不写缓存，待 translateSubset 真正翻译
			results[plugin.id] = {
				translatedName: plugin.name,
				translatedDesc: plugin.description,
				source: "original",
			};
			pending.push(plugin);
		}
		return { results, pending };
	}

	/**
	 * 懒翻译第二步（产品改进 #9）：只翻译传入的这一小批插件。
	 * 每翻完一个通过 onOne 回调交给上层就地刷新对应卡片。
	 * 结果写入 cache。已在缓存且非 original 的会被跳过。
	 */
	async translateSubset(
		plugins: PluginInfo[],
		onOne?: (id: string, result: TranslateResult) => void,
		opts?: { skipAI?: boolean }
	): Promise<void> {
		const targets = plugins.filter(
			(p) => !this.cache[p.id] || this.cache[p.id].source === "original"
		);
		if (targets.length === 0) return;

		const translateOne = async (plugin: PluginInfo): Promise<void> => {
			// 复用 translatePlugin：其内部有并发去重（inFlight），与批量翻译共享同一结果，
			// 同一插件无论被多少个入口并发触发都只真正翻译一次。优先级链与单条完全一致。
			const result = await this.translatePlugin(plugin, opts);
			onOne?.(plugin.id, result);
		};

		const CONCURRENCY = 4;
		await mapWithConcurrency(targets, CONCURRENCY, (plugin) => translateOne(plugin));
	}

	private logTencentError(pluginId: string, error: unknown) {
		const msg = error instanceof Error ? error.message : String(error);
		logger.warn(`[Chinese Plugin Market] 腾讯翻译失败 (${pluginId}):`, msg);
	}

	// ══════════════════════════════════════════════════
	// 向量索引
	// ══════════════════════════════════════════════════

	getVectorIndex() {
		return this.aiSearcher.getVectorIndex();
	}

	setVectorIndex(vi: import("@semantic/embedding").VectorIndex | null) {
		this.aiSearcher.setVectorIndex(vi);
	}

	// ══════════════════════════════════════════════════
	// AI 功能代理（委托给 AISearcher）
	// ══════════════════════════════════════════════════

	hasAI(): boolean {
		return !!(this.aiConfig?.apiKey);
	}

	/**
	 * AI 搜索委托给搜索管线。
	 * @param config    可选 AI 搜索配置（向后兼容，未传则用已设的）
	 * @param showReason 是否在结果中附带 LLM 排序理由
	 * @param onPhase   阶段性回调（进度报告）
	 * @param filterCategories 可选分类过滤
	 */
	async aiSearch(
		query: string,
		allPlugins: { id: string; name: string; description: string }[],
		config?: AISearchConfig,
		showReason = false,
		onPhase?: (phase: string, detail: string) => void,
		filterCategories?: string[],
	): Promise<AISearchResult> {
		if (config) this.setAIConfig(config);
		return this.aiSearcher.search(query, allPlugins, showReason, onPhase, filterCategories);
	}

	/**
	 * 本地语义搜索委托：不做 LLM 精排，纯本地 RRF 融合排序（免 API Key、零 token）。
	 * @param config 可选 AI 搜索配置（提供 embedding 配置；向后兼容）
	 */
	async aiSearchLocal(
		query: string,
		allPlugins: { id: string; name: string; description: string }[],
		config?: AISearchConfig,
		filterCategories?: string[],
	): Promise<AISearchResult> {
		if (config) this.setAIConfig(config);
		return this.aiSearcher.localSearch(query, allPlugins, filterCategories);
	}

	/** AI 深度对比委托（带缓存：同一插件集合直接命中，避免重复烧 token） */
	async aiCompare(items: CompareItem[]): Promise<string | null> {
		const cached = this.insightCache.getCompareInsight(items.map((i) => i.id));
		if (cached) return cached;
		const md = await this.aiSearcher.compare(items);
		if (md) this.setCompareInsight(items.map((i) => i.id), md);
		return md;
	}

	/** 对比缓存键：按插件 id 排序集合，保证 {A,B} 与 {B,A} 命中同一缓存 */
	compareKey(ids: string[]): string {
		return this.insightCache.compareKey(ids);
	}

	getCompareInsight(ids: string[]): string | undefined {
		return this.insightCache.getCompareInsight(ids);
	}

	setCompareInsight(ids: string[], text: string) {
		this.insightCache.setCompareInsight(ids, text);
	}
}

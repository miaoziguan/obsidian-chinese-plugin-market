/**
 * 过滤 / 排序管线（零 DOM/Obsidian 依赖的纯函数，便于单元测试）。
 *
 * 从 main.ts 的 renderPluginList / matchesQuery / buildSearchIndex / 空态决策提取，
 * 视图层仅保留 DOM 副作用（结果计数、layer 清空、滚动复位、renderWindow），
 * 数据计算全部委托本模块——历史 bug（空态条件写反、AI 空查询）即出在这一层，
 * 抽出后可用回归用例锁死正确行为。
 */

import type { PluginInfo, TranslateResult, AISearchResult } from "@domain/catalog/translator";
import type { QueryAST, QueryFields } from "@domain/search/query";
import { isAdvancedQuery, parseQuery, matchQueryAST } from "@domain/search/query";
import { sortPlugins, type SortBy } from "@domain/filter/sort";
import type { I18nKey } from "@shared/i18n";
import { isAIWorthyQuery, isKeywordWorthyQuery } from "@domain/search/ai-explorer";

/**
 * 过滤前缀增量缓存（封装 7 个 lastFilter* 字段，减少视图层状态散落）。
 *
 * 视图层不再直接持有 lastFiltered / lastFilterQuery / ... 等 7 个字段，
 * 而是通过 FilterCache 实例统一管理——回写时调用 sync()，构建 params 时调用 snapshot()。
 */
export class FilterCache {
	private _list: PluginInfo[] = [];
	private _query = "";
	private _source: string = "all";
	private _author: string | null = null;
	private _install: InstallFilter = "all";
	private _recommendedOnly = false;
	private _categories?: string[];
	private _favorites: FavoriteFilter = "all";
	/** 上一次过滤所处的搜索模式（H1：AI 召回子集不得被关键词模式当前缀基础集复用） */
	private _mode: SearchMode = "keyword";

	/** 将 FilterResult 的回写值同步到缓存 */
	sync(result: FilterResult): void {
		this._list = result.nextFiltered;
		this._query = result.nextFilterQuery;
		this._source = result.nextFilterSource;
		this._author = result.nextFilterAuthor;
		this._install = result.nextFilterInstall;
		this._recommendedOnly = result.nextFilterRecommendedOnly ?? false;
		this._categories = result.nextFilterCategories;
		this._favorites = result.nextFilterFavorites ?? "all";
		this._mode = result.nextFilterMode ?? "keyword";
	}

	/** 生成传给 filterAndSortPlugins 的快照字段 */
	snapshot(): Pick<FilterParams,
		| "lastFiltered" | "lastFilterQuery" | "lastFilterSource"
		| "lastFilterAuthor" | "lastFilterInstall"
		| "lastFilterRecommendedOnly" | "lastFilterCategories"
		| "lastFilterFavorites" | "lastFilterMode"> {
		return {
			lastFiltered: this._list,
			lastFilterQuery: this._query,
			lastFilterSource: this._source,
			lastFilterAuthor: this._author,
			lastFilterInstall: this._install,
			lastFilterRecommendedOnly: this._recommendedOnly,
			lastFilterCategories: this._categories,
			lastFilterFavorites: this._favorites,
			lastFilterMode: this._mode,
		};
	}

	/**
	 * 重置缓存（数据刷新/模式切换/集合内容变化时调用）。
	 * H2：canReuse 只比对筛选「值」，感知不到 installedIds / translatedResults /
	 * recommendedSet 等集合「内容」的变化——安装新插件、译文陆续到位都可能让原本
	 * 不匹配的插件变为匹配，而前缀复用只会在旧子集内继续收窄（只减不增）。
	 * 因此这些集合变化的事件点（安装快照刷新、窗口翻译批次完成、模式切换）必须调用本方法。
	 */
	reset(): void {
		this._list = [];
		this._query = "";
		this._source = "all";
		this._author = null;
		this._install = "all";
		this._recommendedOnly = false;
		this._categories = undefined;
		this._favorites = "all";
		this._mode = "keyword";
	}
}

/** 搜索模式（关键词 / 本地语义 / AI 语义） */
export type SearchMode = "keyword" | "local" | "ai";

/** 翻译来源筛选（"all" 表示全部；"translated" 表示任意已有译文，含批量/在线/AI/自定义） */
export type SourceFilter = "all" | "translated" | "original";

/** 安装状态筛选（enabled 仅已启用的已安装插件；installedNotEnabled 仅已安装未启用的插件） */
export type InstallFilter = "all" | "installed" | "enabled" | "installedNotEnabled";

/** 收藏筛选（"all" 表示全部；"favorited" 仅已收藏；"unfavorited" 仅未收藏） */
export type FavoriteFilter = "all" | "favorited" | "unfavorited";

/**
 * 构建单插件的小写化搜索串（名称 / ID / 描述 / 译名 / 译描 / 作者）。
 * 供搜索索引预计算与即时匹配共用，保证两路口径一致。
 */
export function buildSearchBlob(p: PluginInfo, result?: TranslateResult): string {
	return [
		p.name,
		p.id,
		p.description,
		result?.translatedName || "",
		result?.translatedDesc || "",
		p.author,
	]
		.join(" ")
		.toLowerCase();
}

/** matchesPlugin 的筛选上下文（全部经参数传入，不读视图 this） */
export interface MatchOptions {
	sourceFilter: SourceFilter;
	installFilter: InstallFilter;
	searchMode: SearchMode;
	installedIds: Set<string>;
	/** 已启用插件 id 集合（installFilter="enabled" 时使用） */
	enabledIds: Set<string>;
	translatedResults: Record<string, TranslateResult>;
	searchIndex: Map<string, string>;
	/** 作者维度：按作者精确筛选（作者钻取 / 作者 facet），null 表示不过滤 */
	authorFilter: string | null;
	/** 官方推荐：仅展示推荐清单内的插件（false/undefined 表示不过滤） */
	recommendedOnly?: boolean;
	/** 官方推荐插件 id 集合（由 plugin-recommend.json 加载） */
	recommendedSet?: Set<string>;
	/** 收藏优先排序：收藏项置顶而非隐藏未收藏项（RC-3） */
	sortFavoritesFirst?: boolean;
	/** 收藏筛选："favorited" 仅已收藏 / "unfavorited" 仅未收藏 / "all" 全部 */
	favoriteFilter?: FavoriteFilter;
	/** 用户收藏插件 id 集合（由 settings.favorites 加载为 Set） */
	favoritesSet?: Set<string>;
	/** 分类筛选：选中分类列表（多选取并集；空/undefined 不过滤） */
	selectedCategories?: string[];
	/** 插件 id → 一级分类映射（由 translator.pluginTags 构建，用于本地分类过滤） */
	pluginTagMap?: Map<string, string>;
	/**
	 * 历史译文判定回调（仅 sourceFilter="original" / "从未翻译" 时使用）。
	 * 若提供，则 "original" 筛选会额外排除已有历史落盘译文的插件
	 * （cache 非 original / TM 已采纳 / AI 固化资产），实现真正的「从未翻译」语义。
	 * 不提供则退化为旧行为（仅看 translatedResults.source）。
	 */
	hasHistoryTranslation?: (id: string, plugin: PluginInfo) => boolean;
}

/**
 * 判断单个插件是否匹配当前搜索词（按 searchMode 分模式匹配）。
 * @param ast 可选：keyword 模式下预解析的高级语法 AST（避免逐条重复解析）
 */
export function matchesPlugin(
	p: PluginInfo,
	query: string,
	opts: MatchOptions,
	ast?: QueryAST
): boolean {
	const result = opts.translatedResults[p.id];
	if (opts.sourceFilter === "translated") {
		if ((result?.source ?? "original") === "original") return false;
	} else if (opts.sourceFilter === "original") {
		if ((result?.source ?? "original") !== "original") return false;
		// sourceFilter="original"（从未翻译）：额外排除有历史落盘译文的插件
		if (opts.hasHistoryTranslation && opts.hasHistoryTranslation(p.id, p)) return false;
	}
	// 安装状态筛选
	if (opts.installFilter === "installed" && !opts.installedIds.has(p.id)) {
		return false;
	}
	if (opts.installFilter === "enabled" && !opts.enabledIds.has(p.id)) {
		return false;
	}
	if (
		opts.installFilter === "installedNotEnabled" &&
		(!opts.installedIds.has(p.id) || opts.enabledIds.has(p.id))
	) {
		return false;
	}
	// 作者维度：按作者精确筛选（所有模式生效；null 表示不过滤）
	if (opts.authorFilter && p.author !== opts.authorFilter) return false;
	// 官方推荐：仅保留推荐清单内的插件（所有模式生效）
	if (opts.recommendedOnly && opts.recommendedSet && !opts.recommendedSet.has(p.id)) return false;
	// 收藏筛选：仅已收藏 / 仅未收藏
	if (opts.favoriteFilter === "favorited" && opts.favoritesSet && !opts.favoritesSet.has(p.id)) return false;
	if (opts.favoriteFilter === "unfavorited" && opts.favoritesSet && opts.favoritesSet.has(p.id)) return false;
	// 分类筛选：仅保留分类匹配的插件（多选取并集；所有模式生效，作为全局发现维度）
	if (opts.selectedCategories?.length && opts.pluginTagMap) {
		const cat = opts.pluginTagMap.get(p.id);
		if (!cat || !opts.selectedCategories.includes(cat)) return false;
	}
	if (!query) return true;

	switch (opts.searchMode) {
		case "ai":
			// AI 语义模式：本地不过滤，把所有插件交给 AI 做语义召回+排序。
			return true;
		case "keyword":
		default: {
			// 命中缓存直接用；未命中时增量补建进 searchIndex（同一 Map 引用，
			// 与 buildSearchIndex 语义一致），避免同一插件在每次按键时重复拼接+toLowerCase。
			let blob = opts.searchIndex.get(p.id);
			if (blob === undefined) {
				blob = buildSearchBlob(p, result);
				opts.searchIndex.set(p.id, blob);
			}
			if (ast && ast.advanced) {
				const fields: QueryFields = {
					name: `${p.name} ${result?.translatedName || ""}`,
					id: p.id,
					description: `${p.description} ${result?.translatedDesc || ""}`,
					author: p.author,
					blob,
				};
				return matchQueryAST(fields, ast);
			}
			return blob.includes(query);
		}
	}
}

/** filterAndSortPlugins 的入参（完整只读上下文） */
export interface FilterParams {
	plugins: PluginInfo[];
	searchMode: SearchMode;
	query: string;
	sourceFilter: SourceFilter;
	installFilter: InstallFilter;
	/** 作者维度：按作者精确筛选（null 表示不过滤） */
	authorFilter: string | null;
	/** 官方推荐：仅展示推荐清单内插件 */
	recommendedOnly?: boolean;
	/** 官方推荐插件 id 集合 */
	recommendedSet?: Set<string>;
	/** 收藏优先排序：收藏项置顶而非隐藏未收藏项（RC-3） */
	sortFavoritesFirst?: boolean;
	/** 收藏筛选："favorited" 仅已收藏 / "unfavorited" 仅未收藏 / "all" 全部 */
	favoriteFilter?: FavoriteFilter;
	/** 用户收藏插件 id 集合 */
	favoritesSet?: Set<string>;
	/** 分类筛选：选中分类列表（多选取并集） */
	selectedCategories?: string[];
	/** 插件 id → 一级分类映射 */
	pluginTagMap?: Map<string, string>;
	installedIds: Set<string>;
	/** 已启用插件 id 集合（installFilter="enabled" 时使用） */
	enabledIds: Set<string>;
	translatedResults: Record<string, TranslateResult>;
	searchIndex: Map<string, string>;
	/**
	 * 历史译文判定回调（透传给 MatchOptions，仅 sourceFilter="original" 时生效）。
	 * 语义同 MatchOptions.hasHistoryTranslation。
	 */
	hasHistoryTranslation?: (id: string, plugin: PluginInfo) => boolean;
	sortBy: SortBy;
	/** 趋势评分 (id → 0-1)，供 "trending" 排序使用 */
	trendingScores?: Map<string, number>;
	/** 综合推荐评分 (id → 0-100)，供 "recommended" 排序使用 */
	recommendScores?: Map<string, number>;
	// AI 语义搜索状态
	aiSearchResult: AISearchResult | null;
	aiSearchQueryCache: string;
	// 前缀增量缓存（上一次过滤的状态）
	lastFiltered: PluginInfo[];
	lastFilterQuery: string;
	lastFilterSource: string;
	lastFilterAuthor: string | null;
	/** 上一次的 installFilter（缓存失效判断，避免切回「全部」时复用已安装子集） */
	lastFilterInstall?: InstallFilter;
	/** 上一次的 recommendedOnly */
	lastFilterRecommendedOnly?: boolean;
	/** 上一次的 favoriteFilter（缓存失效判断，避免切回「全部」时复用收藏子集） */
	lastFilterFavorites?: FavoriteFilter;
	/** 上一次选中的分类（数组引用比对，变化时使缓存失效） */
	lastFilterCategories?: string[];
	/** 上一次过滤所处的搜索模式（缺省视为 keyword，向后兼容） */
	lastFilterMode?: SearchMode;
}

/** filterAndSortPlugins 的返回：过滤排序结果 + 回写给视图的缓存状态 + AI 残留清理标志 */
export interface FilterResult {
	/** 过滤 + 排序后的最终展示列表 */
	list: PluginInfo[];
	/** 更新后的前缀缓存（视图回写 lastFiltered / lastFilterQuery / lastFilterSource） */
	nextFiltered: PluginInfo[];
	nextFilterQuery: string;
	nextFilterSource: string;
	nextFilterAuthor: string | null;
	/** 回写的 installFilter（供下次缓存失效判断） */
	nextFilterInstall: InstallFilter;
	nextFilterRecommendedOnly?: boolean;
	nextFilterFavorites?: FavoriteFilter;
	nextFilterCategories?: string[];
	/** 回写的搜索模式（供下次缓存复用判定：AI 子集不得被关键词模式复用） */
	nextFilterMode: SearchMode;
	/** 非 AI 路径下是否应清空残留的 aiSearchResult（视图据此置 null） */
	clearAiResult: boolean;
}

/**
 * 过滤 + 排序管线（renderPluginList 的纯数据部分，不含 DOM 副作用）。
 * 含 AI 分支、前缀增量缓存「是否复用」判定与应用、排序。
 *
 * 注意：AI 分支仅应用 sourceFilter（与原始行为一致，不应用 installFilter），
 * 前缀缓存状态（nextFiltered）记录的是【排序前】的过滤结果。
 */
export function filterAndSortPlugins(params: FilterParams): FilterResult {
	const {
		plugins, searchMode, query, sourceFilter, installFilter, installedIds, enabledIds,
		translatedResults, searchIndex, sortBy,
		aiSearchResult, aiSearchQueryCache,
  lastFiltered, lastFilterQuery, lastFilterSource, lastFilterAuthor, authorFilter,
  lastFilterInstall = "all", lastFilterRecommendedOnly = false, lastFilterFavorites = "all",
  lastFilterCategories, lastFilterMode = "keyword",
		recommendedOnly, recommendedSet,
		sortFavoritesFirst, favoriteFilter, favoritesSet,
		selectedCategories, pluginTagMap,
		hasHistoryTranslation,
	} = params;

	const matchOpts: MatchOptions = {
		sourceFilter, installFilter, searchMode, installedIds, enabledIds, translatedResults, searchIndex, authorFilter,
		recommendedOnly, recommendedSet,
		sortFavoritesFirst, favoriteFilter, favoritesSet,
		selectedCategories, pluginTagMap,
		hasHistoryTranslation,
	};

	let filtered: PluginInfo[];
	let nextFiltered: PluginInfo[];
	let nextFilterQuery: string;
	let nextFilterSource: string;
	let nextFilterAuthor: string | null;
	let nextFilterInstall: InstallFilter;
	let nextFilterRecommendedOnly: boolean | undefined;
	let nextFilterFavorites: FavoriteFilter | undefined;
	let nextFilterCategories: string[] | undefined;
	let clearAiResult = false;

	if ((searchMode === "ai" || searchMode === "local") && query) {
		// AI / 本地语义模式（有查询词）：展示集合由召回结果（rankedIds）决定。
		// AI 模式 = LLM 精排后的序；本地模式 = RRF 融合序。
		// 有结果 → 仅展示排名内的插件（按排名顺序）；无结果 → 展示为空。
		if (aiSearchResult && aiSearchQueryCache === query) {
			const byId = new Map(plugins.map((p) => [p.id, p]));
			filtered = aiSearchResult.rankedIds
				.map((id) => byId.get(id))
				.filter((p): p is PluginInfo => !!p);
			// 与本地模式一致：应用来源筛选（已翻译 / 未翻译）
			if (sourceFilter === "translated") {
				filtered = filtered.filter((p) => {
					const src = translatedResults[p.id]?.source ?? "original";
					return src !== "original";
				});
			} else if (sourceFilter === "original") {
				filtered = filtered.filter((p) => {
					const src = translatedResults[p.id]?.source ?? "original";
					if (src !== "original") return false;
					// "original"（从未翻译）：额外排除有历史译文的插件
					if (matchOpts.hasHistoryTranslation && matchOpts.hasHistoryTranslation(p.id, p)) return false;
					return true;
				});
			}
			// 分类筛选（AI 模式也要生效，作为全局发现维度）
			if (selectedCategories?.length && pluginTagMap) {
				filtered = filtered.filter((p) => {
					const cat = pluginTagMap.get(p.id);
					return cat && selectedCategories.includes(cat);
				});
			}
			// 收藏优先排序（RC-3）：在 AI 召回集内将收藏项前置（而非隐藏未收藏）
			if (sortFavoritesFirst && favoritesSet && filtered.length > 0) {
				const favSet = favoritesSet;
				filtered = [...filtered].sort((a, b) => {
					const aFav = favSet.has(a.id) ? 0 : 1;
					const bFav = favSet.has(b.id) ? 0 : 1;
					if (aFav !== bFav) return aFav - bFav;
					return 0; // 保持原有排序
				});
			}
			// 作者筛选（AI 模式也要收窄，与本地模式行为一致）
			if (authorFilter) {
				filtered = filtered.filter((p) => p.author === authorFilter);
			}
		} else {
			filtered = [];
		}
		// AI 模式不使用前缀增量缓存（集合来源不同），但仍回写状态保持一致
		nextFiltered = filtered;
		nextFilterQuery = query;
		nextFilterSource = sourceFilter;
		nextFilterAuthor = authorFilter;
	} else {
		// 非 AI 模式：本地过滤 + 前缀增量缓存优化
		// 高级语法仅在 keyword 模式解析；其余模式沿用原有子串逻辑。
		const advanced = searchMode === "keyword" && isAdvancedQuery(query);
		const ast = advanced ? parseQuery(query) : undefined;

		// 高级语法查询禁用前缀增量缓存（AST 语义与「更长 query 是更严格子集」不等价）。
		// 安装/推荐/分类等维度变化会使缓存基础集失效，必须全量重滤
		const sameCategories =
			(lastFilterCategories?.length ?? 0) === (selectedCategories?.length ?? 0) &&
			(lastFilterCategories ?? []).every((c, i) => c === (selectedCategories ?? [])[i]);
		const canReuse =
			!advanced &&
			// H1：仅关键词→关键词可复用。AI 分支回写的 lastFiltered 是 AI 召回子集，
			// 切回关键词模式若在其上做前缀收窄，会把全库其余匹配项静默丢掉。
			searchMode === "keyword" &&
			lastFilterMode === "keyword" &&
			lastFiltered.length > 0 &&
			lastFilterSource === sourceFilter &&
			lastFilterAuthor === authorFilter &&
			lastFilterInstall === installFilter &&
			lastFilterRecommendedOnly === recommendedOnly &&
			lastFilterFavorites === favoriteFilter &&
			sameCategories &&
			(lastFilterQuery === "" || query.startsWith(lastFilterQuery));

		if (canReuse) {
			filtered = lastFiltered.filter((p) => matchesPlugin(p, query, matchOpts, ast));
		} else {
			filtered = plugins.filter((p) => matchesPlugin(p, query, matchOpts, ast));
		}

		nextFilterQuery = query;
		nextFilterSource = sourceFilter;
		nextFilterAuthor = authorFilter;
		nextFiltered = filtered;

		// 非 AI 路径：标记应清空残留 AI 结果（视图据此置 null）
		if (aiSearchResult) clearAiResult = true;
	}

	// 回写缓存状态（与分支无关，统一在此赋值）
	nextFilterInstall = installFilter;
	nextFilterRecommendedOnly = recommendedOnly;
	nextFilterFavorites = favoriteFilter;
	nextFilterCategories = selectedCategories;

	// 应用排序。relevance 保持来源顺序（AI=rankedIds 序 / 本地=过滤序）；其余维度覆盖之。
	// displayName 取译名（中文名优先）用于名称排序——通过 displayNameOf 回调就地计算，
	// 避免为排序把每条插件全量展开成新对象（5617 次浅拷贝）。
	if (sortBy !== "relevance") {
		filtered = sortPlugins(filtered, sortBy, {
			installedIds,
			trendingScores: params.trendingScores,
			recommendScores: params.recommendScores,
			displayNameOf: (p) => translatedResults[p.id]?.translatedName || p.name,
		});
	}

	// 收藏优先排序：收藏的插件排在前面（而非隐藏未收藏的）
	if (sortFavoritesFirst && favoritesSet && filtered.length > 0) {
		const favSet = favoritesSet;
		filtered.sort((a, b) => {
			const aFav = favSet.has(a.id) ? 0 : 1;
			const bFav = favSet.has(b.id) ? 0 : 1;
			if (aFav !== bFav) return aFav - bFav;
			return 0; // 保持原有排序
		});
	}

	return {
		list: filtered,
		nextFiltered,
		nextFilterQuery,
		nextFilterSource,
		nextFilterAuthor,
		nextFilterInstall,
		nextFilterRecommendedOnly,
		nextFilterFavorites,
		nextFilterCategories,
		nextFilterMode: searchMode,
		clearAiResult,
	};
}

/** resolveEmptyState 入参 */
export interface EmptyStateInput {
	hasQuery: boolean;
	searchMode: SearchMode;
	aiSearchResult: AISearchResult | null;
	sourceFilter: SourceFilter;
	installFilter: InstallFilter;
	/** 收藏筛选："favorited" 仅已收藏 / "unfavorited" 仅未收藏 / "all" 全部 */
	favoriteFilter?: FavoriteFilter;
	/** 是否已配置 AI API Key（用于判断能否推荐 AI 搜索桥接） */
	hasAIKey: boolean;
	/** 原始查询词（用于桥接启发式，如 keyword→AI / AI→keyword） */
	_query?: string;
}

/** 空态决策结果（返回 i18n key，视图负责 t()） */
export interface EmptyState {
	titleKey: I18nKey;
	hintKey: I18nKey;
	/** 是否显示「清除筛选」快捷按钮（有可清除的查询/筛选时为真） */
	showClearAction: boolean;
	/**
	 * 跨模式搜索桥接：当当前模式搜索结果为空时，建议切换到另一个模式。
	 * — keyword 空 + query 语义丰富 → bridgeAction={ labelKey:"empty.tryAI", mode:"ai" }
	 * — AI 空 + query 为短关键词 → bridgeAction={ labelKey:"empty.tryKeyword", mode:"keyword" }
	 */
	bridgeAction: { labelKey: I18nKey; mode: SearchMode } | null;
}

/**
 * 空状态文案与「清除筛选」按钮可见性决策（renderWindow 空态分支的纯逻辑）。
 *
 * 回归锁死点：showClearAction 的 installFilter 条件为 `=== "uninstalled"`
 * （仅当「仅未安装」筛选生效时才算有可清除的筛选），曾因写成 `!==` 导致按钮恒显示。
 */
export function resolveEmptyState(input: EmptyStateInput): EmptyState {
	const { hasQuery, searchMode, aiSearchResult, sourceFilter, installFilter, favoriteFilter, hasAIKey } = input;

	let titleKey: I18nKey;
	let hintKey: I18nKey;
	let bridgeAction: EmptyState["bridgeAction"] = null;

	if (!hasQuery) {
		titleKey = "empty.noData";
		hintKey = "empty.noData.filter";
	} else if (searchMode === "ai" || searchMode === "local") {
		if (!aiSearchResult) {
			titleKey = searchMode === "local" ? "empty.local.pending" : "ai.pending.title";
			hintKey = searchMode === "local" ? "empty.local.hint" : "empty.ai.hint";
		} else {
			titleKey = "empty.noMatch";
			hintKey = "empty.clearFilter";
			// 语义结果为空 + 查询像关键词 → 桥接到 keyword
			if (isKeywordWorthyQuery(input._query ?? "")) {
				bridgeAction = { labelKey: "empty.tryKeyword", mode: "keyword" };
			}
		}
	} else {
		titleKey = "empty.noMatch";
		hintKey = "empty.clearFilter";
		// keyword 结果为空 + 查询语义丰富 + 已配置 AI Key → 桥接到 AI
		if (hasAIKey && isAIWorthyQuery(input._query ?? "")) {
			bridgeAction = { labelKey: "empty.tryAI", mode: "ai" };
		}
	}

	const activeFavorite = favoriteFilter ?? "all";
	const showClearAction =
		hasQuery || sourceFilter !== "all" || installFilter === "installed" || installFilter === "enabled" || installFilter === "installedNotEnabled" || activeFavorite !== "all";

	return { titleKey, hintKey, showClearAction, bridgeAction };
}

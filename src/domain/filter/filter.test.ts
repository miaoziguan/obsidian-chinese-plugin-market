/**
 * filter.ts 单元测试。
 * 覆盖：搜索串构建、单插件匹配（子串/高级语法/AI/来源/安装筛选）、
 * 过滤排序管线（AI 分支/前缀缓存/排序/AI 残留清理）、空态决策（含 bug #3 回归）。
 */
import { describe, it, expect } from "vitest";
import {
	buildSearchBlob,
	matchesPlugin,
	filterAndSortPlugins,
	resolveEmptyState,
	FilterCache,
	type MatchOptions,
	type FilterParams,
	type SearchMode,
	type SourceFilter,
	type InstallFilter,
	type FilterResult,
	type EmptyStateInput,
} from "@domain/filter/filter";
import type { PluginInfo, TranslateResult, AISearchResult } from "@domain/catalog/translator";

// ── 测试夹具 ──

function mkPlugin(over: Partial<PluginInfo> & { id: string }): PluginInfo {
	return {
		name: over.id,
		description: "",
		author: "",
		...over,
	};
}

const P_MIND = mkPlugin({ id: "enhancing-mindmap", name: "Enhancing Mind Map", description: "mind map tool", author: "Mark", downloads: 100 });
const P_CAL = mkPlugin({ id: "calendar", name: "Calendar", description: "simple calendar", author: "Liam", downloads: 900 });
const P_GIT = mkPlugin({ id: "obsidian-git", name: "Obsidian Git", description: "backup with git", author: "Vinzent", downloads: 500 });
const PLUGINS = [P_MIND, P_CAL, P_GIT];

const R_MIND: TranslateResult = { translatedName: "思维导图", translatedDesc: "思维导图工具", source: "bulk" };
const R_CAL: TranslateResult = { translatedName: "日历", translatedDesc: "简洁日历", source: "online" };
// P_GIT 未翻译（original）

const RESULTS: Record<string, TranslateResult> = {
	[P_MIND.id]: R_MIND,
	[P_CAL.id]: R_CAL,
};

function mkIndex(): Map<string, string> {
	const m = new Map<string, string>();
	for (const p of PLUGINS) m.set(p.id, buildSearchBlob(p, RESULTS[p.id]));
	return m;
}

function baseMatchOpts(over: Partial<MatchOptions> = {}): MatchOptions {
	return {
		sourceFilter: "all",
		installFilter: "all",
		searchMode: "keyword",
		installedIds: new Set(),
		enabledIds: new Set(),
		translatedResults: RESULTS,
		searchIndex: mkIndex(),
		authorFilter: null,
		...over,
	};
}

function baseFilterParams(over: Partial<FilterParams> = {}): FilterParams {
	return {
		plugins: PLUGINS,
		searchMode: "keyword",
		query: "",
		sourceFilter: "all",
		installFilter: "all",
		authorFilter: null,
		installedIds: new Set(),
		enabledIds: new Set(),
		translatedResults: RESULTS,
		searchIndex: mkIndex(),
		sortBy: "relevance",
		aiSearchResult: null,
		aiSearchQueryCache: "",
		lastFiltered: [],
		lastFilterQuery: "",
		lastFilterSource: "all",
		lastFilterAuthor: null,
		...over,
	};
}

// ── buildSearchBlob ──

describe("buildSearchBlob", () => {
	it("拼接名称/ID/描述/译名/译描/作者并小写化", () => {
		const blob = buildSearchBlob(P_MIND, R_MIND);
		expect(blob).toContain("enhancing-mindmap");
		expect(blob).toContain("enhancing mind map");
		expect(blob).toContain("思维导图");
		expect(blob).toContain("mark");
		expect(blob).toBe(blob.toLowerCase());
	});

	it("无翻译结果时仅含原文字段", () => {
		const blob = buildSearchBlob(P_GIT);
		expect(blob).toContain("obsidian-git");
		expect(blob).toContain("backup with git");
	});
});

// ── matchesPlugin ──

describe("matchesPlugin", () => {
	it("空查询匹配所有", () => {
		expect(matchesPlugin(P_GIT, "", baseMatchOpts())).toBe(true);
	});

	it("子串匹配命中译名", () => {
		expect(matchesPlugin(P_MIND, "思维", baseMatchOpts())).toBe(true);
	});

	it("子串匹配命中原名", () => {
		expect(matchesPlugin(P_CAL, "calendar", baseMatchOpts())).toBe(true);
	});

	it("不匹配返回 false", () => {
		expect(matchesPlugin(P_GIT, "思维", baseMatchOpts())).toBe(false);
	});

	it("AI 模式本地不过滤（恒真）", () => {
		const opts = baseMatchOpts({ searchMode: "ai" });
		expect(matchesPlugin(P_GIT, "任意不相关词", opts)).toBe(true);
	});

	it("来源筛选：translated 命中任意已有译文（批量/在线/AI）", () => {
		const opts = baseMatchOpts({ sourceFilter: "translated" });
		expect(matchesPlugin(P_MIND, "", opts)).toBe(true); // bulk
		expect(matchesPlugin(P_CAL, "", opts)).toBe(true); // online
		expect(matchesPlugin(P_GIT, "", opts)).toBe(false); // original
	});

	it("来源筛选：original 命中未翻译插件", () => {
		const opts = baseMatchOpts({ sourceFilter: "original" });
		expect(matchesPlugin(P_GIT, "", opts)).toBe(true);
		expect(matchesPlugin(P_MIND, "", opts)).toBe(false);
	});

	it("来源筛选：original + hasHistoryTranslation 排除历史译文（真正的'从未翻译'）", () => {
		// P_GIT 在 translatedResults 中是 original（本次会话未译），但 hasHistoryTranslation 返回 true
		// （模拟 cache/tm/aiAssetStore 有历史译文）→ 应被排除
		const opts = baseMatchOpts({
			sourceFilter: "original",
			hasHistoryTranslation: (id) => id === P_GIT.id,
		});
		expect(matchesPlugin(P_GIT, "", opts)).toBe(false); // 有历史译文 → 不在"从未翻译"
		expect(matchesPlugin(P_CAL, "", opts)).toBe(false);  // online 来源，第一层就被排除
		// 新增一个完全无译文、hasHistoryTranslation 也返回 false 的插件
		const brandNew = mkPlugin({ id: "brand-new", name: "Brand New Plugin" });
		expect(matchesPlugin(brandNew, "", opts)).toBe(true); // 真正从未翻译
	});

	it("来源筛选：translated 也命中 AI 翻译来源", () => {
		const aiResult: TranslateResult = { translatedName: "AI插件", translatedDesc: "由 AI 翻译", source: "ai" };
		const opts = baseMatchOpts({
			sourceFilter: "translated",
			translatedResults: { "ai-plugin": aiResult },
		});
		const aiPlugin = mkPlugin({ id: "ai-plugin", name: "AI Plugin" });
		expect(matchesPlugin(aiPlugin, "", opts)).toBe(true);
		// 非译文来源（original 的 P_GIT）不被命中
		expect(matchesPlugin(P_GIT, "", opts)).toBe(false);
	});

	it("安装筛选：仅已安装时排除未安装插件", () => {
		const opts = baseMatchOpts({
			installFilter: "installed",
			installedIds: new Set([P_CAL.id]),
		});
		expect(matchesPlugin(P_CAL, "", opts)).toBe(true);
		expect(matchesPlugin(P_MIND, "", opts)).toBe(false);
	});

	it("安装筛选：仅已启动时排除未启用插件", () => {
		const opts = baseMatchOpts({
			installFilter: "enabled",
			installedIds: new Set([P_CAL.id, P_MIND.id]),
			enabledIds: new Set([P_CAL.id]),
		});
		expect(matchesPlugin(P_CAL, "", opts)).toBe(true);
		expect(matchesPlugin(P_MIND, "", opts)).toBe(false);
	});

	it("安装筛选：仅已安装未启动时排除未安装或已启用插件", () => {
		const opts = baseMatchOpts({
			installFilter: "installedNotEnabled",
			installedIds: new Set([P_CAL.id, P_MIND.id]),
			enabledIds: new Set([P_CAL.id]),
		});
		expect(matchesPlugin(P_CAL, "", opts)).toBe(false); // 已启用
		expect(matchesPlugin(P_MIND, "", opts)).toBe(true); // 已安装未启用
	});

	it("收藏优先排序不影响 matchesPlugin 成员资格（仅排序阶段置顶）", () => {
		const opts = baseMatchOpts({ sortFavoritesFirst: true, favoritesSet: new Set([P_MIND.id, P_GIT.id]) });
		expect(matchesPlugin(P_MIND, "", opts)).toBe(true);
		expect(matchesPlugin(P_GIT, "", opts)).toBe(true);
		expect(matchesPlugin(P_CAL, "", opts)).toBe(true); // 收藏优先只影响排序，不排除未收藏
	});

	it("分类筛选：选中的分类匹配才保留", () => {
		const tagMap = new Map<string, string>([["enhancing-mindmap", "思维导图"], ["calendar", "日历"]]);
		const opts = baseMatchOpts({ selectedCategories: ["思维导图"], pluginTagMap: tagMap });
		expect(matchesPlugin(P_MIND, "", opts)).toBe(true);
		expect(matchesPlugin(P_CAL, "", opts)).toBe(false);
	});

	it("分类筛选：多选分类取并集", () => {
		const tagMap = new Map<string, string>([["enhancing-mindmap", "思维导图"], ["calendar", "日历"]]);
		const opts = baseMatchOpts({ selectedCategories: ["思维导图", "日历"], pluginTagMap: tagMap });
		expect(matchesPlugin(P_MIND, "", opts)).toBe(true);
		expect(matchesPlugin(P_CAL, "", opts)).toBe(true);
	});

	it("高级语法：排除词过滤", () => {
		// "git -backup" 应排除含 backup 的 obsidian-git
		const opts = baseMatchOpts();
		// 通过 filterAndSortPlugins 触发高级语法路径更直接，这里验证 AST 路径基本可用
		expect(matchesPlugin(P_GIT, "git", opts)).toBe(true);
	});

	it("作者筛选：null 不过滤", () => {
		expect(matchesPlugin(P_MIND, "", baseMatchOpts({ authorFilter: null }))).toBe(true);
		expect(matchesPlugin(P_GIT, "", baseMatchOpts({ authorFilter: null }))).toBe(true);
	});

	it("作者筛选：精确匹配命中该作者，排除其它作者", () => {
		const opts = baseMatchOpts({ authorFilter: "Mark" });
		expect(matchesPlugin(P_MIND, "", opts)).toBe(true); // Mark
		expect(matchesPlugin(P_CAL, "", opts)).toBe(false); // Liam
		expect(matchesPlugin(P_GIT, "", opts)).toBe(false); // Vinzent
	});

	it("作者筛选：与关键词叠加（仅该作者内匹配）", () => {
		const opts = baseMatchOpts({ authorFilter: "Mark" });
		expect(matchesPlugin(P_MIND, "mind", opts)).toBe(true);
		// 其它作者即便命中关键词也被作者维度排除
		expect(matchesPlugin(P_CAL, "mind", opts)).toBe(false);
	});
});

// ── filterAndSortPlugins ──

describe("filterAndSortPlugins", () => {
	it("空查询返回全量（保持来源顺序）", () => {
		const r = filterAndSortPlugins(baseFilterParams());
		expect(r.list.map((p) => p.id)).toEqual([P_MIND.id, P_CAL.id, P_GIT.id]);
	});

	it("收藏优先排序：收藏项前置但不隐藏未收藏（RC-3）", () => {
		const r = filterAndSortPlugins(baseFilterParams({ sortFavoritesFirst: true, favoritesSet: new Set([P_CAL.id]) }));
		// 全部保留，P_CAL 置顶
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id, P_MIND.id, P_GIT.id]);
	});

	it("仅已收藏：只保留 favoritesSet 内的插件", () => {
		const r = filterAndSortPlugins(baseFilterParams({ favoriteFilter: "favorited", favoritesSet: new Set([P_CAL.id]) }));
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id]);
		// 无收藏时返回空列表
		const r2 = filterAndSortPlugins(baseFilterParams({ favoriteFilter: "favorited", favoritesSet: new Set() }));
		expect(r2.list).toHaveLength(0);
	});

	it("仅未收藏：只排除 favoritesSet 内的插件", () => {
		const r = filterAndSortPlugins(baseFilterParams({ favoriteFilter: "unfavorited", favoritesSet: new Set([P_CAL.id]) }));
		expect(r.list.map((p) => p.id).sort()).toEqual([P_GIT.id, P_MIND.id].sort());
		// 全部收藏时返回空列表
		const allIds = new Set(PLUGINS.map((p) => p.id));
		const r2 = filterAndSortPlugins(baseFilterParams({ favoriteFilter: "unfavorited", favoritesSet: allIds }));
		expect(r2.list).toHaveLength(0);
	});

	it("分类筛选：仅返回分类匹配的插件", () => {
		const tagMap = new Map<string, string>([["enhancing-mindmap", "思维导图"], ["calendar", "日历"]]);
		const r = filterAndSortPlugins(baseFilterParams({ selectedCategories: ["日历"], pluginTagMap: tagMap }));
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id]);
	});

	it("关键词过滤", () => {
		const r = filterAndSortPlugins(baseFilterParams({ query: "calendar" }));
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id]);
		expect(r.nextFilterQuery).toBe("calendar");
	});

	it("按下载量排序", () => {
		const r = filterAndSortPlugins(baseFilterParams({ sortBy: "downloads" }));
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id, P_GIT.id, P_MIND.id]);
	});

	it("AI 模式有结果：按 rankedIds 顺序展示", () => {
		const ai: AISearchResult = { rankedIds: [P_GIT.id, P_MIND.id] };
		const r = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "ai",
				query: "备份工具",
				aiSearchResult: ai,
				aiSearchQueryCache: "备份工具",
			})
		);
		expect(r.list.map((p) => p.id)).toEqual([P_GIT.id, P_MIND.id]);
	});

	it("本地语义模式有结果：按 rankedIds（RRF 融合序）展示", () => {
		const local: AISearchResult = { rankedIds: [P_GIT.id, P_MIND.id] };
		const r = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "local",
				query: "备份工具",
				aiSearchResult: local,
				aiSearchQueryCache: "备份工具",
			})
		);
		expect(r.list.map((p) => p.id)).toEqual([P_GIT.id, P_MIND.id]);
	});

	it("AI 模式有结果但 query 已变化：展示为空", () => {
		const ai: AISearchResult = { rankedIds: [P_GIT.id] };
		const r = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "ai",
				query: "新查询",
				aiSearchResult: ai,
				aiSearchQueryCache: "旧查询",
			})
		);
		expect(r.list).toEqual([]);
	});

	it("AI 模式无结果：展示为空（bug #4 回归——不回退全量）", () => {
		const r = filterAndSortPlugins(
			baseFilterParams({ searchMode: "ai", query: "随便", aiSearchResult: null })
		);
		expect(r.list).toEqual([]);
	});

	it("AI 模式应用来源筛选", () => {
		const ai: AISearchResult = { rankedIds: [P_MIND.id, P_CAL.id, P_GIT.id] };
		const r = filterAndSortPlugins(
			baseFilterParams({
			searchMode: "ai",
			query: "工具",
			sourceFilter: "translated",
			aiSearchResult: ai,
				aiSearchQueryCache: "工具",
			})
		);
		expect(r.list.map((p) => p.id).sort()).toEqual([P_MIND.id, P_CAL.id].sort());
	});

	it("前缀增量缓存：query 延伸时复用上次结果集", () => {
		// 上次过滤 "cal" 得到 calendar；本次 "calendar" 是其延伸，应在子集上二次过滤
		const r = filterAndSortPlugins(
			baseFilterParams({
				query: "calendar",
				lastFiltered: [P_CAL],
				lastFilterQuery: "cal",
				lastFilterSource: "all",
			})
		);
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id]);
	});

	it("前缀缓存：来源筛选变化时不复用（全量重滤）", () => {
		const r = filterAndSortPlugins(
			baseFilterParams({
				query: "",
				sourceFilter: "translated",
				lastFiltered: [P_CAL],
				lastFilterQuery: "",
				lastFilterSource: "all", // 与当前 translated 不同 → 不复用
			})
		);
		// 全量按 translated 过滤 → 命中思维导图 + 日历
		expect(r.list.map((p) => p.id).sort()).toEqual([P_CAL.id, P_MIND.id].sort());
	});

	it("前缀缓存：installFilter 变化时不复用缓存（切回「全部」恢复全集）", () => {
		// 复现 bug：上次是「仅已安装」，缓存里只有已安装子集；本次切回「全部」
		const r = filterAndSortPlugins(
			baseFilterParams({
				query: "",
				installFilter: "all", // 当前切回全部
				installedIds: new Set([P_CAL.id]),
				lastFiltered: [P_CAL], // 缓存里只有已安装子集
				lastFilterQuery: "",
				lastFilterSource: "all",
				lastFilterInstall: "installed", // 上次是仅已安装
			})
		);
		// 必须恢复全部三个插件，而非停留在已安装子集
		expect(r.list.map((p) => p.id).sort()).toEqual([P_MIND.id, P_CAL.id, P_GIT.id].sort());
	});

	it("前缀缓存：recommendedOnly 变化时不复用缓存", () => {
		const r = filterAndSortPlugins(
			baseFilterParams({
				query: "",
				recommendedOnly: true,
				recommendedSet: new Set([P_MIND.id]),
				lastFiltered: [P_CAL],
				lastFilterQuery: "",
				lastFilterSource: "all",
				lastFilterRecommendedOnly: false, // 上次不是推荐
			})
		);
		// 必须全量重滤（cache 失效）→ 仅推荐集内的 P_MIND；而非停留在子集 [P_CAL]
		expect(r.list.map((p) => p.id)).toEqual([P_MIND.id]);
	});

	it("前缀缓存：仅已收藏关闭时必须恢复全部（缓存失效）", () => {
		// 复现 bug：上次开启「仅已收藏」，缓存里只有收藏子集；本次关闭仅已收藏
		const r = filterAndSortPlugins(
			baseFilterParams({
				query: "",
				favoriteFilter: "all", // 当前关闭仅已收藏
				favoritesSet: new Set([P_CAL.id]),
				lastFiltered: [P_CAL], // 缓存里只有收藏子集
				lastFilterQuery: "",
				lastFilterSource: "all",
				lastFilterFavorites: "favorited", // 上次是仅已收藏
			})
		);
		// 必须恢复全部三个插件，而非停留在收藏子集
		expect(r.list.map((p) => p.id).sort()).toEqual([P_MIND.id, P_CAL.id, P_GIT.id].sort());
	});

	it("H1 回归：AI 召回子集不污染关键词前缀缓存（切回关键词必须全量重滤）", () => {
		// 第一步：AI 模式搜索 "map"，只召回 calendar → 回写缓存
		const ai: AISearchResult = { rankedIds: [P_CAL.id] };
		const r1 = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "ai",
				query: "map",
				aiSearchResult: ai,
				aiSearchQueryCache: "map",
			})
		);
		expect(r1.list.map((p) => p.id)).toEqual([P_CAL.id]);
		expect(r1.nextFilterMode).toBe("ai");

		// 第二步：切回关键词模式，query 仍为 "map"（startsWith 成立）。
		// 若误复用 AI 子集 [P_CAL]，"map" 在 calendar blob 中不命中 → 结果为空；
		// 正确行为：全量重滤 → P_MIND（"mind map"）命中。
		const r2 = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "keyword",
				query: "map",
				lastFiltered: r1.nextFiltered,
				lastFilterQuery: r1.nextFilterQuery,
				lastFilterSource: r1.nextFilterSource as SourceFilter,
				lastFilterAuthor: r1.nextFilterAuthor,
				lastFilterInstall: r1.nextFilterInstall,
				lastFilterRecommendedOnly: r1.nextFilterRecommendedOnly,
				lastFilterCategories: r1.nextFilterCategories,
				lastFilterMode: r1.nextFilterMode,
			})
		);
		expect(r2.list.map((p) => p.id)).toContain(P_MIND.id);
		expect(r2.nextFilterMode).toBe("keyword");
	});

	it("H1 回归：关键词→关键词前缀复用仍然生效（不误伤缓存优化）", () => {
		const r1 = filterAndSortPlugins(
			baseFilterParams({ searchMode: "keyword", query: "mind" })
		);
		const r2 = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "keyword",
				query: "mind map",
				lastFiltered: r1.nextFiltered,
				lastFilterQuery: r1.nextFilterQuery,
				lastFilterSource: r1.nextFilterSource as SourceFilter,
				lastFilterAuthor: r1.nextFilterAuthor,
				lastFilterMode: r1.nextFilterMode,
			})
		);
		expect(r2.list.map((p) => p.id)).toEqual([P_MIND.id]);
	});

	it("非 AI 路径清空残留 AI 结果（clearAiResult=true）", () => {
		const ai: AISearchResult = { rankedIds: [P_GIT.id] };
		const r = filterAndSortPlugins(
			baseFilterParams({ searchMode: "keyword", query: "calendar", aiSearchResult: ai })
		);
		expect(r.clearAiResult).toBe(true);
	});

	it("AI 路径不清空 AI 结果", () => {
		const ai: AISearchResult = { rankedIds: [P_GIT.id] };
		const r = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "ai",
				query: "git",
				aiSearchResult: ai,
				aiSearchQueryCache: "git",
			})
		);
		expect(r.clearAiResult).toBe(false);
	});

	it("nextFiltered 记录排序前的过滤结果", () => {
		const r = filterAndSortPlugins(
			baseFilterParams({ sortBy: "downloads", query: "" })
		);
		// list 已排序（cal,git,mind），但 nextFiltered 保持过滤序（mind,cal,git）
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id, P_GIT.id, P_MIND.id]);
		expect(r.nextFiltered.map((p) => p.id)).toEqual([P_MIND.id, P_CAL.id, P_GIT.id]);
	});

	it("作者筛选：按 authorFilter 收窄结果集", () => {
		const r = filterAndSortPlugins(baseFilterParams({ authorFilter: "Mark" }));
		expect(r.list.map((p) => p.id)).toEqual([P_MIND.id]);
	});

	it("作者筛选：与 AI 结果叠加（在 AI 推荐集内再按作者收窄）", () => {
		const ai: AISearchResult = { rankedIds: [P_MIND.id, P_CAL.id, P_GIT.id] };
		const r = filterAndSortPlugins(
			baseFilterParams({
				searchMode: "ai",
				query: "工具",
				authorFilter: "Liam",
				aiSearchResult: ai,
				aiSearchQueryCache: "工具",
			})
		);
		expect(r.list.map((p) => p.id)).toEqual([P_CAL.id]);
	});
});

// ── resolveEmptyState ──

describe("resolveEmptyState", () => {
	it("无查询：暂无数据文案", () => {
		const s = resolveEmptyState({
			hasQuery: false,
			searchMode: "keyword",
			aiSearchResult: null,
			sourceFilter: "all",
			installFilter: "all",
			hasAIKey: false,
		});
		expect(s.titleKey).toBe("empty.noData");
		expect(s.hintKey).toBe("empty.noData.filter");
	});

	it("AI 模式无结果：等待 Enter 文案", () => {
		const s = resolveEmptyState({
			hasQuery: true,
			searchMode: "ai",
			aiSearchResult: null,
			sourceFilter: "all",
			installFilter: "all",
			hasAIKey: false,
		});
		expect(s.titleKey).toBe("ai.pending.title");
		expect(s.hintKey).toBe("empty.ai.hint");
	});

	it("AI 模式有结果但无匹配：无匹配文案", () => {
		const s = resolveEmptyState({
			hasQuery: true,
			searchMode: "ai",
			aiSearchResult: { rankedIds: [] },
			sourceFilter: "all",
			installFilter: "all",
			hasAIKey: false,
		});
		expect(s.titleKey).toBe("empty.noMatch");
	});

	it("关键词有查询无匹配：无匹配文案", () => {
		const s = resolveEmptyState({
			hasQuery: true,
			searchMode: "keyword",
			aiSearchResult: null,
			sourceFilter: "all",
			installFilter: "all",
			hasAIKey: false,
		});
		expect(s.titleKey).toBe("empty.noMatch");
		expect(s.hintKey).toBe("empty.clearFilter");
	});

	describe("showClearAction（bug #3 回归）", () => {
		const base: EmptyStateInput = {
			hasQuery: false,
			searchMode: "keyword" as SearchMode,
			aiSearchResult: null,
			sourceFilter: "all" as SourceFilter,
			installFilter: "all" as InstallFilter,
			hasAIKey: false,
		};

		it("无任何筛选时不显示清除按钮", () => {
			expect(resolveEmptyState(base).showClearAction).toBe(false);
		});

		it("有查询时显示", () => {
			expect(resolveEmptyState({ ...base, hasQuery: true }).showClearAction).toBe(true);
		});

		it("来源筛选生效时显示", () => {
			expect(resolveEmptyState({ ...base, sourceFilter: "translated" }).showClearAction).toBe(true);
		});

		it("「已安装」生效时显示（installFilter === installed）", () => {
			expect(resolveEmptyState({ ...base, installFilter: "installed" }).showClearAction).toBe(true);
		});

		it("installFilter 为 all 时不因该条件显示（锁死曾写反的 !== 逻辑）", () => {
			// 若误写为 installFilter !== "installed"，此用例（installFilter=all）会错误返回 true
			expect(resolveEmptyState({ ...base, installFilter: "all" }).showClearAction).toBe(false);
		});
	});
});

describe("FilterCache", () => {
	it("sync 后 snapshot 返回一致的字段", () => {
		const cache = new FilterCache();
		const result: Partial<FilterResult> = {
			list: PLUGINS,
			nextFiltered: PLUGINS,
			nextFilterQuery: "mind",
			nextFilterSource: "translated",
			nextFilterAuthor: "Mark",
			nextFilterInstall: "installed",
			nextFilterRecommendedOnly: true,
			nextFilterCategories: ["productivity"],
			clearAiResult: false,
		};
		cache.sync(result as FilterResult);
		const snap = cache.snapshot();
		expect(snap.lastFilterMode).toBe("keyword"); // 未提供 nextFilterMode 默认回 keyword
		expect(snap.lastFiltered).toBe(PLUGINS);
		expect(snap.lastFilterQuery).toBe("mind");
		expect(snap.lastFilterSource).toBe("translated");
		expect(snap.lastFilterAuthor).toBe("Mark");
		expect(snap.lastFilterInstall).toBe("installed");
		expect(snap.lastFilterRecommendedOnly).toBe(true);
		expect(snap.lastFilterCategories).toEqual(["productivity"]);
	});

	it("reset 后 snapshot 返回默认值", () => {
		const cache = new FilterCache();
		cache.sync({
			list: PLUGINS,
			nextFiltered: PLUGINS,
			nextFilterQuery: "x",
			nextFilterSource: "translated",
			nextFilterAuthor: "A",
			nextFilterInstall: "installed",
			nextFilterRecommendedOnly: true,
			nextFilterCategories: ["b"],
			nextFilterMode: "ai",
			clearAiResult: false,
		});
		cache.reset();
		const snap = cache.snapshot();
		expect(snap.lastFilterMode).toBe("keyword");
		expect(snap.lastFiltered).toEqual([]);
		expect(snap.lastFilterQuery).toBe("");
		expect(snap.lastFilterSource).toBe("all");
		expect(snap.lastFilterAuthor).toBeNull();
		expect(snap.lastFilterInstall).toBe("all");
		expect(snap.lastFilterRecommendedOnly).toBe(false);
		expect(snap.lastFilterCategories).toBeUndefined();
	});

	it("多次 sync 覆盖旧值", () => {
		const cache = new FilterCache();
		cache.sync({
			list: PLUGINS,
			nextFiltered: PLUGINS,
			nextFilterQuery: "a",
			nextFilterSource: "all",
			nextFilterAuthor: null,
			nextFilterInstall: "all",
			clearAiResult: false,
		} as FilterResult);
		expect(cache.snapshot().lastFilterQuery).toBe("a");

		cache.sync({
			list: [],
			nextFiltered: [],
			nextFilterQuery: "b",
			nextFilterSource: "translated",
			nextFilterAuthor: "B",
			nextFilterInstall: "installed",
			nextFilterMode: "keyword",
			clearAiResult: true,
		} as FilterResult);
		expect(cache.snapshot().lastFilterQuery).toBe("b");
		expect(cache.snapshot().lastFilterAuthor).toBe("B");
	});
});

/**
 * AI 语义搜索编排（P2-1 God file 拆分：从 view-data.ts 抽出）。
 *
 * 仅负责「AI 搜索」这一交互闭环：读取搜索词/配置 → 调 translator.aiSearch 拉取语义排序 →
 * 写回 ctx.aiSearchResult（含最近一次结果缓存供切回 AI 模式复用）→ 更新 badge 状态/提示 →
 * 落盘向量索引（非 keyword 嵌入时）。数据获取/合并/分面等其余职责仍留在 view-data.ts，
 * 实现「数据获取」与「AI 搜索」的关注点分离。
 */

import { Notice } from "obsidian";
import { logger } from "./logger";
import type { ViewContext } from "./view-context";

/** 根据 Base URL 判断是否国内模型（直连可达，无需 VPN） */
function isCnModelBaseUrl(base: string): boolean {
	return /siliconflow|deepseek|aliyun|dashscope|volcengine|moonshot|zhipu|baidu|tencent|chatglm|qwen|kimi|163\.com|baike/i.test(
		(base || "").toLowerCase()
	);
}

export async function runAISearch(
	ctx: ViewContext,
	searchInput: HTMLInputElement,
	aiBadge: HTMLElement
) {
	if (ctx.aiSearchPending) return;
	const query = ctx.searchQuery.trim();
	if (!query) return;

	const settings = ctx.settings;
	const isLocal = ctx.searchMode === "local";
	const tStart = Date.now();

	if (!isLocal) {
		// AI 模式：需开启 + API Key
		if (!settings.aiSearchEnabled) {
			ctx.showAIConfigGuide("disabled");
			return;
		}
		if (!settings.aiSearchApiKey) {
			ctx.showAIConfigGuide("noKey");
			return;
		}
	}
	// 产品定位：搜索也走懒加载——首次触发时先拉数据+翻译。
	if (ctx.plugins.length === 0) {
		const ok = await ctx.ensureDataLoaded();
		if (!ok) {
			new Notice(ctx.t("notice.ai.loadFail"));
			return;
		}
	}
	logger.debug(`[Chinese Plugin Market] 搜索耗时：数据就绪检查+加载=${Date.now() - tStart}ms（plugins=${ctx.plugins.length}）`);

	ctx.aiSearchPending = true;
	ctx.aiSearchQueryCache = query;
	aiBadge.className = "pt-ai-badge pt-ai-active";
	aiBadge.setText(isLocal ? "本地检索中" : "AI 分析中");
	aiBadge.setAttribute("title", isLocal ? "本地语义检索中..." : "AI 正在分析排序...");
	searchInput.addClass("ai-loading");

	try {
		const pluginArgs = ctx.plugins.map((p) => ({
			id: p.id,
			name: p.name,
			description: p.description,
		}));
		const config = {
			baseURL: settings.aiSearchBaseURL,
			apiKey: settings.aiSearchApiKey,
			model: settings.aiSearchModel,
			embedding: {
				source: settings.embeddingSource,
				baseURL: settings.embeddingBaseURL,
				apiKey: settings.embeddingApiKey,
				model: settings.embeddingModel,
				localModel: settings.embeddingLocalModel,
				localWasmPaths: settings.embeddingLocalWasmPaths,
			},
		};
		const cats = ctx.selectedCategories.length ? ctx.selectedCategories : undefined;

		// 本地语义：若索引尚未构建，先提示（首次会后台下载模型+建索引，可能耗时）
		if (isLocal && !ctx.translator.getVectorIndex()) {
			new Notice(ctx.t("notice.local.indexing"), 6000);
		}

		const tSearch = Date.now();
		const aiResult = isLocal
			? await ctx.translator.aiSearchLocal(query, pluginArgs, config, cats)
			: await ctx.translator.aiSearch(
					query,
					pluginArgs,
					config,
					settings.aiSearchShowReason,
					(phase: string, detail: string) => {
						aiBadge.setAttribute("title", `AI ${phase}：${detail}`);
					},
					cats
			  );
		logger.debug(`[Chinese Plugin Market] 搜索耗时：语义搜索=${Date.now() - tSearch}ms · 总=${Date.now() - tStart}ms · 结果=${aiResult.rankedIds.length}`);

		ctx.aiSearchResult = aiResult;
		ctx.aiSearchQueryCache = ctx.searchQuery.trim();
		// 3a: 记录最近一次结果，供切回语义模式时复用
		ctx.lastAiSearchResult = aiResult;
		ctx.lastAiSearchQuery = ctx.aiSearchQueryCache;
		aiBadge.className = "pt-ai-badge pt-ai-done";
		aiBadge.setText(isLocal ? "本地" : "AI");

		if (isLocal) {
			// 本地语义：纯 RRF 融合排序，不做 LLM
			aiBadge.setAttribute("title", "本地语义检索完成");
			new Notice(
				`本地语义搜索「${query}」返回 ${aiResult.rankedIds.length} 个相关结果（离线，未用 LLM）`,
				5000
			);
		} else if (aiResult.rankFallback) {
			aiBadge.setAttribute(
				"title",
				"AI 精排暂不可用，已用本地相关度排序（LLM 服务超时或不可用）"
			);
			const hint = isCnModelBaseUrl(settings.aiSearchBaseURL)
				? ctx.t("notice.ai.fail.cn")
				: ctx.t("notice.ai.fail.oversea");
			new Notice(
				`AI 精排暂不可用，已用本地相关度排序「${query}」${aiResult.rankedIds.length} 个结果。\n${hint}`,
				7000
			);
		} else {
			aiBadge.setAttribute("title", "AI 已重新排序");
			new Notice(
				`${ctx.t("notice.ai.done")}「${query}」${ctx.t("notice.translated")} ${aiResult.rankedIds.length}`
			);
		}

		// 向量索引已构建/更新，落盘以便跨会话复用（keyword 模式无需保存）
		if (settings.embeddingSource !== "keyword") {
			void ctx.saveVectorIndex();
		}
	} catch (err: unknown) {
		ctx.aiSearchResult = null;
		aiBadge.className = "pt-ai-badge pt-ai-ready";
		aiBadge.setAttribute("title", isLocal ? "本地语义失败" : "AI 排序失败，已使用常规搜索");
		const hint = isLocal
			? ctx.t("notice.ai.localFail")
			: isCnModelBaseUrl(settings.aiSearchBaseURL)
				? ctx.t("notice.ai.fail.cn")
				: ctx.t("notice.ai.fail.oversea");
		new Notice(`${isLocal ? ctx.t("notice.ai.localFail") : ctx.t("notice.ai.fail")}：${(err as Error).message}）\n${hint}`, 9000);
	} finally {
		ctx.aiSearchPending = false;
		searchInput.removeClass("ai-loading");
		ctx.renderPluginList();
	}
}

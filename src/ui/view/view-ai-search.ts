/**
 * AI 语义搜索编排（P2-1 God file 拆分：从 view-data.ts 抽出）。
 *
 * 仅负责「AI 搜索」这一交互闭环：读取搜索词/配置 → 调 translator.aiSearch 拉取语义排序 →
 * 写回 ctx.aiSearchResult（含最近一次结果缓存供切回 AI 模式复用）→ 更新 badge 状态/提示 →
 * 落盘向量索引（非 keyword 嵌入时）。数据获取/合并/分面等其余职责仍留在 view-data.ts，
 * 实现「数据获取」与「AI 搜索」的关注点分离。
 */

import { Notice } from "obsidian";
import { logger } from "@shared/logger";
import { isAISearchUsable } from "@shared/utils";
import { prepareSearchPlugins } from "@domain/search/search-plugins";
import { beginAISearch, isCurrentSearch, captureSearchData, cacheAISearch, finishAISearch } from "@ui/view/view-search-state";
import { reportQuerySample } from "@domain/search/query-sampling";
import type { ViewContext } from "@ui/view/view-context";

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
	if (ctx.disposed) return;
	const query = ctx.searchQuery.trim().toLowerCase();
	if (!query) return;

	const settings = { ...ctx.settings };
	const isLocal = ctx.searchMode === "local";
	const tStart = Date.now();

	if (!isLocal) {
		// AI 模式：需开启 + 鉴权就绪（本地模型无 Key 亦可用）
		if (!settings.aiSearchEnabled) {
			ctx.showAIConfigGuide("disabled");
			return;
		}
		if (!isAISearchUsable(true, settings.aiSearchBaseURL, settings.aiSearchApiKey)) {
			ctx.showAIConfigGuide("noKey");
			return;
		}
	}
	const request = beginAISearch(ctx);
	if (!request) return;
	const cats = ctx.selectedCategories.length ? [...ctx.selectedCategories] : undefined;
	// 确保 badge 在搜索进行中可见（本地模式默认 badge 常驻，但此处兜底重置 display，
	// 避免任何路径下 loading 态被隐藏导致「看似无反应」）
	aiBadge.setCssStyles({ display: "" });
	aiBadge.className = "pt-ai-badge pt-ai-active";
	aiBadge.setText(isLocal ? "本地检索中" : "AI 分析中");
	aiBadge.setAttribute("title", isLocal ? "本地语义检索中..." : "AI 正在分析排序...");
	searchInput.addClass("ai-loading");
	searchInput.closest?.(".pt-search")?.addClass("pt-search--ai-loading");

	// 首次本地语义搜索的模型下载进度条（与设置页同款）。声明在 try 外，供 finally 清理。
	let modelBar: { el: HTMLElement } | null = null;
	let modelBarTimer = 0;
	request.cleanup = (cancelled) => {
		if (modelBarTimer) window.clearInterval(modelBarTimer);
		modelBar?.el.remove();
		searchInput.removeClass("ai-loading");
		searchInput.closest?.(".pt-search")?.removeClass("pt-search--ai-loading");
		if (cancelled && !ctx.disposed) {
			aiBadge.className = "pt-ai-badge pt-ai-ready";
			aiBadge.setText(isLocal ? "本地" : "AI");
			aiBadge.setAttribute("title", "按 Enter 重新检索");
		}
	};

	try {
		// pending 在首个 await 前登记，首次加载期间重复 Enter 也只执行一次。
		if (ctx.plugins.length === 0) {
			const ok = await ctx.ensureDataLoaded();
			if (!isCurrentSearch(ctx, request)) return;
			if (!ok) {
				new Notice(ctx.t("notice.ai.loadFail"));
				return;
			}
		}
		if (!isCurrentSearch(ctx, request)) return;
		logger.debug(`[Chinese Plugin Market] 搜索耗时：数据就绪检查+加载=${Date.now() - tStart}ms（plugins=${ctx.plugins.length}）`);
		const pluginArgs = prepareSearchPlugins(ctx.plugins, ctx.translator.cache);
		captureSearchData(ctx, request, pluginArgs);
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
				localRemoteHost: settings.embeddingRemoteHost,
			},
		};

		// 本地语义：若索引尚未构建，先提示（首次会后台下载量化模型权重（e5-small q8 ~118MB，可配镜像加速）+ 建索引，可能耗时）
		if (isLocal && !ctx.translator.getVectorIndex()) {
			new Notice(ctx.t("notice.local.indexing"), 8000);
		}

		// 首次本地语义搜索：worker 会后台下载量化模型权重（~23MB）。挂载与设置页同款的
		// <progress> 进度条 + 百分比，轮询 plugin.localModelState 实时展示下载进度，
		// 避免「看似无反应」（此前仅有 8s Notice，下载慢时无任何进度反馈）。
		// 模型已就绪（status==="ready" 或本地模型此前预热过）则不显示进度条。
		modelBar = isLocal && ctx.plugin.localModelState.status !== "ready"
			? mountLocalModelProgressBar(searchInput)
			: null;
		modelBarTimer = modelBar
			? window.setInterval(() => {
				if (isCurrentSearch(ctx, request)) updateLocalModelProgressBar(modelBar!, ctx.plugin.localModelState, aiBadge);
			}, 150)
			: 0;

		// 本地索引统一由插件级构建任务维护。没有任何索引时先等待首个完整构建，
		// 避免 AISearcher 在同一批数据上再启动一轮独立 embed；已有 partial 时不再
		// 等整库构建结束，直接用当前已完成向量 + 关键词召回，避免进度条增长期间搜索看似卡死。
		// API embedding 不走这条后台本地索引路径。
		const currentVectorIndex = ctx.translator.getVectorIndex?.();
		if (
			settings.embeddingSource === "local" &&
			(!currentVectorIndex || (!currentVectorIndex.partial && currentVectorIndex.ids.length !== ctx.plugins.length))
		) {
			await ctx.buildLocalIndex(false);
		}

		if (!isCurrentSearch(ctx, request, true)) return;
		const tSearch = Date.now();
		const aiResult = isLocal
			? await ctx.translator.aiSearchLocal(query, pluginArgs, config, cats)
			: await ctx.translator.aiSearch(
					query,
					pluginArgs,
					config,
					settings.aiSearchShowReason,
					(phase: string, detail: string) => {
						if (isCurrentSearch(ctx, request)) aiBadge.setAttribute("title", `AI ${phase}：${detail}`);
					},
					cats
			  );
		logger.debug(`[Chinese Plugin Market] 搜索耗时：语义搜索=${Date.now() - tSearch}ms · 总=${Date.now() - tStart}ms · 结果=${aiResult.rankedIds.length}`);

		if (!isCurrentSearch(ctx, request, true)) return;
		ctx.aiSearchResult = aiResult;
		ctx.aiSearchQueryCache = query;
		// P1.1：只发送脱敏后的查询形状与排序指标；reportQuerySample 默认关闭，
		// 且内部不会接收 allPlugins，因此不会把插件全文或 ID 带出客户端。
		void reportQuerySample(
			{
				enabled: settings.querySamplingEnabled,
				endpoint: settings.querySamplingEndpoint,
				sampleRate: settings.querySamplingRate,
			},
			{
				query,
				mode: isLocal ? "local" : "ai",
				result: aiResult,
				clientVersion: ctx.manifest?.version,
			},
		);
		// 3a: 记录最近一次结果，供切回语义模式时复用
		cacheAISearch(ctx, request, aiResult);
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
		if (!isCurrentSearch(ctx, request, true)) return;
		ctx.aiSearchResult = null;
		aiBadge.className = "pt-ai-badge pt-ai-ready";
		const errMsg = err instanceof Error ? err.message : String(err);
		aiBadge.setAttribute("title", isLocal ? "本地语义失败" : "AI 排序失败，已使用常规搜索");
		let detail: string;
		if (errMsg === "NO_API_KEY") {
			// 极少见：进入搜索时前置门禁已放行，此处捕获说明配置时序异常（如本地模型未启 API Key）。
			detail = isLocal
				? "本地模型未配置 API Key 且未识别为本地地址，请确认 Base URL 指向本机（localhost/127.0.0.1）"
				: "未配置 API Key，请在设置中填写 AI 搜索的 API Key（本地模型可留空）";
		} else {
			const hint = isLocal
				? ctx.t("notice.ai.localFail")
				: isCnModelBaseUrl(settings.aiSearchBaseURL)
					? ctx.t("notice.ai.fail.cn")
					: ctx.t("notice.ai.fail.oversea");
			detail = `${isLocal ? ctx.t("notice.ai.localFail") : ctx.t("notice.ai.fail")}${errMsg}）\n${hint}`;
		}
		new Notice(detail, 9000);
	} finally {
		if (finishAISearch(ctx, request)) ctx.renderPluginList();
	}
}

/**
 * 在搜索框下缘挂载本地模型下载进度细条（原生 <progress>，绝对定位覆盖层）。
 * 返回 { el } 供轮询更新；组件本身随 runAISearch 的 finally 一并移除。
 * 不作为 .pt-search-field 的普通 flex 子项存在——否则会被 width:100% 的输入框
 * 挤成 0 宽、内容向右溢出，与「找到 N 个」计数和 AI 徽章三层重叠。
 */
function mountLocalModelProgressBar(searchInput: HTMLInputElement): { el: HTMLElement } | null {
	const field = searchInput.closest?.(".pt-search-field");
	if (!field) return null;
	const wrap = field.createDiv({ cls: "pt-model-progress" });
	const bar = wrap.createEl("progress", { cls: "pt-index-progress" });
	bar.max = 100;
	bar.value = 0;
	return { el: wrap };
}

/** 轮询回调：根据 plugin.localModelState 更新进度条可见性与百分比（经 AI 徽章单一出口）。 */
function updateLocalModelProgressBar(
	bar: { el: HTMLElement },
	st: { status: "idle" | "downloading" | "ready" | "error"; loaded: number; total: number },
	aiBadge: HTMLElement
): void {
	const progress = bar.el.querySelector("progress");
	if (!progress) return;
	if (st.status === "downloading" && st.total > 0) {
		const p = Math.round((st.loaded / st.total) * 100);
		progress.value = p;
		bar.el.addClass("is-active");
		// 百分比并入 AI 徽章文案：状态只有徽章一处出口，避免徽章与独立进度文案双份重叠
		aiBadge.setText(`下载模型中 ${p}%`);
		aiBadge.setAttribute("title", `正在下载本地模型（${p}%）…`);
	} else {
		// 下载完成（ready）/出错/空闲：隐藏进度条（badge 由 runAISearch 主流程接管文案）
		bar.el.removeClass("is-active");
	}
}

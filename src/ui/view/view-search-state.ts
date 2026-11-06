import type { AISearchResult } from "@domain/catalog/translator";
import { prepareSearchPlugins } from "@domain/search/search-plugins";
import { computeIndexFingerprints } from "@shared/fingerprint";
import type { ViewContext } from "@ui/view/view-context";

export interface SearchRequest {
	inputKey: string;
	dataKey?: string;
	cleanup?: (cancelled: boolean) => void;
}

interface SearchState {
	active?: SearchRequest;
	cache?: { inputKey: string; dataKey: string; result: AISearchResult };
	/** 认证变化只在内存中比较；缓存键只携带版本号，不包含密钥或其摘要。 */
	credentials?: readonly [string, string];
	authRevision: number;
}

const states = new WeakMap<ViewContext, SearchState>();

function stateOf(ctx: ViewContext): SearchState {
	let state = states.get(ctx);
	if (!state) {
		state = { authRevision: 0 };
		states.set(ctx, state);
	}
	return state;
}

function inputKey(ctx: ViewContext): string {
	const s = ctx.settings;
	const state = stateOf(ctx);
	const credentials = [s.aiSearchApiKey ?? "", s.embeddingApiKey ?? ""] as const;
	if (!state.credentials || credentials.some((key, i) => key !== state.credentials![i])) {
		state.credentials = credentials;
		state.authRevision++;
	}
	return JSON.stringify([
		ctx.searchMode, ctx.searchQuery.trim().toLowerCase(), [...new Set(ctx.selectedCategories)].sort(),
		s.aiSearchEnabled, s.aiSearchBaseURL, s.aiSearchModel, s.aiSearchShowReason,
		s.embeddingSource, s.embeddingBaseURL, s.embeddingModel, s.embeddingLocalModel,
		s.embeddingLocalWasmPaths, s.embeddingRemoteHost, state.authRevision,
	]);
}

function dataKey(ctx: ViewContext, plugins = prepareSearchPlugins(ctx.plugins, ctx.translator.cache)): string {
	const fingerprint = computeIndexFingerprints(plugins, (p) => ctx.translator.pluginTags?.[p.id]);
	// 排序也消费下载量/更新时间；原地更新这些字段同样必须使结果缓存失效。
	let quality = 5381;
	for (const p of plugins) {
		const text = String(p.downloads ?? "") + "/" + String(p.updated ?? "") + ";";
		for (let i = 0; i < text.length; i++) quality = (quality * 33 + text.charCodeAt(i)) | 0;
	}
	return JSON.stringify([ctx.pluginsRev, fingerprint.fields, quality, ctx.translator.tagService?.getSchemaVersion()]);
}

/** 逻辑取消立即释放本视图的 loading；旧请求的 catch/finally 此后不再拥有视图状态。 */
export function invalidateAISearch(ctx: ViewContext): void {
	const state = states.get(ctx);
	if (state?.active) {
		const active = state.active;
		state.active = undefined;
		active.cleanup?.(true);
	}
	ctx.aiSearchPending = false;
	ctx.aiSearchResult = null;
	ctx.aiSearchQueryCache = "";
}

export function isCurrentSearch(ctx: ViewContext, request: SearchRequest, checkData = false): boolean {
	return !ctx.disposed && states.get(ctx)?.active === request && inputKey(ctx) === request.inputKey &&
		(!checkData || request.dataKey === undefined || request.dataKey === dataKey(ctx));
}

export function beginAISearch(ctx: ViewContext): SearchRequest | null {
	if (ctx.disposed) return null;
	const state = stateOf(ctx);
	if (state.active && isCurrentSearch(ctx, state.active, true)) return null;
	// 兼容外层已有的 pending 门禁，正常请求的所有权由 active 表示。
	if (ctx.aiSearchPending && !state.active) return null;
	invalidateAISearch(ctx);
	const request: SearchRequest = { inputKey: inputKey(ctx) };
	state.active = request;
	ctx.aiSearchPending = true;
	return request;
}

export function captureSearchData(
	ctx: ViewContext, request: SearchRequest, plugins: ReturnType<typeof prepareSearchPlugins>,
): void {
	request.dataKey = dataKey(ctx, plugins);
}

export function cacheAISearch(ctx: ViewContext, request: SearchRequest, result: AISearchResult): void {
	if (!isCurrentSearch(ctx, request, true) || request.dataKey === undefined) return;
	stateOf(ctx).cache = { inputKey: request.inputKey, dataKey: request.dataKey, result };
}

/** 模式、分类、配置、数据及译文均相同时，才允许跨界面操作复用结果。 */
export function restoreAISearch(ctx: ViewContext): boolean {
	const cache = states.get(ctx)?.cache;
	if (!cache || ctx.disposed || !ctx.searchQuery.trim() || cache.inputKey !== inputKey(ctx) || cache.dataKey !== dataKey(ctx)) return false;
	ctx.aiSearchResult = cache.result;
	ctx.aiSearchQueryCache = ctx.searchQuery.trim().toLowerCase();
	return true;
}

export function finishAISearch(ctx: ViewContext, request: SearchRequest): boolean {
	if (states.get(ctx)?.active !== request) return false;
	const current = isCurrentSearch(ctx, request, true);
	stateOf(ctx).active = undefined;
	ctx.aiSearchPending = false;
	request.cleanup?.(!current);
	return current;
}

/** 数据/配置后台变化后，列表渲染也不能消费已经过期的语义结果。 */
export function validateAISearchResult(ctx: ViewContext): void {
	if (!ctx.aiSearchResult) return;
	const state = states.get(ctx);
	if (state?.cache?.result === ctx.aiSearchResult && !restoreAISearch(ctx)) invalidateAISearch(ctx);
}

export function disposeAISearch(ctx: ViewContext): void {
	invalidateAISearch(ctx);
	states.delete(ctx);
}

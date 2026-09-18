/**
 * 评测 harness 的打包入口：把生产搜索原语导出给 node 侧 run-eval.mjs 使用。
 * 只导出纯函数/类，不触发任何网络与 worker（transformers/obsidian/worker 在打包时走 e2e 桩）。
 */
export { AISearcher } from "@domain/search/ai";
export { LLMClient } from "@translation/api/api";
export { PluginTagService } from "@domain/catalog/plugin-tags";
export { fuzzyTitleScores, rrfFuse, topNFused } from "@shared/utils";
export { applyQualityFactors } from "@domain/search/quality";
export { tokenizeForBM25, bm25Score } from "@domain/search/bm25";
export { t2sForEmbed } from "@translation/lexicon/t2s";
export { expandQuery } from "@translation/lexicon/synonyms";

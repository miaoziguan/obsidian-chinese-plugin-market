/**
 * 统一插件视图模型（战略建议 ④）
 *
 * 所有消费方（列表/卡片/对比/详情/推荐）统一从此模型读取，
 * 消除各处分散的 `translatedResults[id]?.translatedName ?? p.name` 模式。
 *
 * 模型在 filter + translate 之后一次构建，各视图引用复用，
 * 确保中英文名称、翻译来源、分类标签在所有展示位置一致。
 */

import type { PluginInfo, TranslateResult } from "./translator";
import type { PluginTag } from "./plugin-tags";

/** 视图层统一数据模型：一次构建，多视图复用 */
export interface PluginViewModel {
	/** 插件 id */
	id: string;
	/** 展示名称（中文优先 → 英文原文兜底） */
	name: string;
	/** 原始英文名（导出/对比引用时使用） */
	nameEn: string;
	/** 展示描述（中文优先 → 英文原文兜底） */
	desc: string;
	/** 翻译来源 */
	translationSource: TranslateResult["source"];
	/** 原始 PluginInfo（含 downloads / author / updated / repo 等元数据） */
	info: PluginInfo;
	/** 功能分类标签（来自 plugin-tags 离线索引） */
	tag: PluginTag | null;
}

/**
 * 从原始数据构建统一视图模型列表。
 *
 * @param plugins  已过滤的原始插件列表
 * @param results  翻译缓存（Translator.translatedResults）
 * @param getTag   标签查询回调（通常为 translator.getPluginTag.bind(translator)）
 */
export function buildPluginViewModels(
	plugins: PluginInfo[],
	results: Record<string, TranslateResult>,
	getTag: (id: string) => PluginTag | null,
): PluginViewModel[] {
	return plugins.map((p) => {
		const r = results[p.id];
		return {
			id: p.id,
			name: r?.translatedName || p.name,
			nameEn: p.name,
			desc: r?.translatedDesc || p.description,
			translationSource: r?.source ?? "original",
			info: p,
			tag: getTag(p.id) ?? null,
		};
	});
}

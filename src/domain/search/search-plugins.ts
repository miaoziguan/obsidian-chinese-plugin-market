import type { PluginInfo, TranslateResult } from "@domain/catalog/translator";

/** 预热与正式检索共用同一双语条目，避免首搜因字段口径不同重建索引。 */
export function prepareSearchPlugins(
	plugins: Pick<PluginInfo, "id" | "name" | "description" | "downloads" | "updated">[],
	translations: Record<string, TranslateResult> = {},
) {
	return plugins.map((p) => {
		const tr = translations[p.id];
		const translated = tr && tr.source !== "original";
		return {
			id: p.id,
			name: p.name,
			description: p.description,
			nameZh: translated ? tr.translatedName : undefined,
			descZh: translated ? tr.translatedDesc : undefined,
			downloads: p.downloads,
			updated: p.updated,
		};
	});
}

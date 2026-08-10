/**
 * 内置预置收藏（种子）。
 *
 * 随 main.js 编译进包分发，作为「出厂精选」让新用户开箱即可见官方推荐收藏；
 * 只读、永不写入用户 data.json。用户态收藏（settings.favorites）与之并集展示，
 * 用户对预置收藏的取消记录在 settings.excludedSeeded（同样不污染种子）。
 *
 * 与 plugin.ts 的 FALLBACK_RECOMMENDED_IDS 同源（官方推荐 · 羽鳞君），
 * 此处独立内联以避免跨模块静态依赖、保持「收藏种子」单一职责。
 */
export const SEEDED_FAVORITES: string[] = [
	"atomic-notes-extractor",
	"bamboo-immortals",
	"bamboo-walking",
];

/** 预置收藏 Set（O(1) 成员判定） */
export const SEEDED_FAVORITES_SET: Set<string> = new Set(SEEDED_FAVORITES);

/**
 * 计算合并后的收藏集合：内置种子 − 用户排除 + 用户收藏。
 * 任何写操作（toggle/排除变更）后重新水合此集合即可。
 */
export function computeFavoritesSet(
	userFavorites: string[],
	excludedSeeded: string[]
): Set<string> {
	const excluded = new Set(excludedSeeded);
	const set = new Set<string>();
	for (const id of SEEDED_FAVORITES) {
		if (!excluded.has(id)) set.add(id);
	}
	for (const id of userFavorites) set.add(id);
	return set;
}

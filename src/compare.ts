/**
 * 选品对比：功能标签交集/差集计算（纯函数，无副作用，便于单测）。
 * 以「功能标签」为核心维度，对比任意数量（≥2）插件的功能重叠与差异。
 */

export interface CompareTagsResult {
	/** 所有插件共有的标签（N≥2 时为交集；N<2 时为空） */
	common: string[];
	/** 每个插件独有的标签（相对其余所有插件），与入参顺序一一对应 */
	only: string[][];
}

/**
 * 给定 N 个插件各自的功能标签数组，返回：
 * - common：出现在「全部」插件中的标签（交集）。
 * - only[i]：只属于第 i 个插件、其余插件都没有的标签（各自独有）。
 *
 * 约定：标签按精确字符串匹配（同义归一留待后续）；集合内重复标签自动去重。
 * N<2 时交集/差集无意义，返回空结构（仅单个插件时 only[0] 为空数组）。
 */
export function compareTagsMulti(allTags: string[][]): CompareTagsResult {
	const sets = allTags.map((tags) => new Set(tags));

	// 交集：出现在所有集合中的标签
	const common: string[] = [];
	if (sets.length >= 2) {
		for (const tag of sets[0]) {
			if (sets.every((s) => s.has(tag)) && !common.includes(tag)) {
				common.push(tag);
			}
		}
	}

	// 每个插件独有 = 自己有、且其余任一插件都没有
	const only = sets.map((s, idx) => {
		if (sets.length < 2) return []; // 单插件/空：独有无意义
		const others = new Set<string>();
		for (let i = 0; i < sets.length; i++) {
			if (i === idx) continue;
			for (const t of sets[i]) others.add(t);
		}
		return [...s].filter((t) => !others.has(t));
	});

	return { common, only };
}

/** 取一组插件中下载量的最大值（用于指标区条形基准），无数据返回 0 */
export function maxDownloads(plugins: { downloads?: number }[]): number {
	return plugins.reduce((m, p) => Math.max(m, p.downloads ?? 0), 0);
}

/**
 * 命令（commands）交集/差集计算（纯函数，无副作用，便于单测）。
 * 与 compareTagsMulti 同构，但以「实际代码注册的命令名」为维度——
 * 比功能标签更诚实：两个插件标签像但命令不同，说明真实功能差异被标签掩盖。
 */
export function compareCommandsMulti(allCommands: string[][]): CompareTagsResult {
	return compareTagsMulti(allCommands);
}

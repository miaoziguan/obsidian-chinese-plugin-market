/**
 * 插件评测台账（Plugin Journal）——全局统计聚合（P5）。
 *
 * 扫描所有评测笔记后，聚合出「踩坑洞察」面板所需的全局指标：
 * 状态分布（在用/弃用/观望）、弃用率、踩坑 Top（弃用原因聚合）。
 * 纯函数，便于单测；IO 与缓存由插件层负责。
 */
import type { JournalEntry } from "./journal-entry";

export interface JournalStats {
	/** 有主观状态的评测数（using + abandoned + watching）；无 status 的笔记不计入分母 */
	total: number;
	using: number;
	abandoned: number;
	watching: number;
	/** 有评分（1–5）的评测数 */
	ratedCount: number;
	/** 弃用率：abandoned / total（0–1）；total 为 0 时为 0 */
	abandonRate: number;
	/** 踩坑 Top：按弃用原因聚合，降序取前 5（同数按原因名排序） */
	topVerdicts: { reason: string; count: number }[];
	/** 累计安装次数（所有评测笔记的 installCount 之和） */
	installCountSum: number;
}

/** 从评测条目列表聚合全局统计（纯函数） */
export function computeJournalStats(entries: JournalEntry[]): JournalStats {
	let using = 0;
	let abandoned = 0;
	let watching = 0;
	let ratedCount = 0;
	let installCountSum = 0;
	const verdictCount = new Map<string, number>();

	for (const e of entries) {
		if (e.status === "using") using++;
		else if (e.status === "abandoned") abandoned++;
		else if (e.status === "watching") watching++;
		if (typeof e.rating === "number" && e.rating >= 1 && e.rating <= 5) ratedCount++;
		if (typeof e.installCount === "number") installCountSum += e.installCount;
		for (const v of e.verdict ?? []) {
			if (!v) continue;
			verdictCount.set(v, (verdictCount.get(v) ?? 0) + 1);
		}
	}

	const total = using + abandoned + watching;
	const topVerdicts = [...verdictCount.entries()]
		.sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
		.slice(0, 5)
		.map(([reason, count]) => ({ reason, count }));

	return {
		total,
		using,
		abandoned,
		watching,
		ratedCount,
		abandonRate: total > 0 ? abandoned / total : 0,
		topVerdicts,
		installCountSum,
	};
}

/**
 * 从评测条目构建「弃用原因 → 插件 id 集合」索引。
 * 供踩坑 Top 点击联动筛选：点某个原因即筛出所有 verdict 含该原因的插件。
 */
export function buildVerdictIndex(entries: JournalEntry[]): Map<string, Set<string>> {
	const map = new Map<string, Set<string>>();
	for (const e of entries) {
		for (const v of e.verdict ?? []) {
			if (!v) continue;
			let set = map.get(v);
			if (!set) {
				set = new Set();
				map.set(v, set);
			}
			set.add(e.id);
		}
	}
	return map;
}
